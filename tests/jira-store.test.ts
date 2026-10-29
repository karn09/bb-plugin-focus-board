import { describe, expect, it } from "vitest";
import { createJiraStore } from "../lib/jira-store";
import type { JiraSnapshot } from "../lib/jira-schema";

const MIN = 60_000;
const T0 = Date.parse("2026-10-29T12:00:00Z");

function setup(opts?: { refreshMinutes?: () => number | Promise<number> }, failSetAfter = Infinity) {
  const kv = new Map<string, unknown>();
  let sets = 0;
  const meta = new Map<string, Record<string, unknown>>();
  let t = T0;
  const store = createJiraStore(
    {
      get: async (k: string) => kv.get(k),
      set: async (k: string, v: unknown) => {
        if (++sets > failSetAfter) throw new Error("boom");
        kv.set(k, v);
      },
    },
    {
      getPluginMetadata: async ({ threadId }) => meta.get(threadId) ?? {},
      updatePluginMetadata: async ({ threadId, set }) => {
        meta.set(threadId, { ...(meta.get(threadId) ?? {}), ...(set ?? {}) });
      },
    },
    () => t,
    opts,
  );
  return { store, kv, meta, advance: (ms: number) => void (t += ms) };
}

const snap = (over: Partial<JiraSnapshot> = {}): JiraSnapshot => ({
  version: 1,
  takenAt: new Date(T0).toISOString(),
  ok: true,
  error: null,
  me: { accountId: "a" },
  tickets: [],
  prs: [],
  mentions: [],
  ...over,
});
const comment = (key: string) => ({ op: "comment" as const, key, body: "x", threadId: null });

describe("snapshot", () => {
  it("fresh at +3min, stale at +5min", async () => {
    const { store, advance } = setup({ refreshMinutes: () => 2 });
    expect(await store.ingestSnapshot(snap())).toEqual({ ok: true });
    advance(3 * MIN);
    expect((await store.readSnapshot()).stale).toBe(false);
    advance(2 * MIN);
    const r = await store.readSnapshot();
    expect(r.stale).toBe(true);
    expect(r.ageMs).toBe(5 * MIN);
  });
  it("async refreshMinutes: 10 keeps a 5-min snapshot fresh, 2 makes it stale", async () => {
    for (const [m, stale] of [[10, false], [2, true]] as const) {
      const { store, advance } = setup({ refreshMinutes: async () => m });
      await store.ingestSnapshot(snap());
      advance(5 * MIN);
      expect((await store.readSnapshot()).stale).toBe(stale);
    }
  });
  it("surfaces a failure even with no prior good snapshot", async () => {
    const { store } = setup();
    await store.ingestSnapshot({ ok: false, error: "acli signed out" });
    expect(await store.readSnapshot()).toMatchObject({ snapshot: null, stale: true, error: "acli signed out" });
  });
  it("defaults refresh to 2 and is stale with no snapshot", async () => {
    const { store, advance } = setup();
    expect(await store.readSnapshot()).toEqual({ snapshot: null, ageMs: null, stale: true, error: null });
    await store.ingestSnapshot(snap());
    advance(4 * MIN + 1);
    expect((await store.readSnapshot()).stale).toBe(true);
  });
  it("failed snapshot is stale but keeps the prior good one", async () => {
    const { store, advance } = setup();
    await store.ingestSnapshot(snap());
    advance(MIN);
    const res = await store.ingestSnapshot({ ok: false, error: "acli: not authenticated" });
    expect(res).toEqual({ ok: true });
    const r = await store.readSnapshot();
    expect(r.stale).toBe(true);
    expect(r.snapshot?.ok).toBe(true);
    expect(r.ageMs).toBe(MIN);
  });
  it("rejects invalid input", async () => {
    const { store } = setup();
    const res = await store.ingestSnapshot({ nope: 1 });
    expect(res.ok).toBe(false);
  });
});

