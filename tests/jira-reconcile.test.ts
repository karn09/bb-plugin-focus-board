import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import server from "../server";
import { applyReconcile, planReconcile, type ReconThread } from "../lib/jira-reconcile";
import { createJiraStore } from "../lib/jira-store";
import type { GhPr, JiraSnapshot, JiraTicket } from "../lib/jira-schema";
import type { ThreadLink } from "../lib/link-metadata";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const projects = ["PT", "SRE"];

const ticket = (key: string, summary: string, over: Partial<JiraTicket> = {}): JiraTicket => ({
  key, summary, status: "In Progress", statusCategory: "indeterminate", assignee: { accountId: "me", displayName: "Me" },
  assignedToMe: true, issueType: "Task", isEpic: false, parentKey: null, epicKey: null, openChildren: 0,
  updatedAt: "2026-10-28T00:00:00Z", url: `https://growtherapy.atlassian.net/browse/${key}`, ...over,
});
const pr = (number: number, over: Partial<GhPr> = {}): GhPr => ({
  repo: "growtherapy/infra", number, state: "open", headRef: `branch-${number}`, title: `PR ${number}`, body: "",
  checks: "pass", reviewDecision: null, updatedAt: "2026-10-28T00:00:00Z", ...over,
});
const ghPull = (number: number): ThreadLink => ({
  tracker: "github", repo: "growtherapy/infra", issue: number, kind: "pull",
  href: `https://github.com/growtherapy/infra/pull/${number}`, createdAt: "2026-10-01T00:00:00Z", source: "agent",
});
const th = (id: string, title: string, over: Partial<ReconThread> = {}): ReconThread => ({
  id, title, branch: null, status: "idle", archived: false, done: false, ...over,
});

// Mirrors the operator's real board.
const tickets = [
  ticket("PT-3878", "Atlantis migration"),
  ticket("PT-3879", "Terraform module cleanup", { statusCategory: "new", status: "To Do" }),
  ticket("PT-3570", "Automated Atlantis plan review"),
];
const snapshot: JiraSnapshot = {
  version: 1, takenAt: "2026-10-29T11:59:00Z", ok: true, error: null, me: { accountId: "me" },
  tickets, prs: [pr(41, { body: "Part of SRE-26" }), pr(42, { headRef: "pt-3879-g" })], mentions: [],
};
const threads: ReconThread[] = [
  th("a", "PT-3878 A: plan the cutover"),
  th("bc", "PT-3878 B+C: state moves"),
  th("d", "PT-3878 D: dry run"),
  th("e", "PT-3878 E: decommission"),
  ...["a", "b", "c", "d", "e", "f"].map((s) => th(`p${s}`, `PT-3879 part ${s}`)),
  th("pg", "Module cleanup follow-up", { branch: "pt-3879-g" }),
  th("waf", "Resolve WAF IP set drift"),
  th("utf", "UTF-8 cleanup"),
  th("sre", "Tidy alert routing"),
  th("run", "PT-3570 wire up reviewer", { status: "active" }),
  th("done", "PT-3878 retro notes", { done: true }),
  th("old", "PT-3878 archived", { archived: true }),
];
const links: Record<string, ThreadLink[]> = { sre: [ghPull(41)] };
const input = { threads, links, prs: snapshot.prs, snapshot, projects, now: NOW };

function memStore() {
  const kv = new Map<string, unknown>();
  const meta = new Map<string, Record<string, unknown>>();
  const store = createJiraStore(
    { get: async (k) => kv.get(k), set: async (k, v) => kv.set(k, v) },
    {
      getPluginMetadata: async ({ threadId }) => meta.get(threadId) ?? {},
      updatePluginMetadata: async ({ threadId, set }) => meta.set(threadId, { ...(meta.get(threadId) ?? {}), ...set }),
    },
    () => NOW,
  );
  return { store, kv };
}

