// Task 10: the Done check. Pure rules (evaluateMechanical, ticketUpdate,
// doneSummary) plus the flow through done_set / done mark / card actions /
// the focus_board_done_verdict tool on a fake host.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import server from "../server";
import { boardDoneIds, doneSummary, evaluateMechanical, ticketUpdate } from "../lib/jira-done-check";
import { IDLE_JOBS_KEY } from "../lib/jira-idle";
import { DONE_METADATA_KEY } from "../lib/done-metadata";
import type { GhPr, JiraTicket } from "../lib/jira-schema";

const pr = (number: number, state: GhPr["state"], headRef = "pt-1-work"): GhPr => ({
  repo: "o/r", number, state, headRef, title: "t", body: "", checks: "pass", reviewDecision: null, updatedAt: "2026-10-29T00:00:00Z",
});
const ticket = (over: Partial<JiraTicket> = {}): JiraTicket => ({
  key: "PT-1", summary: "s", status: "In Progress", statusCategory: "indeterminate", assignee: null, assignedToMe: true, issueType: "Task", isEpic: false,
  parentKey: null, epicKey: null, openChildren: 0, updatedAt: "2026-10-29T00:00:00Z", url: "https://x/browse/PT-1", ...over,
});

describe("evaluateMechanical", () => {
  const ev = (over: Partial<Parameters<typeof evaluateMechanical>[0]> = {}) => evaluateMechanical({ prs: [], children: [], snapshotStale: false, ...over });
  it("stale or missing PR data: needs-operator, PR status unavailable", () => {
    expect(ev({ snapshotStale: true, prs: [pr(1, "merged")] })).toEqual({ verdict: "needs-operator", reasons: ["PR status unavailable"] });
  });
  it("a PR closed unmerged fails", () => {
    expect(ev({ prs: [pr(1, "merged"), pr(7, "closed")] })).toEqual({ verdict: "fail", reasons: ["PR #7 closed unmerged, confirm it's not needed"] });
  });
  it("an open PR fails", () => {
    expect(ev({ prs: [pr(8, "open")] })).toEqual({ verdict: "fail", reasons: ["PR #8 still open"] });
  });
  it("a child without a ticket fails", () => {
    expect(ev({ prs: [pr(1, "merged")], children: [{ id: "c", title: "Fix the thing", linked: false }, { id: "d", title: "ok", linked: true }] })).toEqual({
      verdict: "fail",
      reasons: ["child thread 'Fix the thing' has no ticket"],
    });
  });
  it("every PR merged passes", () => {
    expect(ev({ prs: [pr(1, "merged"), pr(2, "merged")], children: [{ id: "c", title: "x", linked: true }] })).toEqual({ verdict: "pass", reasons: [] });
  });
  it("no PRs needs the agent", () => {
    expect(ev()).toEqual({ verdict: "needs-agent", reasons: [] });
  });
});

describe("ticketUpdate", () => {
  const base = { ticket: ticket(), linkedThreadsDone: [true], role: "owner" as const, skipped: false, summary: "sum" };
  const ops = (over: Partial<typeof base> = {}) => ticketUpdate({ ...base, ...over }).map((o) => (o.op === "transition" ? `transition ${o.toCategory}` : o.op));
  it("epic: comment only", () => expect(ops({ ticket: ticket({ isEpic: true }) })).toEqual(["comment"]));
  it("watching: comment only", () => expect(ops({ role: "watching" })).toEqual(["comment"]));
  it("skipped: comment only", () => expect(ops({ skipped: true })).toEqual(["comment"]));
  it("open children: comment only", () => expect(ops({ ticket: ticket({ openChildren: 1 }) })).toEqual(["comment"]));
  it("6 of 7 threads Done: comment only; 7 of 7: comment + transition done", () => {
    expect(ops({ linkedThreadsDone: [...Array(6).fill(true), false] })).toEqual(["comment"]);
    expect(ops({ linkedThreadsDone: Array(7).fill(true) })).toEqual(["comment", "transition done"]);
  });
  it("the comment carries the summary", () => {
    expect(ticketUpdate(base)[0]).toMatchObject({ op: "comment", key: "PT-1", body: "sum" });
  });
});

