// The built-in sync: the "jira-sync" schedule, single-flight passes, the
// kicks (Refresh, a Done data wait, load, the setting flip), dispose, and
// `bb focus-board jira sync`. registerJira is loaded directly so the fake
// runner goes in through deps.run (no real acli/gh, no executables).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { defineCli } from "@get-bb/plugin-sdk";
import { registerJira } from "../lib/jira-server";
import type { ThreadLink } from "../lib/link-metadata";

const issue = (key: string) => ({
  key,
  fields: { summary: `s ${key}`, status: { name: "In Progress", statusCategory: { key: "indeterminate" } }, assignee: { accountId: "me1", displayName: "Me" }, issuetype: { name: "Task" }, updated: "2026-10-29T00:00:00.000+0000" },
});
const rec = (over: object = {}) => ({ links: [{ key: "PT-1", role: "owner", source: "auto" }], enrolledAt: "2026-10-01T00:00:00Z", verifying: null, doneCheck: null, nudgedAt: null, deepCheckedAt: null, reason: null, checkInWith: null, ...over });
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("built-in Jira sync", () => {
  let harness: FakePluginHarness;
  let host: ReturnType<typeof createFakePluginHost>;
  let jira: ReturnType<typeof registerJira>;
  const metadata = new Map<string, Record<string, unknown>>();
  let links: ThreadLink[] = [];
  let calls: string[] = [];
  let release: (() => void) | null = null;
  let gate: Promise<void> | null = null;
  let acliFails: string | null = null;
  const hold = () => (gate = new Promise((r) => (release = () => { gate = null; r(); })));
  const run = async (tool: "acli" | "gh", args: readonly string[]) => {
    const line = `${tool} ${args.join(" ")}`;
    calls.push(line);
    if (gate) await gate;
    if (tool === "acli" && acliFails) throw new Error(`acli ${args[0]} failed: ${acliFails}`);
    if (line.includes("assignee = currentUser()")) return JSON.stringify([issue("PT-1")]);
    if (line.includes("workitem view")) return JSON.stringify(issue("PT-1"));
    if (line.includes("search")) return "[]";
    return "";
  };
  const searches = () => calls.filter((c) => c.includes("assignee = currentUser()")).length;

  async function load(settings: Record<string, unknown> = { jiraEnabled: true }) {
    metadata.clear();
    calls = [];
    links = [];
    acliFails = null;
    host = createFakePluginHost({
      pluginId: "focus-board",
      settings: settings as never,
      sdk: {
        threads: {
          list: async (args?: { archived?: boolean }) => (args?.archived ? [] : [makeThreadResponse({ id: "t1", status: "idle" } as never)]),
          get: async () => makeThreadResponse({ id: "t1", status: "idle" } as never),
          send: async () => ({}),
          getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {},
          updatePluginMetadata: async ({ threadId, set }: { threadId: string; set?: Record<string, unknown> }) => {
            metadata.set(threadId, { ...(metadata.get(threadId) ?? {}), ...(set ?? {}) });
            return metadata.get(threadId);
          },
        } as never,
      },
    });
    harness = host.harness;
    await host.bb.storage.kv.set("jira:enabled-seen", true); // no reconcile-on-enable noise
    const defined = host.bb.settings.define({
      jiraEnabled: { type: "boolean", label: "on", default: false },
      jiraSync: { type: "boolean", label: "sync", default: true },
    });
    jira = registerJira(host.bb, {
      settings: () => defined.get() as never,
      liveLinks: async () => [{ id: "t1", links }],
      reconThreads: async () => [],
      readLinks: async () => links,
      addLink: async () => {},
      onSettingsChange: (l) => defined.onChange(l),
      run,
    });
    host.bb.onDispose(() => jira.dispose());
    host.bb.cli.register(defineCli({ name: "focus-board", summary: "t", commands: jira.commands }));
    await flush();
  }
  afterEach(async () => {
    release?.();
    release = null;
    await harness.lifecycle.dispose();
    vi.useRealTimers();
  });
  const seen = async () => (await host.bb.storage.kv.get("jira:script-seen-at")) ?? null;
  const state = () => harness.behavior.callRpc("jira_board_state", null) as Promise<any>;

  it("jiraEnabled=false: the schedule, Refresh, load and the CLI run nothing (upstream)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await load({ jiraEnabled: false });
    await vi.advanceTimersByTimeAsync(3_000);
    await harness.runSchedule("jira-sync");
    await harness.behavior.callRpc("jira_refresh", null);
    expect((await harness.behavior.runCli(["jira", "sync"])).exitCode).toBe(1);
    await flush();
    expect(calls).toEqual([]);
    expect(await seen()).toBeNull();
  });

  it("each scheduled pass records when sync last ran, drains the queue and ingests a snapshot", async () => {
    await load();
    await jira.store.enqueue({ op: "assign", key: "PT-1", to: "me", threadId: null });
    await harness.runSchedule("jira-sync");
    expect(await seen()).toEqual(expect.any(Number));
    expect(await jira.store.pendingOps()).toEqual([]);
    expect(calls.some((c) => c.startsWith("acli jira workitem assign --key PT-1"))).toBe(true);
    const { snapshot } = await jira.store.readSnapshot();
    expect(snapshot?.tickets.map((t) => t.key)).toEqual(["PT-1"]);
    expect((await state()).syncEnabled).toBe(true);
  });

  it("a fresh snapshot is not refetched: the next pass only drains", async () => {
    await load();
    await harness.runSchedule("jira-sync");
    await harness.runSchedule("jira-sync");
    expect(searches()).toBe(1);
  });

  it("jiraSync=false: the schedule runs nothing; the board says sync is off; `jira sync` still runs by hand", async () => {
    await load({ jiraEnabled: true, jiraSync: false });
    await harness.runSchedule("jira-sync");
    expect(calls).toEqual([]);
    expect(await seen()).toBeNull();
    expect((await state()).syncEnabled).toBe(false);
    const r = await harness.behavior.runCli(["jira", "sync"]);
    expect(r.exitCode).toBe(0);
    expect(searches()).toBe(1);
  });

  it("single-flight: a second pass while one runs joins it", async () => {
    await load();
    hold();
    const a = harness.runSchedule("jira-sync");
    await flush();
    const b = harness.runSchedule("jira-sync");
    await flush();
    release!();
    await Promise.all([a, b]);
    expect(searches()).toBe(1);
    expect(calls.filter((c) => c.includes("workitem view"))).toHaveLength(1);
  });

  it("Refresh kicks a pass at once without waiting for it", async () => {
    await load();
    await harness.runSchedule("jira-sync"); // fresh data: a plain pass would not fetch
    await new Promise((r) => setTimeout(r, 5)); // the request must be newer than that snapshot
    hold();
    expect(await harness.behavior.callRpc("jira_refresh", null)).toEqual({ ok: true });
    await flush();
    expect(searches()).toBe(2); // the kicked pass is a full sync, still running
    release!();
    await flush();
    expect((await state()).refreshRequestedAt).toBeNull();
  });

  it("a Done check waiting on PR data kicks a pass", async () => {
    await load();
    await harness.runSchedule("jira-sync");
    links = [{ tracker: "github", repo: "o/r", issue: 9, kind: "pull", href: "https://github.com/o/r/pull/9", createdAt: "2026-10-29T00:00:00Z", source: "operator" } as ThreadLink];
    metadata.set("t1", { jira: rec() });
    calls = [];
    await jira.startDoneCheck("t1");
    await flush();
    expect(calls.some((c) => c === "gh pr view 9 -R o/r --json state,mergedAt,headRefName,title,body,statusCheckRollup,reviewDecision,updatedAt")).toBe(true);
  });

  it("load runs one pass about 2 s later; disposing first runs none", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await load();
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_100);
    await flush();
    expect(searches()).toBe(1);
    await harness.lifecycle.dispose();
    await load();
    await harness.lifecycle.dispose();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toEqual([]);
    await load(); // afterEach disposes this one
  });

  it("turning jiraSync on runs a pass soon after", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await load({ jiraEnabled: true, jiraSync: false });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toEqual([]);
    await harness.behavior.setSettings({ jiraSync: true });
    await flush();
    await vi.advanceTimersByTimeAsync(2_100);
    await flush();
    expect(searches()).toBe(1);
  });

  it("a pass in flight at dispose finishes without writing or crashing", async () => {
    await load();
    await jira.store.enqueue({ op: "assign", key: "PT-1", to: "me", threadId: null });
    await jira.store.enqueue({ op: "assign", key: "PT-2", to: "me", threadId: null });
    const ack = vi.spyOn(jira.store, "ack");
    const ingest = vi.spyOn(jira.store, "ingestSnapshot");
    hold();
    const p = harness.runSchedule("jira-sync");
    await flush();
    await harness.lifecycle.dispose();
    release!();
    await expect(p).resolves.toBeUndefined();
    expect(ack).not.toHaveBeenCalled(); // the applied op stays queued; its [fb:] marker makes the replay safe
    expect(ingest).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.includes("assign"))).toHaveLength(1); // nothing ran after dispose
    await load(); // afterEach disposes this one
  });

  it("`jira sync` runs a full pass now and prints the status; acli failing exits 1 with the error", async () => {
    await load();
    await harness.runSchedule("jira-sync");
    const ok = await harness.behavior.runCli(["jira", "sync"]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toMatch(/^snapshot: ok, age \d+s/);
    expect(searches()).toBe(2); // forced full, though the data was fresh
    acliFails = "unauthorized: please login";
    const bad = await harness.behavior.runCli(["jira", "sync"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("unauthorized: please login");
    expect(bad.stdout).toContain("snapshot: ok");
  });
});