describe("queue", () => {
  it("oldest first, ack removes, unknown ack is a no-op, pending read doesn't pop", async () => {
    const { store } = setup();
    const a = await store.enqueue(comment("PT-1"));
    const b = await store.enqueue(comment("PT-2"));
    expect((await store.pendingOps()).map((o) => o.id)).toEqual([a.id, b.id]);
    expect((await store.pendingOps()).length).toBe(2);
    await store.ack([{ id: a.id, ok: true, error: null, createdKey: null }]);
    expect((await store.pendingOps()).map((o) => o.id)).toEqual([b.id]);
    await store.ack([{ id: "nope", ok: true, error: null, createdKey: null }]);
    expect((await store.pendingOps()).map((o) => o.id)).toEqual([b.id]);
    expect((await store.lastResult(a.id))?.ok).toBe(true);
    expect(await store.lastResult("zzz")).toBeNull();
  });
  it("keeps the last 200 results", async () => {
    const { store } = setup();
    const ops = [];
    for (let i = 0; i < 205; i++) ops.push(await store.enqueue(comment("PT-1")));
    await store.ack(ops.map((o) => ({ id: o.id, ok: true, error: null, createdKey: null })));
    expect(await store.lastResult(ops[0]!.id)).toBeNull();
    expect(await store.lastResult(ops[4]!.id)).toBeNull();
    expect(await store.lastResult(ops[5]!.id)).not.toBeNull();
    expect(await store.lastResult(ops[204]!.id)).not.toBeNull();
  });
  it("concurrent enqueues both land", async () => {
    const { store } = setup();
    await Promise.all([store.enqueue(comment("PT-1")), store.enqueue(comment("PT-2"))]);
    expect((await store.pendingOps()).length).toBe(2);
  });
});

describe("ack hardening", () => {
  const res = (id: string) => ({ id, ok: true, error: null, createdKey: null });
  it("duplicate id in a batch records one result", async () => {
    const { store, kv } = setup();
    const a = await store.enqueue(comment("PT-1"));
    await store.ack([res(a.id), res(a.id)]);
    expect((kv.get("jira:results") as unknown[]).length).toBe(1);
  });
  it("results persist before queue removal", async () => {
    // sets: 1 enqueue, 2 results, 3 queue (fails)
    const { store, kv } = setup(undefined, 2);
    const a = await store.enqueue(comment("PT-1"));
    await expect(store.ack([res(a.id)])).rejects.toThrow("boom");
    expect((await store.pendingOps()).map((o) => o.id)).toEqual([a.id]);
    expect((await store.lastResult(a.id))?.ok).toBe(true);
    expect(kv.has("jira:results")).toBe(true);
  });
  it("invalid raw queue entries survive enqueue+ack and are logged", async () => {
    const { store, kv } = setup();
    kv.set("jira:queue", [{ junk: true }]);
    const a = await store.enqueue(comment("PT-1"));
    await store.ack([res(a.id)]);
    expect(kv.get("jira:queue")).toEqual([{ junk: true }]);
    expect(await store.pendingOps()).toEqual([]);
  });
  it("logs skipped invalid entries", async () => {
    const msgs: string[] = [];
    const kv = new Map<string, unknown>([["jira:queue", [{ junk: 1 }]]]);
    const s = createJiraStore(
      { get: async (k) => kv.get(k), set: async (k, v) => void kv.set(k, v) },
      { getPluginMetadata: async () => ({}), updatePluginMetadata: async () => {} },
      () => T0,
      { log: (m) => msgs.push(m) },
    );
    await s.pendingOps();
    expect(msgs.length).toBe(1);
  });
});

describe("thread record", () => {
  it("absent or invalid gives the empty record", async () => {
    const { store, meta } = setup();
    const empty = {
      links: [], enrolledAt: null, verifying: null, doneCheck: null,
      nudgedAt: null, deepCheckedAt: null, reason: null, checkInWith: null,
    };
    expect(await store.readThread("t1")).toEqual(empty);
    meta.set("t1", { jira: { links: "garbage" } });
    expect(await store.readThread("t1")).toEqual(empty);
  });
  it("merges patches and dedupes links by key", async () => {
    const { store } = setup();
    await store.writeThread("t1", { links: [{ key: "PT-1", role: "owner", source: "auto" }] });
    const r = await store.writeThread("t1", {
      reason: "r",
      links: [
        { key: "PT-1", role: "watching", source: "operator" },
        { key: "PT-2", role: "watching", source: "auto" },
      ],
    });
    expect(r.reason).toBe("r");
    expect(r.links.map((l) => l.key)).toEqual(["PT-1", "PT-2"]);
    expect(r.links[0]?.role).toBe("watching");
    expect(await store.readThread("t1")).toEqual(r);
  });
  it("updateThread computes the patch from the current record inside the lock", async () => {
    const { store } = setup();
    // Two concurrent first-writer-wins updates: the second sees the first's value.
    const stamp = (at: string) => store.updateThread("t1", (cur) => ({ enrolledAt: cur.enrolledAt ?? at }));
    await Promise.all([stamp("2026-10-29T00:00:00Z"), stamp("2026-10-30T00:00:00Z")]);
    expect((await store.readThread("t1")).enrolledAt).toBe("2026-10-29T00:00:00Z");
  });
  it("undefined keeps, null clears", async () => {
    const { store } = setup();
    await store.writeThread("t1", { reason: "keep" });
    expect((await store.writeThread("t1", { reason: undefined })).reason).toBe("keep");
    expect((await store.writeThread("t1", { reason: null })).reason).toBeNull();
  });
});