describe("doneSummary", () => {
  it("plain text from title, PR urls and child keys, under 4,000 chars", () => {
    const s = doneSummary({ title: "Ship it", prUrls: ["https://github.com/o/r/pull/1"], childKeys: ["PT-2"], skipped: false });
    expect(s).toContain("Ship it");
    expect(s).toContain("https://github.com/o/r/pull/1");
    expect(s).toContain("PT-2");
    expect(doneSummary({ title: "x".repeat(9000), prUrls: [], childKeys: [], skipped: true }).length).toBeLessThanOrEqual(4000);
  });
});

describe("boardDoneIds", () => {
  const r = (over: object) => ({ links: [], enrolledAt: null, verifying: null, doneCheck: null, nudgedAt: null, deepCheckedAt: null, reason: null, checkInWith: null, ...over });
  const threads = {
    v: r({ verifying: { startedAt: "x" } }),
    p: r({ doneCheck: { at: "x", verdict: "pending-confirm", reasons: [] } }),
    f: r({ doneCheck: { at: "x", verdict: "fail", reasons: ["a"] } }),
  } as never;
  it("holds verifying and pending-confirm cards in Done; failed ones leave", () => {
    expect([...boardDoneIds(new Set(["d"]), true, threads)].sort()).toEqual(["d", "p", "v"]);
  });
  it("off: the stamps alone (same set object)", () => {
    const ids = new Set(["d"]);
    expect(boardDoneIds(ids, false, threads)).toBe(ids);
  });
});

// ---- flow on a fake host ----

