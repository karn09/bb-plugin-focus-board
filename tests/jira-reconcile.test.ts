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
  const rows = () => [
    makeThreadResponse({ id: "a", title: "PT-3878 A: plan the cutover" }),
    { ...makeThreadResponse({ id: "run", title: "PT-3570 wire up reviewer", status: "active" }), environmentBranchName: null },
    { ...makeThreadResponse({ id: "pg", title: "Module cleanup follow-up" }), environmentBranchName: "pt-3879-g" },
    makeThreadResponse({ id: "utf", title: "UTF-8 cleanup" }),
  ];

  async function load(settings: Record<string, unknown> = {}) {
    metadata.clear();
    send.mockClear();
    host = createFakePluginHost({
      pluginId: "focus-board",
      settings: settings as never,
      sdk: {
        threads: {
          list: async (args?: { archived?: boolean }) => (args?.archived ? [] : rows()),
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
    await host.bb.storage.kv.set("jira:snapshot", snapshot);
    await server(host.bb);
  }
  afterEach(async () => {
    await harness.lifecycle.dispose();
  });
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("CLI dry run prints the plan and writes nothing; --confirm applies via link_set path", async () => {
    await load();
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
    expect((metadata.get("utf")?.jira as { enrolledAt: string }).enrolledAt).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    expect(await host.bb.storage.kv.get("jira:queue")).toBeUndefined();
    expect(await host.bb.storage.kv.get("jira:reconcile-plan")).toEqual(expect.objectContaining({ generatedAt: expect.any(String) }));

    // A second confirm adds no duplicate chip.
    await harness.behavior.runCli(["jira", "reconcile", "--confirm"]);
    expect(metadata.get("run")?.linkedIssues).toHaveLength(1);
  });

  it("an operator's existing Jira link for the key is kept as-is (no second chip)", async () => {
    await load();
    const mine = { tracker: "external", url: "https://growtherapy.atlassian.net/browse/PT-3570?focus=1", hostname: "growtherapy.atlassian.net", label: "review", createdAt: "2026-10-01T00:00:00.000Z", source: "operator" };
    metadata.set("run", { linkedIssues: [mine] });
    await harness.behavior.runCli(["jira", "reconcile", "--confirm"]);
    expect(metadata.get("run")?.linkedIssues).toEqual([mine]);
  });

  it("does nothing while jiraEnabled is off (upstream behavior)", async () => {
    await load();
    await settle();
    expect(metadata.size).toBe(0);
    expect(await host.bb.storage.kv.get("jira:reconcile-plan")).toBeUndefined();
  });

  it("false->true flip applies once; re-flip after off applies again; never sends", async () => {
    await load();
    await harness.behavior.setSettings({ jiraEnabled: true });
    await settle();
    expect(await host.bb.storage.kv.get("jira:enabled-seen")).toBe(true);
    const first = (metadata.get("a")?.jira as { enrolledAt: string }).enrolledAt;
    expect(first).toBeTruthy();
    const plan1 = await host.bb.storage.kv.get("jira:reconcile-plan");

    await harness.behavior.setSettings({ jiraRefreshMinutes: 3 }); // not a flip
    await settle();
    expect(await host.bb.storage.kv.get("jira:reconcile-plan")).toEqual(plan1);

    await harness.behavior.setSettings({ jiraEnabled: false });
    await settle();
    expect(await host.bb.storage.kv.get("jira:enabled-seen")).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("enabled at load and never seen: runs on plugin start", async () => {
    await load({ jiraEnabled: true });
    await settle();
    expect(await host.bb.storage.kv.get("jira:enabled-seen")).toBe(true);
    expect((metadata.get("run")?.jira as { links: unknown[] }).links).toEqual([{ key: "PT-3570", role: "owner", source: "auto" }]);
    expect(send).not.toHaveBeenCalled();
  });

  it("RPCs: plan returns a dry plan, apply stores it", async () => {
    await load();
    const dry = (await harness.behavior.callRpc("jira_reconcile_plan", null)) as { autoLinks: unknown[] };
    expect(dry.autoLinks.length).toBeGreaterThan(0);
    expect(metadata.get("a")).toBeUndefined();
    const applied = (await harness.behavior.callRpc("jira_reconcile_apply", null)) as { generatedAt: string };
    expect(applied.generatedAt).toBeTruthy();
    expect(await harness.behavior.callRpc("jira_reconcile_plan", null)).toEqual(applied);
  });
});
