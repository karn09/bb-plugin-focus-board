import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createIdleWaiters, sendIfIdle, IDLE_JOBS_KEY } from "../lib/jira-idle";

type Row = { status: string; archivedAt: number | null } | null;
function fakeSdk(...rows: (Row | Error)[]) {
  const send = vi.fn(async () => ({}));
  let i = 0;
  const get = vi.fn(async () => {
    const r = rows[Math.min(i++, rows.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  });
  return { get, send };
}
const idle: Row = { status: "idle", archivedAt: null };
const active: Row = { status: "active", archivedAt: null };

function memKv() {
  const m = new Map<string, unknown>();
  return { m, get: async (k: string) => m.get(k), set: async (k: string, v: unknown) => void m.set(k, structuredClone(v)) };
}

describe("sendIfIdle", () => {
  it("returns busy and never sends to an active thread", async () => {
    const sdk = fakeSdk(active);
    expect(await sendIfIdle(sdk, "t1", "hi")).toBe("busy");
    expect(sdk.send).not.toHaveBeenCalled();
  });

  it("sends to an idle thread with the real threads.send shape", async () => {
    const sdk = fakeSdk(idle);
    expect(await sendIfIdle(sdk, "t1", "hi")).toBe("sent");
    expect(sdk.get).toHaveBeenCalledWith({ threadId: "t1" });
    expect(sdk.send).toHaveBeenCalledWith({ threadId: "t1", mode: "auto", input: [{ type: "text", text: "hi" }] });
  });

  it("re-reads status before every send (idle, then active)", async () => {
    const sdk = fakeSdk(idle, active);
    expect(await sendIfIdle(sdk, "t1", "a")).toBe("sent");
    expect(await sendIfIdle(sdk, "t1", "b")).toBe("busy");
    expect(sdk.get).toHaveBeenCalledTimes(2);
    expect(sdk.send).toHaveBeenCalledTimes(1);
  });

  it("treats other non-idle statuses (starting, stopping, pending) as busy", async () => {
    for (const status of ["starting", "stopping", "pending"]) {
      const sdk = fakeSdk({ status, archivedAt: null });
      expect(await sendIfIdle(sdk, "t1", "x")).toBe("busy");
      expect(sdk.send).not.toHaveBeenCalled();
    }
  });

  it("returns gone for an archived, missing or unreadable thread", async () => {
    for (const row of [{ status: "idle", archivedAt: 123 }, null, new Error("404")]) {
      const sdk = fakeSdk(row);
      expect(await sendIfIdle(sdk, "t1", "x")).toBe("gone");
      expect(sdk.send).not.toHaveBeenCalled();
    }
  });
});

describe("createIdleWaiters", () => {
  it("waitFor while busy, then onIdle: the job runs exactly once and is removed", async () => {
    const kv = memKv();
    const h = vi.fn(async () => {});
    const w = createIdleWaiters(kv, { "done-check": h }, { threads: fakeSdk(active) });
    await w.waitFor("t1", "done-check", { a: 1 });
    expect(h).not.toHaveBeenCalled();
    expect(kv.m.get(IDLE_JOBS_KEY)).toHaveLength(1);
    await w.onIdle("t1");
    await w.onIdle("t1");
    expect(h).toHaveBeenCalledTimes(1);
    expect(h).toHaveBeenCalledWith("t1", { a: 1 });
    expect(kv.m.get(IDLE_JOBS_KEY)).toEqual([]);
  });

  it("latest waitFor per (thread, kind) replaces the earlier; other kinds and threads are kept", async () => {
    const kv = memKv();
    const done = vi.fn(async () => {});
    const nudge = vi.fn(async () => {});
    const w = createIdleWaiters(kv, { "done-check": done, "nudge-turn": nudge }, { threads: fakeSdk(active) });
    await w.waitFor("t1", "done-check", "first");
    await w.waitFor("t1", "done-check", "second");
    await w.waitFor("t1", "nudge-turn", "n");
    await w.waitFor("t2", "done-check", "other");
    await w.onIdle("t1");
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith("t1", "second");
    expect(nudge).toHaveBeenCalledWith("t1", "n");
    expect((kv.m.get(IDLE_JOBS_KEY) as { threadId: string }[]).map((j) => j.threadId)).toEqual(["t2"]);
  });

  it("a throwing handler is logged and removed (no retry)", async () => {
    const kv = memKv();
    const log = vi.fn();
    const h = vi.fn(async () => {
      throw new Error("boom");
    });
    const w = createIdleWaiters(kv, { "find-ticket": h }, { threads: fakeSdk(active), log });
    await w.waitFor("t1", "find-ticket");
    await w.onIdle("t1");
    await w.onIdle("t1");
    expect(h).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(kv.m.get(IDLE_JOBS_KEY)).toEqual([]);
  });

  it("a job with no registered handler stays queued until one is registered", async () => {
    const kv = memKv();
    const w = createIdleWaiters(kv, {}, { threads: fakeSdk(active) });
    await w.waitFor("t1", "promote-epic", 7);
    await w.onIdle("t1");
    expect(kv.m.get(IDLE_JOBS_KEY)).toHaveLength(1);
    const h = vi.fn(async () => {});
    w.register("promote-epic", h);
    await w.onIdle("t1");
    expect(h).toHaveBeenCalledWith("t1", 7);
    expect(kv.m.get(IDLE_JOBS_KEY)).toEqual([]);
  });

  it("a handler may re-queue its own kind from inside onIdle without deadlock", async () => {
    const kv = memKv();
    let w!: ReturnType<typeof createIdleWaiters>;
    const h = vi.fn(async (id: string) => w.waitFor(id, "verify-turn", "again"));
    w = createIdleWaiters(kv, { "verify-turn": h }, { threads: fakeSdk(active) });
    await w.waitFor("t1", "verify-turn", "once");
    await w.onIdle("t1");
    expect(h).toHaveBeenCalledTimes(1);
    expect(kv.m.get(IDLE_JOBS_KEY)).toEqual([expect.objectContaining({ threadId: "t1", kind: "verify-turn", payload: "again" })]);
  });

  it("waitFor on a thread that is already idle runs the job (no missed idle event)", async () => {
    const kv = memKv();
    const h = vi.fn(async () => {});
    const w = createIdleWaiters(kv, { "nudge-turn": h }, { threads: fakeSdk(idle) });
    await w.waitFor("t1", "nudge-turn");
    expect(h).toHaveBeenCalledTimes(1);
    expect(kv.m.get(IDLE_JOBS_KEY)).toEqual([]);
  });

  it("resume after a restart: idle threads run, busy wait, gone threads are dropped", async () => {
    const kv = memKv();
    const queuedAt = "2026-10-29T00:00:00.000Z";
    kv.m.set(IDLE_JOBS_KEY, [
      { threadId: "idle", kind: "done-check", payload: 1, queuedAt },
      { threadId: "busy", kind: "done-check", payload: 2, queuedAt },
      { threadId: "gone", kind: "done-check", payload: 3, queuedAt },
    ]);
    const rows: Record<string, Row> = { idle, busy: active, gone: { status: "idle", archivedAt: 1 } };
    const threads = { get: async ({ threadId }: { threadId: string }) => rows[threadId] ?? null, send: vi.fn() };
    const h = vi.fn(async () => {});
    const w = createIdleWaiters(kv, { "done-check": h }, { threads });
    await w.resume();
    expect(h).toHaveBeenCalledTimes(1);
    expect(h).toHaveBeenCalledWith("idle", 1);
    expect(kv.m.get(IDLE_JOBS_KEY)).toEqual([{ threadId: "busy", kind: "done-check", payload: 2, queuedAt }]);
    await w.onIdle("busy");
    expect(h).toHaveBeenCalledWith("busy", 2);
  });

  it("ignores a corrupt KV value", async () => {
    const kv = memKv();
    kv.m.set(IDLE_JOBS_KEY, "junk");
    const w = createIdleWaiters(kv, {}, { threads: fakeSdk(idle) });
    await expect(w.resume()).resolves.toBeUndefined();
    await expect(w.onIdle("t1")).resolves.toBeUndefined();
  });

  it("drops only the malformed entries of a partly corrupt queue", async () => {
    const kv = memKv();
    const good = { threadId: "t1", kind: "done-check", payload: 1, queuedAt: "2026-10-29T00:00:00.000Z" };
    kv.m.set(IDLE_JOBS_KEY, [{ threadId: 5 }, good, { ...good, kind: "nope" }]);
    const h = vi.fn(async () => {});
    const w = createIdleWaiters(kv, { "done-check": h }, { threads: fakeSdk(idle) });
    await w.onIdle("t1");
    expect(h).toHaveBeenCalledWith("t1", 1);
  });
});

// The only door: every thread send for the Jira feature goes through
// lib/jira-idle.ts sendIfIdle. In jira files any `.send(` outside jira-idle
// fails (catches an aliased `threads` object too). server.ts has no
// threads.send from upstream, so it is covered as well, by the narrower
// threads/queuedMessages pattern (an unrelated `.send(` there stays legal).
describe("only door to a thread", () => {
  it("no threads.send outside lib/jira-idle.ts", () => {
    const jiraFiles = readdirSync("lib").filter((f) => /^jira-.*\.ts$/.test(f) && f !== "jira-idle.ts");
    expect(jiraFiles).toContain("jira-server.ts");
    const offenders: string[] = [];
    for (const f of jiraFiles) {
      readFileSync(`lib/${f}`, "utf8").split("\n").forEach((line, i) => {
        if (/\.\s*send\s*\(|threads\s*\.\s*send\b/.test(line)) offenders.push(`lib/${f}:${i + 1}: ${line.trim()}`);
      });
    }
    readFileSync("server.ts", "utf8").split("\n").forEach((line, i) => {
      if (/(threads|queuedMessages)\s*\.\s*send\b/.test(line)) offenders.push(`server.ts:${i + 1}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });
});

describe("registerJira wiring", () => {
  it("thread.idle reaches onIdle; resume runs persisted jobs on start; no send when nothing is registered", async () => {
    const { createFakePluginHost, makeThreadResponse } = await import("@get-bb/plugin-sdk/testing");
    const { registerJira } = await import("../lib/jira-server");
    const send = vi.fn(async () => ({}));
    const rows: Record<string, ReturnType<typeof makeThreadResponse>> = {
      t1: makeThreadResponse({ id: "t1", status: "active" }),
      t2: makeThreadResponse({ id: "t2", status: "idle" }),
    };
    const host = createFakePluginHost({
      pluginId: "focus-board",
      sdk: { threads: { get: async ({ threadId }: { threadId: string }) => rows[threadId], send } },
    });
    const queuedAt = "2026-10-29T00:00:00.000Z";
    await host.bb.storage.kv.set(IDLE_JOBS_KEY, [
      { threadId: "t1", kind: "done-check", payload: "a", queuedAt },
      { threadId: "t2", kind: "done-check", payload: "b", queuedAt },
    ]);
    const jira = registerJira(host.bb, {
      settings: async () => ({}),
      liveLinks: async () => [],
      reconThreads: async () => [],
      readLinks: async () => [],
      addLink: async () => {},
    });
    const h = vi.fn(async () => {});
    jira.idle.register("done-check", h);
    await jira.idle.resume();
    expect(h).toHaveBeenCalledWith("t2", "b");
    expect(h).not.toHaveBeenCalledWith("t1", "a");
    const { errors } = await host.harness.emitThreadEvent("thread.idle", { thread: rows.t1, lastAssistantText: null });
    expect(errors).toEqual([]);
    await vi.waitFor(() => expect(h).toHaveBeenCalledWith("t1", "a"));
    expect(h).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
    await host.harness.lifecycle.dispose();
  });
});
