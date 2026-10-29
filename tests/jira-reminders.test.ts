// Task 11: reminders. Pure planning (quietSince, planReminders,
// deepCheckFindings, replyLine) plus the scheduler pass, the nudge reply
// capture and the reason clearing on a fake host; the idle sweep and the
// Needs-you lane while Jira is on.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import server from "../server";
import { deepCheckFindings, NUDGE_TEXT, planReminders, quietSince, replyLine, type ReminderThread } from "../lib/jira-reminders";
import { IDLE_JOBS_KEY } from "../lib/jira-idle";
import { DONE_METADATA_KEY } from "../lib/done-metadata";
import { sweepCandidatesForIdleColumn } from "../lib/sweep";
import { buildColumns, threadState, withNeedsYou } from "../components/grouping";
import { assembleBoard } from "../components/nesting";
import type { GhPr, JiraTicket } from "../lib/jira-schema";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-29T12:00:00Z");

const rt = (id: string, over: Partial<ReminderThread> = {}): ReminderThread => ({
  id, archived: false, done: false, snoozed: false, status: "idle", verifying: false,
  lastActivityAt: NOW - 10 * DAY, enrolledAt: NOW - 10 * DAY, nudgedAt: null, deepCheckedAt: null, snoozeWokeAt: null, linkedChangeAt: null,
  ...over,
});
const plan = (threads: ReminderThread[], now = NOW, cap = 3) => planReminders({ threads, now, nudgeDays: 2, deepCheckDays: 5, cap });

describe("quietSince", () => {
  it("is the latest of the non-null stamps", () => {
    expect(quietSince({ lastActivityAt: 5, enrolledAt: 9, nudgedAt: null, deepCheckedAt: 7, snoozeWokeAt: null, linkedChangeAt: 3 })).toBe(9);
  });
});

describe("planReminders", () => {
  it("enrollment grace: last activity 30 days ago, enrolled today → no nudge; enrolled + 2 days → nudge", () => {
    const t = rt("a", { lastActivityAt: NOW - 30 * DAY, enrolledAt: NOW });
    expect(plan([t]).nudge).toEqual([]);
    expect(plan([t], NOW + 2 * DAY).nudge).toEqual(["a"]);
  });

  it("10 eligible with cap 3: the 3 oldest, carried 7; the next pass takes the next 3", () => {
    const threads = Array.from({ length: 10 }, (_, i) => rt(`t${i}`, { lastActivityAt: NOW - (3 * DAY + i * 60_000), enrolledAt: NOW - 30 * DAY }));
    const first = plan(threads, NOW);
    expect(first).toMatchObject({ nudge: ["t9", "t8", "t7"], carried: 7 });
    const after = threads.map((t) => (first.nudge.includes(t.id) ? { ...t, nudgedAt: NOW } : t));
    expect(plan(after, NOW + 5 * 60_000)).toMatchObject({ nudge: ["t6", "t5", "t4"], carried: 4 });
  });

  it("an active thread is never nudged; snoozed is excluded until it wakes, and the clock restarts at the wake", () => {
    expect(plan([rt("a", { status: "active" })]).nudge).toEqual([]);
    expect(plan([rt("a", { snoozed: true })]).nudge).toEqual([]);
    const woke = rt("a", { snoozeWokeAt: NOW - DAY });
    expect(plan([woke]).nudge).toEqual([]);
    expect(plan([woke], NOW + DAY).nudge).toEqual(["a"]);
  });

  it("a never-enrolled thread is not eligible yet (the pass enrolls it)", () => {
    expect(plan([rt("a", { enrolledAt: null, lastActivityAt: NOW - 30 * DAY })])).toEqual({ nudge: [], deepCheck: [], carried: 0 });
  });

  it("never touches archived, Done or verifying threads", () => {
    expect(plan([rt("a", { archived: true }), rt("b", { done: true }), rt("c", { verifying: true })])).toEqual({ nudge: [], deepCheck: [], carried: 0 });
  });

  it("day 5: in deepCheck and not re-nudged; deep-checked once per quiet stretch", () => {
    const start = NOW - 5 * DAY;
    const t = rt("a", { lastActivityAt: start, enrolledAt: start - DAY, nudgedAt: start + 2 * DAY });
    expect(plan([t])).toEqual({ nudge: [], deepCheck: ["a"], carried: 0 });
    expect(plan([{ ...t, deepCheckedAt: NOW }], NOW + DAY)).toEqual({ nudge: [], deepCheck: [], carried: 0 });
    // New activity starts a new stretch: nudged again 2 days later.
    expect(plan([{ ...t, deepCheckedAt: NOW, lastActivityAt: NOW + DAY }], NOW + 3 * DAY).nudge).toEqual(["a"]);
  });
});