const snap = (over: { prs?: GhPr[]; tickets?: JiraTicket[]; takenAt?: string } = {}) => ({
  version: 1, takenAt: over.takenAt ?? new Date().toISOString(), ok: true, error: null, me: { accountId: "a" },
  tickets: over.tickets ?? [ticket()], prs: over.prs ?? [], mentions: [],
});
const rec = (over: object = {}) => ({
  links: [{ key: "PT-1", role: "owner", source: "auto" }], enrolledAt: "2026-10-01T00:00:00Z", verifying: null, doneCheck: null,
  nudgedAt: null, deepCheckedAt: null, reason: null, checkInWith: null, ...over,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Done check flow", () => {
  let harness: FakePluginHarness;
  let bb: ReturnType<typeof createFakePluginHost>["bb"];
  const metadata = new Map<string, Record<string, unknown>>();
  const status = new Map<string, string>();
  const rows = new Map<string, { parentThreadId?: string; title?: string; branch?: string | null }>();
  let send: ReturnType<typeof vi.fn>;

  async function load(opts: { enabled?: boolean; snapshot?: object | null; kv?: Record<string, unknown> } = {}) {
    send = vi.fn(async () => ({}));
    const row = (id: string) => {
      const r = rows.get(id) ?? {};
      return makeThreadResponse({
        id, title: r.title ?? `title ${id}`, parentThreadId: r.parentThreadId ?? null, status: (status.get(id) ?? "idle") as never,
        environmentBranchName: r.branch === undefined ? "pt-1-work" : r.branch,
      } as never);
    };
    const host = createFakePluginHost({
      pluginId: "focus-board",
      settings: { jiraEnabled: opts.enabled ?? true } as never,
      sdk: {
        threads: {
          list: async (args?: { archived?: boolean }) => (args?.archived ? [] : [...rows.keys()].map(row)),
          get: async ({ threadId }: { threadId: string }) => row(threadId),
          send,
          getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {},
          updatePluginMetadata: async ({ threadId, set, remove }: { threadId: string; set?: Record<string, unknown>; remove?: string[] }) => {
            const next = { ...(metadata.get(threadId) ?? {}), ...(set ?? {}) };
            for (const k of remove ?? []) delete next[k];
            metadata.set(threadId, next);
            return next;
          },
        } as never,
      },
    });
    harness = host.harness;
    bb = host.bb;
    await bb.storage.kv.set("jira:enabled-seen", true);
    if (opts.snapshot !== null) await bb.storage.kv.set("jira:snapshot", opts.snapshot ?? snap());
    for (const [k, v] of Object.entries(opts.kv ?? {})) await bb.storage.kv.set(k, v);
    await server(bb);
    await flush();
  }
  const reset = () => {
    metadata.clear();
    status.clear();
    rows.clear();
  };
  afterEach(async () => {
    await harness.lifecycle.dispose();
    reset();
  });
  const jiraOf = (id: string) => metadata.get(id)?.jira as Record<string, any> | undefined;
  const doneOf = (id: string) => metadata.get(id)?.[DONE_METADATA_KEY];
  const ops = async () => ((await bb.storage.kv.get("jira:queue")) as { op: string; key: string; toCategory?: string; body?: string }[] | undefined) ?? [];
  const doneSet = (threadId: string, done = true) => harness.behavior.callRpc("done_set", { threadId, done });
  const card = (kind: string, threadId = "t1", index?: number) =>
    harness.behavior.callRpc("jira_card_action", { kind, threadId, ...(index === undefined ? {} : { index }) }) as Promise<{ ok: boolean; error?: string }>;
  const idle = async (id: string) => {
    status.set(id, "idle");
    await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id }), lastAssistantText: null });
    await flush();
  };
  const verdict = (input: object, threadId = "t1") => harness.callAgentTool("focus_board_done_verdict", input, { threadId, projectId: "p1" }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
  const seed = (id: string, over: object = {}) => {
    rows.set(id, {});
    metadata.set(id, { jira: rec(over) });
  };

  it("a Done drop on an active thread sends nothing and stamps nothing; after thread.idle the check runs", async () => {
    seed("t1");
    status.set("t1", "active");
    await load({ snapshot: snap({ prs: [pr(1, "merged")] }) });
    await doneSet("t1");
    expect(send).not.toHaveBeenCalled();
    expect(doneOf("t1")).toBeUndefined();
    expect(jiraOf("t1")?.verifying).toMatchObject({ startedAt: expect.any(String) });
    expect(await ops()).toEqual([]);
    await idle("t1");
    expect(doneOf("t1")).toMatchObject({ doneAt: expect.any(String) });
    expect(jiraOf("t1")?.verifying).toBeNull();
    expect(jiraOf("t1")?.doneCheck).toMatchObject({ verdict: "pass" });
    expect((await ops()).map((o) => (o.op === "transition" ? `transition ${o.toCategory}` : o.op))).toEqual(["comment", "transition done"]);
    expect((await ops())[0]!.body).toContain("https://github.com/o/r/pull/1");
    expect(send).not.toHaveBeenCalled();
  });

  it("a Done drop while the snapshot is stale: 'PR status unavailable', no stamp, no ops", async () => {
    seed("t1");
    await load({ snapshot: snap({ prs: [pr(1, "merged")], takenAt: "2020-01-01T00:00:00Z" }) });
    await doneSet("t1");
    expect(doneOf("t1")).toBeUndefined();
    expect(jiraOf("t1")).toMatchObject({ verifying: null, reason: "PR status unavailable", doneCheck: { verdict: "fail", reasons: ["PR status unavailable"] } });
    expect(await ops()).toEqual([]);
    expect(harness.inspection.realtimeSignals).toContainEqual({ channel: "done-changed", payload: { threadId: "t1", done: false } });
  });

  it("no snapshot at all: also PR status unavailable", async () => {
    seed("t1");
    await load({ snapshot: null });
    await doneSet("t1");
    expect(jiraOf("t1")?.reason).toBe("PR status unavailable");
    expect(doneOf("t1")).toBeUndefined();
  });

  it("a thread Done before enrollment (skippedDone) never gets a doneCheck", async () => {
    rows.set("t1", {});
    metadata.set("t1", { [DONE_METADATA_KEY]: { doneAt: "2026-09-01T00:00:00.000Z" } });
    await load({ snapshot: snap({ prs: [pr(1, "merged")] }) });
    const plan = (await harness.behavior.callRpc("jira_reconcile_apply", null)) as { skippedDone: string[] };
    expect(plan.skippedDone).toEqual(["t1"]);
    await doneSet("t1");
    expect(jiraOf("t1")?.doneCheck).toBeNull();
    expect(jiraOf("t1")?.verifying).toBeNull();
    expect(await ops()).toEqual([]);
  });

  it("with Jira off, done_set stamps immediately as upstream", async () => {
    seed("t1");
    await load({ enabled: false });
    expect(await doneSet("t1")).toEqual({ done: true });
    expect(doneOf("t1")).toMatchObject({ doneAt: expect.any(String) });
    expect(jiraOf("t1")?.verifying).toBeNull();
    expect(await ops()).toEqual([]);
  });

  it("done=false is upstream with Jira on", async () => {
    seed("t1");
    metadata.get("t1")![DONE_METADATA_KEY] = { doneAt: "2026-09-01T00:00:00.000Z" };
    await load();
    expect(await doneSet("t1", false)).toEqual({ done: false });
    expect(doneOf("t1")).toBeUndefined();
  });

  it("a closed-unmerged PR fails with the reason checklist; Not needed drops it, then Confirm done stamps", async () => {
    seed("t1");
    await load({ snapshot: snap({ prs: [pr(1, "merged"), pr(7, "closed")] }) });
    await doneSet("t1");
    expect(jiraOf("t1")).toMatchObject({ verifying: null, doneCheck: { verdict: "fail", reasons: ["PR #7 closed unmerged, confirm it's not needed"] } });
    expect(doneOf("t1")).toBeUndefined();
    expect(await card("not-needed", "t1", 5)).toEqual({ ok: false, error: "no such reason" });
    expect(await card("not-needed", "t1", 0)).toEqual({ ok: true });
    expect(jiraOf("t1")).toMatchObject({ reason: null, doneCheck: { verdict: "pending-confirm", reasons: [] } });
    expect(await card("confirm-done")).toEqual({ ok: true });
    expect(doneOf("t1")).toMatchObject({ doneAt: expect.any(String) });
    expect((await ops()).map((o) => o.op)).toEqual(["comment", "transition"]);
  });

  it("no PRs: one verify turn; the agent's pass needs Confirm done; a double confirm queues once", async () => {
    seed("t1");
    rows.get("t1")!.branch = null;
    await load();
    await doneSet("t1");
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls[0])).toContain("focus_board_done_verdict");
    expect(jiraOf("t1")?.verifying).not.toBeNull();
    expect(doneOf("t1")).toBeUndefined();
    const configured = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: metadata.get("t1") } as never));
    expect(configured.tools.map((t) => t.name)).toContain("focus_board_done_verdict");
    expect(await card("confirm-done")).toEqual({ ok: false, error: "nothing to confirm" });
    const r = await verdict({ verdict: "pass", remaining: [] });
    expect(r.isError).toBeFalsy();
    expect(jiraOf("t1")).toMatchObject({ verifying: null, doneCheck: { verdict: "pending-confirm" } });
    expect(doneOf("t1")).toBeUndefined();
    // Not verifying any more: the tool is not offered and is rejected.
    const after = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: metadata.get("t1") } as never));
    expect(after.tools.map((t) => t.name)).not.toContain("focus_board_done_verdict");
    expect((await verdict({ verdict: "fail", remaining: ["x"] })).isError).toBe(true);
    expect(jiraOf("t1")?.doneCheck.verdict).toBe("pending-confirm");
    await Promise.all([card("confirm-done"), card("confirm-done")]);
    expect(doneOf("t1")).toMatchObject({ doneAt: expect.any(String) });
    expect((await ops()).map((o) => o.op)).toEqual(["comment", "transition"]);
  });

  it("a busy verify turn waits for idle; a throwing send keeps verifying and re-queues", async () => {
    seed("t1");
    rows.get("t1")!.branch = null;
    await load();
    send.mockRejectedValueOnce(Object.assign(new Error("boom"), { status: 500 }));
    await doneSet("t1");
    expect(jiraOf("t1")?.verifying).not.toBeNull();
    const jobs = (await bb.storage.kv.get(IDLE_JOBS_KEY)) as { threadId: string; kind: string }[];
    expect(jobs).toContainEqual(expect.objectContaining({ threadId: "t1", kind: "verify-turn" }));
    await idle("t1");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("the agent's fail returns reasons, capped (200 chars each, 10 items); Keep working clears", async () => {
    seed("t1");
    rows.get("t1")!.branch = null;
    await load();
    await doneSet("t1");
    await verdict({ verdict: "fail", remaining: ["y".repeat(500), ...Array.from({ length: 20 }, (_, i) => `item ${i}`)] });
    const reasons = jiraOf("t1")?.doneCheck.reasons as string[];
    expect(reasons).toHaveLength(10);
    expect(reasons[0]!.length).toBeLessThanOrEqual(200);
    expect(jiraOf("t1")?.verifying).toBeNull();
    expect(doneOf("t1")).toBeUndefined();
    expect(await card("keep-working")).toEqual({ ok: true });
    expect(jiraOf("t1")).toMatchObject({ verifying: null, reason: null, doneCheck: null });
  });

  it("Spin off sends a turn naming focus_board_spawn_child and drops that reason", async () => {
    seed("t1", { doneCheck: { at: "x", verdict: "fail", reasons: ["write docs", "add test"] }, reason: "write docs; add test" });
    await load();
    expect(await card("spin-off", "t1", 1)).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
    const text = JSON.stringify(send.mock.calls[0]);
    expect(text).toContain("focus_board_spawn_child");
    expect(text).toContain("add test");
    expect(jiraOf("t1")?.doneCheck.reasons).toEqual(["write docs"]);
  });

  it("Mark done anyway: stamps, records skipped, comment only", async () => {
    seed("t1", { doneCheck: { at: "x", verdict: "fail", reasons: ["PR #8 still open"] }, reason: "PR #8 still open" });
    await load();
    expect(await card("skip-done")).toEqual({ ok: true });
    expect(doneOf("t1")).toMatchObject({ doneAt: expect.any(String) });
    expect(jiraOf("t1")).toMatchObject({ verifying: null, reason: null, doneCheck: { skipped: true } });
    expect((await ops()).map((o) => o.op)).toEqual(["comment"]);
    expect(await harness.behavior.callRpc("jira_done_confirm", { threadId: "t1", skip: true })).toEqual({ ok: true });
    expect((await ops()).map((o) => o.op)).toEqual(["comment"]);
  });

  it("transition only when every linked thread is Done", async () => {
    seed("t1");
    seed("t2"); // also linked to PT-1, not Done
    await load({ snapshot: snap({ prs: [pr(1, "merged")] }) });
    await doneSet("t1");
    expect(doneOf("t1")).toMatchObject({ doneAt: expect.any(String) });
    expect((await ops()).map((o) => o.op)).toEqual(["comment"]);
  });

  it("a child thread with no ticket fails the check", async () => {
    seed("t1");
    rows.set("c1", { parentThreadId: "t1", title: "Docs pass" });
    await load({ snapshot: snap({ prs: [pr(1, "merged")] }) });
    await doneSet("t1");
    expect(jiraOf("t1")?.doneCheck.reasons).toEqual(["child thread 'Docs pass' has no ticket"]);
  });

  it("done mark from the CLI routes through the check when on", async () => {
    seed("t1");
    status.set("t1", "active");
    await load({ snapshot: snap({ prs: [pr(1, "merged")] }) });
    const r = await harness.behavior.runCli(["done", "mark", "t1"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("checking t1");
    expect(doneOf("t1")).toBeUndefined();
    expect(jiraOf("t1")?.verifying).not.toBeNull();
  });

  it("on startup, a verifying thread with no queued job is re-queued as done-check and runs", async () => {
    seed("t1", { verifying: { startedAt: "2026-10-29T00:00:00Z" } });
    await load({ snapshot: snap({ prs: [pr(1, "merged")] }) });
    await flush();
    expect(doneOf("t1")).toMatchObject({ doneAt: expect.any(String) });
    expect(jiraOf("t1")?.verifying).toBeNull();
  });

  it("on startup, an active verifying thread waits for idle", async () => {
    seed("t1", { verifying: { startedAt: "2026-10-29T00:00:00Z" } });
    status.set("t1", "active");
    await load({ snapshot: snap({ prs: [pr(1, "merged")] }) });
    await flush();
    const jobs = (await bb.storage.kv.get(IDLE_JOBS_KEY)) as { threadId: string; kind: string }[];
    expect(jobs).toEqual([expect.objectContaining({ threadId: "t1", kind: "done-check" })]);
    expect(doneOf("t1")).toBeUndefined();
  });

  it("the verdict tool is rejected with Jira off", async () => {
    seed("t1", { verifying: { startedAt: "x" } });
    await load({ enabled: false });
    expect((await verdict({ verdict: "pass", remaining: [] })).isError).toBe(true);
    expect(jiraOf("t1")?.doneCheck).toBeNull();
  });
});