describe("planReconcile", () => {
  const plan = planReconcile(input);
  const keysOf = (id: string) => plan.autoLinks.filter((l) => l.threadId === id).map((l) => l.key);

  it("PT-3878 x4 and PT-3879 x7 (title and branch) auto-link", () => {
    expect(["a", "bc", "d", "e"].map(keysOf)).toEqual([["PT-3878"], ["PT-3878"], ["PT-3878"], ["PT-3878"]]);
    expect(plan.autoLinks.filter((l) => l.key === "PT-3879").map((l) => l.threadId).sort()).toEqual(
      ["pa", "pb", "pc", "pd", "pe", "pf", "pg"],
    );
  });

  it("WAF drift thread gets no autoLink, and no fuzzy match against PT-3570", () => {
    expect(keysOf("waf")).toEqual([]);
    expect(plan.suggestions.filter((s) => s.threadId === "waf")).toEqual([]);
  });

  it("a key only in a linked PR body is a pr-body suggestion, never an autoLink", () => {
    expect(keysOf("sre")).toEqual([]);
    expect(plan.suggestions).toContainEqual({ threadId: "sre", key: "SRE-26", why: "pr-body" });
  });

  it("UTF-8 cleanup gets nothing", () => {
    expect(keysOf("utf")).toEqual([]);
    expect(plan.suggestions.filter((s) => s.threadId === "utf")).toEqual([]);
  });

  it("running thread is auto-linked and enrolled like any other", () => {
    expect(keysOf("run")).toEqual(["PT-3570"]);
    expect(plan.enroll).toContain("run");
  });

  it("Done thread is skippedDone but still linked and enrolled; archived is untouched", () => {
    expect(plan.skippedDone).toEqual(["done"]);
    expect(keysOf("done")).toEqual(["PT-3878"]);
    expect(plan.enroll).toContain("done");
    expect(plan.enroll).not.toContain("old");
    expect(keysOf("old")).toEqual([]);
  });

  it("with a snapshot, a project key missing from it does not auto-link; without one, it does", () => {
    const t = [th("x", "PT-9999 unknown")];
    expect(planReconcile({ ...input, threads: t }).autoLinks).toEqual([]);
    expect(planReconcile({ ...input, threads: t, snapshot: null, prs: [] }).autoLinks).toEqual([{ threadId: "x", key: "PT-9999" }]);
  });

  it("an existing external Jira link (jira field or /browse/ url) auto-links", () => {
    const ext = (url: string, key?: string): ThreadLink => ({
      tracker: "external", url, hostname: "growtherapy.atlassian.net", createdAt: "2026-10-01T00:00:00Z", source: "operator",
      ...(key ? { jira: { key } } : {}),
    });
    const p = planReconcile({
      ...input,
      threads: [th("x", "no key"), th("y", "no key")],
      links: { x: [ext("https://growtherapy.atlassian.net/browse/PT-3570")], y: [ext("https://example.com/z", "PT-3878")] },
    });
    expect(p.autoLinks).toEqual([{ threadId: "x", key: "PT-3570" }, { threadId: "y", key: "PT-3878" }]);
  });

  it("title keys are exact: lowercase sre-12 and look-alikes GLM-5 / INC-340 / UTF-8 give nothing", () => {
    const t = [th("l", "sre-12 fix"), th("g", "GLM-5 eval"), th("i", "INC-340 follow-up"), th("u", "UTF-8 cleanup")];
    for (const snap of [snapshot, null]) {
      const p = planReconcile({ ...input, threads: t, snapshot: snap });
      expect(p.autoLinks).toEqual([]);
      expect(p.suggestions).toEqual([]);
    }
  });

  it("fuzzy: an assigned ticket sharing 3+ title tokens is suggested", () => {
    const p = planReconcile({ ...input, threads: [th("z", "Automated Atlantis plan review tweaks")] });
    expect(p.suggestions).toEqual([{ threadId: "z", key: "PT-3570", why: "fuzzy" }]);
    expect(p.autoLinks).toEqual([]);
  });

  it("drift: a To Do ticket with an open PR via its threads is todo-with-prs", () => {
    expect(plan.drift).toEqual([expect.objectContaining({ key: "PT-3879", kind: "todo-with-prs" })]);
  });
});

