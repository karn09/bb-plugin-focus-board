// One-time startup migrations in lib/jira-server.ts registerJira.
// jira:migrated-pr-unavailable: failed Done checks whose only reason is the
// old "PR status unavailable" (written before finished PRs stopped bouncing a
// Done drop) are cleared once, while Jira is on.
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { registerJira } from "../lib/jira-server";

const MARKER = "jira:migrated-pr-unavailable";
const rec = (over: object = {}) => ({
  links: [{ key: "PT-1", role: "owner", source: "auto" }], enrolledAt: "2026-10-01T00:00:00Z", verifying: null,
  doneCheck: null, nudgedAt: null, deepCheckedAt: null, reason: null, checkInWith: null, ...over,
});
const fail = (reasons: string[]) => rec({ doneCheck: { at: "2026-11-01T00:00:00Z", verdict: "fail", reasons }, reason: reasons.join("; ") });
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("startup migration: old PR-status-unavailable failures", () => {
  let harness: FakePluginHarness | null = null;
  afterEach(async () => {
    await harness?.lifecycle.dispose();
    harness = null;
  });

  async function start(records: Record<string, object>, { enabled = true, marked = false } = {}) {
    const metadata = new Map<string, Record<string, unknown>>(Object.entries(records).map(([id, r]) => [id, { jira: r }]));
    const writes: string[] = [];
    const host = createFakePluginHost({
      pluginId: "focus-board",
      settings: { jiraEnabled: enabled, jiraSync: false } as never,
      sdk: {
        threads: {
          list: async () => [...metadata.keys()].map((id) => makeThreadResponse({ id, status: "idle" } as never)),
          get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle" } as never),
          send: async () => ({}),
          getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {},
          updatePluginMetadata: async ({ threadId, set }: { threadId: string; set?: Record<string, unknown> }) => {
            writes.push(threadId);
            metadata.set(threadId, { ...(metadata.get(threadId) ?? {}), ...(set ?? {}) });
            return metadata.get(threadId);
          },
        } as never,
      },
    });
    harness = host.harness;
    await host.bb.storage.kv.set("jira:enabled-seen", true);
    if (marked) await host.bb.storage.kv.set(MARKER, true);
    const defined = host.bb.settings.define({
      jiraEnabled: { type: "boolean", label: "on", default: false },
      jiraSync: { type: "boolean", label: "sync", default: true },
    });
    const jira = registerJira(host.bb, {
      settings: () => defined.get() as never,
      liveLinks: async () => [...metadata.keys()].map((id) => ({ id, links: [] })),
      reconThreads: async () => [],
      readLinks: async () => [],
      addLink: async () => {},
      run: () => new Promise(() => {}),
    });
    host.bb.onDispose(() => jira.dispose());
    const published: string[] = [];
    const realPublish = host.bb.realtime.publish.bind(host.bb.realtime);
    host.bb.realtime.publish = ((topic: string, payload: unknown) => {
      published.push(topic);
      return realPublish(topic as never, payload as never);
    }) as never;
    await flush();
    return { published, record: (id: string) => metadata.get(id)?.jira, writes, marker: () => host.bb.storage.kv.get(MARKER) };
  }

  it("clears exactly the single-reason PR status unavailable fails, nothing else, and marks the run", async () => {
    const other = fail(["PR #7 still open"]);
    const two = fail(["PR status unavailable", "PR #7 still open"]);
    const s = await start({ a: fail(["PR status unavailable"]), b: other, c: two, d: rec() });
    expect(s.record("a")).toEqual({ ...fail(["PR status unavailable"]), doneCheck: null, reason: null });
    expect(s.record("b")).toEqual(other);
    expect(s.record("c")).toEqual(two);
    expect(s.writes).toEqual(["a"]);
    expect(await s.marker()).toBe(true);
    expect(s.published).toContain("jira-changed");
  });

  it("nothing to clear: no jira-changed publish", async () => {
    const s = await start({ b: fail(["PR #7 still open"]) });
    expect(s.published).not.toContain("jira-changed");
    expect(await s.marker()).toBe(true);
  });

  it("a second start does nothing", async () => {
    const s = await start({ a: fail(["PR status unavailable"]) }, { marked: true });
    expect(s.record("a")).toEqual(fail(["PR status unavailable"]));
    expect(s.writes).toEqual([]);
  });

  it("Jira off: no migration and no marker (it runs on a later start with Jira on)", async () => {
    const s = await start({ a: fail(["PR status unavailable"]) }, { enabled: false });
    expect(s.record("a")).toEqual(fail(["PR status unavailable"]));
    expect(s.writes).toEqual([]);
    expect(await s.marker()).toBeUndefined();
  });
});