const pr = (number: number, over: Partial<GhPr> = {}): GhPr => ({
  repo: "o/r", number, state: "open", headRef: "pt-9-x", title: "t", body: "", checks: "pass", reviewDecision: null, updatedAt: "2026-10-01T00:00:00Z", ...over,
});
const ticket = (over: Partial<JiraTicket> = {}): JiraTicket => ({
  key: "PT-9", summary: "s", status: "In Progress", statusCategory: "indeterminate", assignee: { accountId: "me", displayName: "Me" }, assignedToMe: true,
  issueType: "Task", isEpic: false, parentKey: null, epicKey: null, openChildren: 0, updatedAt: "2026-10-01T00:00:00Z", url: "https://x/browse/PT-9", ...over,
});

describe("deepCheckFindings", () => {
  const links = [{ key: "PT-9" }];
  const f = (over: Partial<Parameters<typeof deepCheckFindings>[0]> = {}) =>
    deepCheckFindings({ links, snapshot: { stale: false, tickets: [ticket()] }, prs: [], mentions: [], me: "me", ...over });
  it("all PRs merged and the ticket resolved → Run Done check", () => {
    expect(f({ prs: [pr(1, { state: "merged" })], snapshot: { stale: false, tickets: [ticket({ statusCategory: "done" })] } })).toMatchObject({
      reason: "All PRs merged · PT-9 resolved",
      next: "done-check",
    });
  });
  it("a stale snapshot → PR status unavailable, snooze, never a Done offer", () => {
    const r = f({ prs: [pr(1, { state: "merged" })], snapshot: { stale: true, tickets: [ticket({ statusCategory: "done" })] } });
    expect(r).toEqual({ reason: "PR status unavailable", next: "snooze" });
    expect(f({ snapshot: null })).toEqual({ reason: "PR status unavailable", next: "snooze" });
  });
  it("reassigned", () => {
    expect(f({ snapshot: { stale: false, tickets: [ticket({ assignee: { accountId: "x", displayName: "Ana" }, assignedToMe: false })] } }).reason).toBe("PT-9 reassigned to Ana");
  });
  it("changes requested / CI failing → Open PR", () => {
    expect(f({ prs: [pr(4, { reviewDecision: "changes_requested" })] })).toMatchObject({ reason: "PR #4: changes requested", next: "open-pr", prUrl: "https://github.com/o/r/pull/4" });
    expect(f({ prs: [pr(5, { checks: "fail" })] })).toMatchObject({ reason: "PR #5: CI failing", next: "open-pr" });
  });
  it("possibly fixed elsewhere: a merged PR mentioning the key that is not this thread's", () => {
    const mentions = [{ key: "PT-9", repo: "o/other", number: 77, mergedAt: "2026-10-20T00:00:00Z" }];
    expect(f({ mentions }).reason).toBe("Possibly fixed elsewhere: o/other#77 merged");
    expect(f({ mentions, prs: [pr(77, { repo: "o/other" })] }).reason).not.toMatch(/elsewhere/);
  });
});

describe("replyLine", () => {
  it("first non-empty line, plain, at most 140 characters", () => {
    expect(replyLine("\n  **waiting on review (#645)**  \nmore")).toBe("waiting on review (#645)");
    expect(replyLine("x".repeat(300))).toHaveLength(140);
    expect(replyLine(null)).toBeNull();
    expect(replyLine("  \n ")).toBeNull();
  });
});