describe("applyReconcile", () => {
  it("writes links + enrolledAt only: no enqueue, no send, doneCheck stays null; rerun keeps first enrolledAt", async () => {
    const { store, kv } = memStore();
    const enqueue = vi.spyOn(store, "enqueue");
    const send = vi.fn();
    const writer = vi.fn(async (_t: string, _k: string) => {});
    const plan = planReconcile(input);
    await applyReconcile(plan, store, writer, NOW);
    expect(enqueue).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(kv.get("jira:queue")).toBeUndefined();
    expect(writer).toHaveBeenCalledWith("run", "PT-3570");
    expect(writer).toHaveBeenCalledTimes(plan.autoLinks.length);

    const run = await store.readThread("run");
    expect(run.links).toEqual([{ key: "PT-3570", role: "owner", source: "auto" }]);
    expect(run.enrolledAt).toBe("2026-10-29T12:00:00.000Z");
    const done = await store.readThread("done");
    expect(done.doneCheck).toBeNull();
    expect(done.enrolledAt).toBe("2026-10-29T12:00:00.000Z");
    expect((await store.readThread("utf")).enrolledAt).toBe("2026-10-29T12:00:00.000Z");

    await applyReconcile(planReconcile({ ...input, now: NOW + 86_400_000 }), store, writer, NOW + 86_400_000);
    expect((await store.readThread("run")).enrolledAt).toBe("2026-10-29T12:00:00.000Z");
    expect((await store.readThread("run")).links).toHaveLength(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("resetEnrollment (the flip) re-enrolls at now; without it the first enrolledAt stays", async () => {
    const { store } = memStore();
    await applyReconcile(planReconcile(input), store, async () => {}, NOW);
    const later = NOW + 30 * 86_400_000;
    await applyReconcile(planReconcile(input), store, async () => {}, later, { resetEnrollment: true });
    expect((await store.readThread("run")).enrolledAt).toBe(new Date(later).toISOString());
    await applyReconcile(planReconcile(input), store, async () => {}, later + 1000);
    expect((await store.readThread("run")).enrolledAt).toBe(new Date(later).toISOString());
  });

  it("a thread whose writes throw is skipped and reported; the others still apply", async () => {
    const { store } = memStore();
    const orig = store.updateThread;
    vi.spyOn(store, "updateThread").mockImplementation((id, fn) =>
      id === "waf" ? Promise.reject(new Error("metadata write failed")) : orig(id, fn),
    );
    const writer = async (id: string) => {
      if (id === "bc") throw new Error("link write failed");
    };
    const r = await applyReconcile(planReconcile(input), store, writer, NOW);
    expect(r.failed).toEqual([
      { threadId: "bc", error: "link write failed" },
      { threadId: "waf", error: "metadata write failed" },
    ]);
    expect((await orig("utf", () => ({}))).enrolledAt).toBe(new Date(NOW).toISOString());
    expect((await store.readThread("e")).links).toHaveLength(1);
  });

  it("keeps an existing agent link's role/source instead of overwriting it", async () => {
    const { store } = memStore();
    await store.writeThread("run", { links: [{ key: "PT-3570", role: "watching", source: "agent" }] });
    await applyReconcile(planReconcile(input), store, async () => {}, NOW);
    expect((await store.readThread("run")).links).toEqual([{ key: "PT-3570", role: "watching", source: "agent" }]);
  });
});

describe("reconcile wiring (fake host)", () => {
  let harness: FakePluginHarness;
  let host: ReturnType<typeof createFakePluginHost>;
  const metadata = new Map<string, Record<string, unknown>>();
  const send = vi.fn(async () => ({}));
  let failWrites = new Set<string>();
  const rows = () => [
    makeThreadResponse({ id: "a", title: "PT-3878 A: plan the cutover" }),
    { ...makeThreadResponse({ id: "run", title: "PT-3570 wire up reviewer", status: "active" }), environmentBranchName: null },
    { ...makeThreadResponse({ id: "pg", title: "Module cleanup follow-up" }), environmentBranchName: "pt-3879-g" },
    makeThreadResponse({ id: "utf", title: "UTF-8 cleanup" }),
  ];
  const enrolledAt = (id: string) => (metadata.get(id)?.jira as { enrolledAt?: string } | undefined)?.enrolledAt;
  let clock = NOW;

  /** seen: pre-mark the flip as already handled, so load with Jira on runs nothing. */
  async function load(settings: Record<string, unknown> = {}, opts: { seen?: boolean } = {}) {
    metadata.clear();
    send.mockClear();
    failWrites = new Set();
    clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    host = createFakePluginHost({
      pluginId: "focus-board",
      settings: settings as never,
      sdk: {
        threads: {
          list: async (args?: { archived?: boolean }) => (args?.archived ? [] : rows()),
          send,
          getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {},
          updatePluginMetadata: async ({ threadId, set, remove }: { threadId: string; set?: Record<string, unknown>; remove?: string[] }) => {
            if (failWrites.has(threadId)) throw new Error(`write failed for ${threadId}`);
            const next = { ...(metadata.get(threadId) ?? {}), ...(set ?? {}) };
            for (const k of remove ?? []) delete next[k];
            metadata.set(threadId, next);
            return next;
          },
        } as never,
      },
    });
    harness = host.harness;
    await host.bb.storage.kv.set("jira:snapshot", snapshot);
    if (opts.seen) await host.bb.storage.kv.set("jira:enabled-seen", true);
    await server(host.bb);
  }
  afterEach(async () => {
    await harness.lifecycle.dispose();
    vi.restoreAllMocks();
  });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const flip = async (on: boolean) => {
    await harness.behavior.setSettings({ jiraEnabled: on });
    await settle();
  };

  it("CLI dry run prints the plan and writes nothing; --confirm applies via link_set path", async () => {
    await load({ jiraEnabled: true }, { seen: true });
    const dry = await harness.behavior.runCli(["jira", "reconcile"]);
    expect(dry.exitCode).toBe(0);
    const out = JSON.parse(dry.stdout);
    expect(out.applied).toBe(false);
    expect(out.pendingOps).toBe(0);
    expect(out.plan.autoLinks).toEqual(
      expect.arrayContaining([{ threadId: "a", key: "PT-3878" }, { threadId: "run", key: "PT-3570" }, { threadId: "pg", key: "PT-3879" }]),
    );
    expect(metadata.get("a")).toBeUndefined();

    const r = await harness.behavior.runCli(["jira", "reconcile", "--confirm"]);
    expect(JSON.parse(r.stdout).applied).toBe(true);
    expect(metadata.get("run")?.linkedIssues).toEqual([
      expect.objectContaining({ tracker: "external", url: "https://growtherapy.atlassian.net/browse/PT-3570", label: "PT-3570", jira: { key: "PT-3570" }, source: "auto" }),
    ]);
    expect(enrolledAt("utf")).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    expect(await host.bb.storage.kv.get("jira:queue")).toBeUndefined();
    expect(await host.bb.storage.kv.get("jira:reconcile-plan")).toEqual(expect.objectContaining({ generatedAt: expect.any(String) }));

    // A second confirm adds no duplicate chip.
    await harness.behavior.runCli(["jira", "reconcile", "--confirm"]);
    expect(metadata.get("run")?.linkedIssues).toHaveLength(1);
  });

  it("CLI --confirm and RPC apply refuse while Jira is off; dry runs still work", async () => {
    await load();
    const r = await harness.behavior.runCli(["jira", "reconcile", "--confirm"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Jira is off — enable it first; the dry run works without it");
    await expect(harness.behavior.callRpc("jira_reconcile_apply", null)).rejects.toThrow(/Jira is off/);
    expect((await harness.behavior.runCli(["jira", "reconcile"])).exitCode).toBe(0);
    expect(((await harness.behavior.callRpc("jira_reconcile_plan", null)) as { autoLinks: unknown[] }).autoLinks.length).toBeGreaterThan(0);
    expect(metadata.size).toBe(0);
  });

  it("an auto Jira link is appended after the thread's existing links (never the primary chip)", async () => {
    await load({ jiraEnabled: true }, { seen: true });
    const gh = { tracker: "github", repo: "o/r", issue: 7, kind: "pull", href: "https://github.com/o/r/pull/7", createdAt: "2026-10-01T00:00:00.000Z", source: "agent" };
    metadata.set("run", { linkedIssues: [gh] });
    await harness.behavior.runCli(["jira", "reconcile", "--confirm"]);
    expect(metadata.get("run")?.linkedIssues).toEqual([gh, expect.objectContaining({ jira: { key: "PT-3570" } })]);
  });

  it("an operator's existing Jira link for the key is kept as-is (no second chip)", async () => {
    await load({ jiraEnabled: true }, { seen: true });
    const mine = { tracker: "external", url: "https://growtherapy.atlassian.net/browse/PT-3570?focus=1", hostname: "growtherapy.atlassian.net", label: "review", createdAt: "2026-10-01T00:00:00.000Z", source: "operator" };
    metadata.set("run", { linkedIssues: [mine] });
    await harness.behavior.runCli(["jira", "reconcile", "--confirm"]);
    expect(metadata.get("run")?.linkedIssues).toEqual([mine]);
  });

  it("a thread whose metadata write throws is skipped and reported; others apply", async () => {
    await load({ jiraEnabled: true }, { seen: true });
    failWrites.add("pg");
    const r = (await harness.behavior.callRpc("jira_reconcile_apply", null)) as { failed: { threadId: string }[] };
    expect(r.failed.map((f) => f.threadId)).toEqual(["pg"]);
    expect(enrolledAt("utf")).toBeTruthy();
    expect(enrolledAt("a")).toBeTruthy();
  });

  it("does nothing while jiraEnabled is off (upstream behavior)", async () => {
    await load();
    await settle();
    expect(metadata.size).toBe(0);
    expect(await host.bb.storage.kv.get("jira:reconcile-plan")).toBeUndefined();
  });

  it("flip on enrolls at now; non-flip changes do nothing; off a month then on again re-enrolls at the new now; never sends", async () => {
    await load();
    await flip(true);
    expect(await host.bb.storage.kv.get("jira:enabled-seen")).toBe(true);
    expect(enrolledAt("a")).toBe(new Date(NOW).toISOString());
    const plan1 = await host.bb.storage.kv.get("jira:reconcile-plan");

    clock = NOW + 1000;
    await harness.behavior.setSettings({ jiraRefreshMinutes: 3 }); // not a flip
    await settle();
    expect(await host.bb.storage.kv.get("jira:reconcile-plan")).toEqual(plan1);

    // A plain rerun while on keeps enrolledAt.
    await harness.behavior.runCli(["jira", "reconcile", "--confirm"]);
    expect(enrolledAt("a")).toBe(new Date(NOW).toISOString());

    await flip(false);
    expect(await host.bb.storage.kv.get("jira:enabled-seen")).toBe(false);
    clock = NOW + 30 * 86_400_000;
    await flip(true);
    expect(await host.bb.storage.kv.get("jira:enabled-seen")).toBe(true);
    expect(enrolledAt("a")).toBe(new Date(clock).toISOString());
    expect(enrolledAt("utf")).toBe(new Date(clock).toISOString());
    expect(send).not.toHaveBeenCalled();
  });

  it("enabled at load and never seen: runs on plugin start", async () => {
    await load({ jiraEnabled: true });
    await settle();
    expect(await host.bb.storage.kv.get("jira:enabled-seen")).toBe(true);
    expect((metadata.get("run")?.jira as { links: unknown[] }).links).toEqual([{ key: "PT-3570", role: "owner", source: "auto" }]);
    expect(send).not.toHaveBeenCalled();
  });

  it("restart with seen=true does not re-run or re-enroll", async () => {
    await load({ jiraEnabled: true }, { seen: true });
    await settle();
    expect(metadata.size).toBe(0);
  });

  it("RPCs: plan returns a dry plan, apply stores it, a newer snapshot refreshes the stored dry plan", async () => {
    await load({ jiraEnabled: true }, { seen: true });
    const dry = (await harness.behavior.callRpc("jira_reconcile_plan", null)) as { autoLinks: unknown[] };
    expect(dry.autoLinks.length).toBeGreaterThan(0);
    expect(metadata.get("a")).toBeUndefined();
    const { failed, ...applied } = (await harness.behavior.callRpc("jira_reconcile_apply", null)) as { failed: unknown[]; generatedAt: string };
    expect(failed).toEqual([]);
    expect(await harness.behavior.callRpc("jira_reconcile_plan", null)).toEqual(applied);

    // New snapshot after the plan: PT-3570 drops out of Jira data, so the dry plan changes.
    clock = NOW + 60_000;
    await host.bb.storage.kv.set("jira:snapshot", {
      ...snapshot,
      takenAt: new Date(NOW + 30_000).toISOString(),
      tickets: snapshot.tickets.filter((t) => t.key !== "PT-3570"),
    });
    const fresh = (await harness.behavior.callRpc("jira_reconcile_plan", null)) as { generatedAt: string; autoLinks: { key: string }[] };
    expect(fresh.generatedAt).toBe(new Date(clock).toISOString());
    expect(fresh.autoLinks.map((l) => l.key)).not.toContain("PT-3570");
    expect(await host.bb.storage.kv.get("jira:reconcile-plan")).toEqual(fresh);
    expect(enrolledAt("a")).toBe(new Date(NOW).toISOString()); // no apply happened
  });
});