describe("the idle sweep while Jira is on", () => {
  const th = { id: "a", status: "idle", updatedAt: NOW - 60 * DAY, isPinned: false, isUnread: false, queuedWork: "none", hasPendingInteraction: false } as unknown as PluginSidebarThread;
  it("marks nothing Done when enabled; unchanged when off", () => {
    expect(sweepCandidatesForIdleColumn([th], new Set(), { idleArchiveMs: DAY, jiraEnabled: true }, NOW)).toEqual([]);
    expect(sweepCandidatesForIdleColumn([th], new Set(), { idleArchiveMs: DAY }, NOW)).toEqual(["a"]);
  });
});

describe("Needs you lane", () => {
  const th = (id: string) => ({ id, status: "idle", updatedAt: NOW - DAY, isPinned: false, isUnread: false, queuedWork: "none", hasPendingInteraction: false }) as unknown as PluginSidebarThread;
  const ctx = { projects: [], providers: [] };
  const lanes = (needsYou?: ReadonlySet<string>, done: ReadonlySet<string> = new Set()) =>
    Object.fromEntries(
      buildColumns([th("a"), th("b")], "status", ctx, new Map(), done, NOW, {}, new Map(), new Map(), withNeedsYou(new Set(), needsYou)).map((c) => [c.id, c.threads.map((t) => t.id)]),
    );
  it("a reason (not Done) counts as attention; Done stays Done; no set → upstream lanes", () => {
    expect(lanes(new Set(["a"]))).toMatchObject({ attention: ["a"], "idle-earlier": ["b"] });
    expect(lanes(new Set(["a"]), new Set(["a"]))).toMatchObject({ done: ["a"] });
    expect(lanes()).toEqual(lanes(new Set()));
    expect(lanes().attention).toBeUndefined();
  });
  it("withNeedsYou: no ids → the same acks object; acks keep their meaning", () => {
    const acks = new Set(["x"]);
    expect(withNeedsYou(acks, undefined)).toBe(acks);
    expect(withNeedsYou(acks, new Set())).toBe(acks);
    const both = withNeedsYou(acks, new Set(["a"]));
    expect([...both]).toEqual(["x"]);
    expect(threadState(th("a"), both)).toBe("attention");
    expect(threadState(th("b"), both)).toBe("idle");
  });
  it("a nested child with a reason leaves the family's rows for Needs you (the family lands there too)", () => {
    const parent = th("p");
    const child = { ...th("c"), parentThreadId: "p" } as PluginSidebarThread;
    const quiet = assembleBoard([parent, child], "status", ctx, new Map(), new Set(), NOW, {});
    expect(quiet.nestedChildrenByParent.get("p")?.map((t) => t.id)).toEqual(["c"]);
    expect(quiet.columns.find((c) => c.id === "attention")).toBeUndefined();
    const flagged = assembleBoard([parent, child], "status", ctx, new Map(), new Set(), NOW, { errorAcks: withNeedsYou(new Set(), new Set(["c"])) });
    expect(flagged.nestedChildrenByParent.get("p") ?? []).toEqual([]);
    expect(flagged.columns.find((c) => c.id === "attention")?.threads.map((t) => t.id)).toContain("c");
  });
});

// ---- the scheduler pass on a fake host ----

const iso = (ms: number) => new Date(ms).toISOString();
const snap = (over: { prs?: GhPr[]; tickets?: JiraTicket[]; takenAt?: string } = {}) => ({
  version: 1, takenAt: over.takenAt ?? new Date().toISOString(), ok: true, error: null, me: { accountId: "me" },
  tickets: over.tickets ?? [ticket({ key: "PT-1", url: "https://x/browse/PT-1" })], prs: over.prs ?? [], mentions: [],
});
const rec = (over: object = {}) => ({
  links: [{ key: "PT-1", role: "owner", source: "auto" }], enrolledAt: iso(Date.now() - 3 * DAY), verifying: null, doneCheck: null,
  nudgedAt: null, deepCheckedAt: null, reason: null, checkInWith: null, ...over,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("reminders on a fake host", () => {
  let harness: FakePluginHarness;
  let bb: ReturnType<typeof createFakePluginHost>["bb"];
  const metadata = new Map<string, Record<string, unknown>>();
  const status = new Map<string, string>();
  const updatedAt = new Map<string, number>();
  let send: ReturnType<typeof vi.fn>;
  let markUnread: ReturnType<typeof vi.fn>;
  let failWrite: ((set: Record<string, any> | undefined) => boolean) | null = null;

  async function load(opts: { enabled?: boolean; snapshot?: object | null; kv?: Record<string, unknown> } = {}) {
    send = vi.fn(async () => ({}));
    // The real host bumps updatedAt on markUnread.
    markUnread = vi.fn(async ({ threadId }: { threadId: string }) => {
      updatedAt.set(threadId, Date.now());
      return {};
    });
    const row = (id: string) =>
      makeThreadResponse({ id, title: `title ${id}`, status: (status.get(id) ?? "idle") as never, updatedAt: updatedAt.get(id) ?? Date.now(), environmentBranchName: null } as never);
    const host = createFakePluginHost({
      pluginId: "focus-board",
      settings: { jiraEnabled: opts.enabled ?? true } as never,
      sdk: {
        threads: {
          list: async (args?: { archived?: boolean }) => (args?.archived ? [] : [...metadata.keys()].map(row)),
          get: async ({ threadId }: { threadId: string }) => row(threadId),
          send,
          markUnread,
          getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {},
          updatePluginMetadata: async ({ threadId, set, remove }: { threadId: string; set?: Record<string, unknown>; remove?: string[] }) => {
            if (failWrite?.(set)) throw new Error("metadata write failed");
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
  afterEach(async () => {
    await harness.lifecycle.dispose();
    vi.useRealTimers();
    failWrite = null;
    metadata.clear();
    status.clear();
    updatedAt.clear();
  });
  const seed = (id: string, quietDays: number, over: object = {}) => {
    updatedAt.set(id, Date.now() - quietDays * DAY);
    metadata.set(id, { jira: rec({ enrolledAt: iso(Date.now() - quietDays * DAY), ...over }) });
  };
  const jiraOf = (id: string) => metadata.get(id)?.jira as Record<string, any>;
  const tick = async () => {
    await harness.runSchedule("jira-reminders");
    await flush();
  };
  const sentTo = () => send.mock.calls.map((c) => (c[0] as { threadId: string }).threadId);
  const busy409 = () => Object.assign(new Error("not writable"), { status: 409, code: "thread_not_writable" });

  it("the tick nudges quiet threads only: markUnread, the status turn, nudgedAt", async () => {
    seed("quiet", 3);
    seed("fresh", 1);
    seed("unlinked", 3, { links: [] });
    await load();
    await tick();
    expect(sentTo().sort()).toEqual(["quiet", "unlinked"]);
    expect(send.mock.calls[0]![0]).toMatchObject({ mode: "start", input: [{ type: "text", text: NUDGE_TEXT }] });
    expect(markUnread).toHaveBeenCalledWith({ threadId: "quiet" });
    expect(jiraOf("quiet").nudgedAt).toEqual(expect.any(String));
    expect(jiraOf("fresh").nudgedAt).toBeNull();
    expect(jiraOf("unlinked").reason).toBe("no ticket yet");
    // A second pass does not re-nudge.
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("off: the tick does nothing", async () => {
    seed("quiet", 3);
    await load({ enabled: false });
    await tick();
    expect(send).not.toHaveBeenCalled();
    expect(jiraOf("quiet").nudgedAt).toBeNull();
  });

  it("a thread that turns active between plan and send gets busy: un-nudged, not queued, retried next pass", async () => {
    seed("t1", 3);
    await load();
    send.mockRejectedValueOnce(busy409());
    await tick();
    expect(jiraOf("t1").nudgedAt).toBeNull();
    expect(markUnread).not.toHaveBeenCalled(); // a running thread is not marked unread (nor its clock restarted)
    expect(((await bb.storage.kv.get(IDLE_JOBS_KEY)) as unknown[] | undefined) ?? []).toEqual([]);
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(jiraOf("t1").nudgedAt).toEqual(expect.any(String));
  });

  it("a send that throws: logged, un-nudged, retried next pass", async () => {
    seed("t1", 3);
    await load();
    send.mockRejectedValueOnce(new Error("boom"));
    await tick();
    expect(jiraOf("t1").nudgedAt).toBeNull();
    expect(markUnread).not.toHaveBeenCalled();
    await tick(); // resent on the very next tick (the quiet clock did not restart)
    expect(send).toHaveBeenCalledTimes(2);
    expect(jiraOf("t1").nudgedAt).toEqual(expect.any(String));
  });

  it("at most nudgeTurnsPerPass sent per pass, counting only sent", async () => {
    for (let i = 0; i < 5; i++) seed(`t${i}`, 3 + i / 10);
    await load();
    send.mockRejectedValueOnce(busy409()); // the oldest (t4) is busy
    await tick();
    expect(sentTo()).toEqual(["t4", "t3", "t2", "t1"]);
    expect(Object.keys(Object.fromEntries(metadata)).filter((id) => jiraOf(id).nudgedAt !== null).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("never runs two passes at once", async () => {
    seed("t1", 3);
    await load();
    let release!: () => void;
    send.mockImplementationOnce(() => new Promise((r) => (release = () => r({}))));
    const first = harness.runSchedule("jira-reminders");
    await flush();
    await tick(); // overlapping tick: skipped
    release();
    await first;
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("the reply's first line becomes the reason; the nudge turn's own activity keeps it; later activity clears it", async () => {
    seed("t1", 3);
    await load();
    await tick();
    expect(jiraOf("t1").reason).not.toBeNull();
    await harness.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "t1" }) });
    await flush();
    await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "t1" }), lastAssistantText: "waiting on review (#645)\nthe rest" });
    await flush();
    expect(jiraOf("t1").reason).toBe("waiting on review (#645)");
    // The nudge's own activity is not "new activity": no re-nudge after the reply.
    updatedAt.set("t1", Date.now());
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    await harness.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "t1" }) });
    await flush();
    expect(jiraOf("t1").reason).toBeNull();
  });

  it("a snoozed thread is skipped; after the wake the clock restarts", async () => {
    seed("t1", 3);
    metadata.get("t1")!.snooze = { wakeAt: iso(Date.now() + DAY), setAt: iso(Date.now()) };
    await load();
    await tick();
    expect(send).not.toHaveBeenCalled();
    delete metadata.get("t1")!.snooze; // woke (or cleared) now
    await tick();
    expect(send).not.toHaveBeenCalled();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * DAY + 60_000 }); // wake + nudgeDays
    await tick();
    expect(sentTo()).toEqual(["t1"]);
  });

  it("day 5: the deep check writes findings plugin-side, no turn; the board gets the next step", async () => {
    seed("t1", 6, { nudgedAt: iso(Date.now() - 4 * DAY) });
    await load({ snapshot: snap({ tickets: [ticket({ key: "PT-1", statusCategory: "done" })] }) });
    await tick();
    expect(send).not.toHaveBeenCalled();
    expect(jiraOf("t1").deepCheckedAt).toEqual(expect.any(String));
    expect(jiraOf("t1").reason).toBe("PT-1 resolved");
    const state = (await harness.behavior.callRpc("jira_board_state", null)) as { next: Record<string, { next: string; reason: string }> };
    expect(state.next.t1).toMatchObject({ next: "done-check", reason: "PT-1 resolved" });
  });

  it("a stale snapshot: PR status unavailable, next snooze", async () => {
    seed("t1", 6, { nudgedAt: iso(Date.now() - 4 * DAY) });
    await load({ snapshot: snap({ takenAt: iso(Date.now() - DAY) }) });
    await tick();
    expect(jiraOf("t1").reason).toBe("PR status unavailable");
    const state = (await harness.behavior.callRpc("jira_board_state", null)) as { next: Record<string, { next: string }> };
    expect(state.next.t1!.next).toBe("snooze");
  });

  it("never touches a verifying thread", async () => {
    seed("t1", 9, { verifying: { startedAt: iso(Date.now()) } });
    await load();
    await tick();
    // (The resumed Done check may send its own verify turn; never a nudge.)
    expect(send.mock.calls.some((c) => JSON.stringify(c[0]).includes(NUDGE_TEXT))).toBe(false);
    expect(jiraOf("t1").deepCheckedAt).toBeNull();
  });

  it("operator clicks clear the reason: dismiss-reason, run-done-check", async () => {
    seed("t1", 1, { reason: "waiting on you" });
    await load();
    expect(await harness.behavior.callRpc("jira_card_action", { kind: "dismiss-reason", threadId: "t1" })).toEqual({ ok: true });
    expect(jiraOf("t1").reason).toBeNull();
    metadata.set("t1", { jira: rec({ reason: "PT-1 resolved" }) });
    status.set("t1", "active"); // the check waits for idle
    expect(await harness.behavior.callRpc("jira_card_action", { kind: "run-done-check", threadId: "t1" })).toEqual({ ok: true });
    expect(jiraOf("t1").verifying).toMatchObject({ startedAt: expect.any(String) });
    expect(jiraOf("t1").reason).toBeNull();
  });

  it("a sent nudge at day 2 (markUnread bumps updatedAt): the deep check still comes at day 5, not 7", async () => {
    seed("t1", 2);
    await load();
    await tick();
    expect(sentTo()).toEqual(["t1"]);
    expect(updatedAt.get("t1")).toBeGreaterThan(Date.now() - 60_000); // bumped by markUnread
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 3 * DAY + 60_000 });
    await tick();
    expect(jiraOf("t1").deepCheckedAt).toEqual(expect.any(String));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a reply after a Done check started (or failed) is not written over its reason", async () => {
    seed("t1", 3);
    await load();
    await tick();
    expect(await harness.behavior.callRpc("jira_card_action", { kind: "run-done-check", threadId: "t1" })).toEqual({ ok: true });
    expect(jiraOf("t1").verifying).not.toBeNull();
    await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "t1" }), lastAssistantText: "my nudge reply" });
    await flush();
    expect(jiraOf("t1").reason).not.toBe("my nudge reply");
  });

  it("the nudgedAt write failing after a sent nudge: logged, and no second nudge", async () => {
    seed("t1", 3);
    await load();
    failWrite = (set) => typeof set?.jira?.nudgedAt === "string";
    await tick();
    failWrite = null;
    expect(jiraOf("t1").nudgedAt).toBeNull();
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a second thread.active while the nudge runs is real activity: marker gone, reason cleared, no capture", async () => {
    seed("t1", 3);
    await load();
    await tick();
    await harness.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "t1" }) }); // the nudge turn
    await flush();
    await harness.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "t1" }) }); // the operator's turn
    await flush();
    expect(jiraOf("t1").reason).toBeNull();
    await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "t1" }), lastAssistantText: "operator turn output" });
    await flush();
    expect(jiraOf("t1").reason).toBeNull();
    expect(((await bb.storage.kv.get("jira:nudge-turns")) as Record<string, unknown>).t1).toBeUndefined();
  });

  it("a stale sent marker (over an hour) never captures a reply", async () => {
    seed("t1", 3, { nudgedAt: iso(Date.now() - 2 * 3_600_000) });
    await load({ kv: { "jira:nudge-turns": { t1: { phase: "sent", lastActivityAt: Date.now() - 3 * DAY, at: Date.now() - 2 * 3_600_000 } } } });
    await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "t1" }), lastAssistantText: "some later turn" });
    await flush();
    expect(jiraOf("t1").reason).toBeNull();
  });

  it("a never-enrolled thread is enrolled by the pass and nudged only after the grace", async () => {
    updatedAt.set("t1", Date.now() - 30 * DAY);
    metadata.set("t1", {}); // no Jira record at all
    await load();
    await tick();
    expect(send).not.toHaveBeenCalled();
    expect(jiraOf("t1").enrolledAt).toEqual(expect.any(String));
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * DAY + 60_000 });
    await tick();
    expect(sentTo()).toEqual(["t1"]);
  });

  it("CLI sweep with Jira on: the long-idle arm proposes nothing; Done archiving unchanged", async () => {
    updatedAt.set("idle", Date.now() - 40 * DAY);
    metadata.set("idle", {});
    updatedAt.set("old-done", Date.now() - 40 * DAY);
    metadata.set("old-done", { [DONE_METADATA_KEY]: { doneAt: iso(Date.now() - 10 * DAY) } });
    await load();
    const r = await harness.behavior.runCli(["sweep"]);
    expect(r.stdout).toContain("old-done");
    expect(r.stdout).not.toMatch(/\bidle\b.*idle longer/);
    expect(r.stdout).not.toContain("idle longer than");
  });
});
