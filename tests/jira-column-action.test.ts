// jira_column_action: the Jira column's Link / dismiss / fix / started writes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import server from "../server";
import type { GhPr, JiraSnapshot, JiraTicket, QueueOp } from "../lib/jira-schema";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const DAY = 86_400_000;
const ticket = (key: string, summary: string, over: Partial<JiraTicket> = {}): JiraTicket => ({
  key, summary, status: "In Progress", statusCategory: "indeterminate", assignee: { accountId: "me", displayName: "Me" },
  assignedToMe: true, issueType: "Task", isEpic: false, parentKey: null, epicKey: null, openChildren: 0,
  updatedAt: "2026-10-28T00:00:00Z", url: `https://growtherapy.atlassian.net/browse/${key}`, ...over,
});
const pr = (number: number, over: Partial<GhPr> = {}): GhPr => ({
  repo: "growtherapy/infra", number, state: "open", headRef: `branch-${number}`, title: `PR ${number}`, body: "",
  checks: "pass", reviewDecision: null, updatedAt: "2026-10-28T00:00:00Z", ...over,
});
const snapshot: JiraSnapshot = {
  version: 1, takenAt: "2026-10-29T11:59:00Z", ok: true, error: null, me: { accountId: "me" },
  tickets: [
    ticket("PT-3879", "Terraform module cleanup", { statusCategory: "new", status: "To Do" }),
    ticket("PT-3570", "Automated Atlantis plan review tweaks"),
    ticket("SRE-9", "Old forgotten ticket", { updatedAt: new Date(NOW - 40 * DAY).toISOString() }),
    ticket("SRE-10", "Fresh ticket", { statusCategory: "new", status: "To Do" }),
  ],
  prs: [pr(42, { headRef: "pt-3879-g", state: "merged" })],
  mentions: [],
};

describe("jira_column_action", () => {
  let harness: FakePluginHarness;
  let host: ReturnType<typeof createFakePluginHost>;
  const metadata = new Map<string, Record<string, unknown>>();
  const rows = () => [
    { ...makeThreadResponse({ id: "pg", title: "Module cleanup follow-up" }), environmentBranchName: "pt-3879-g" },
    makeThreadResponse({ id: "z", title: "Automated Atlantis plan review tweaks" }),
  ];
  async function load(settings: Record<string, unknown>) {
    metadata.clear();
    vi.spyOn(Date, "now").mockImplementation(() => NOW);
    host = createFakePluginHost({
      pluginId: "focus-board",
      settings: settings as never,
      sdk: {
        threads: {
          list: async (args?: { archived?: boolean }) => (args?.archived ? [] : rows()),
          getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {},
          updatePluginMetadata: async ({ threadId, set }: { threadId: string; set?: Record<string, unknown> }) => {
            metadata.set(threadId, { ...(metadata.get(threadId) ?? {}), ...(set ?? {}) });
            return metadata.get(threadId);
          },
        } as never,
      },
    });
    harness = host.harness;
    await host.bb.storage.kv.set("jira:snapshot", snapshot);
    await host.bb.storage.kv.set("jira:enabled-seen", true);
    await server(host.bb);
  }
  afterEach(async () => {
    await harness.lifecycle.dispose();
    vi.restoreAllMocks();
  });
  const act = (input: Record<string, unknown>) => harness.behavior.callRpc("jira_column_action", input) as Promise<{ ok: boolean; error?: string }>;
  const plan = () => harness.behavior.callRpc("jira_reconcile_plan", null) as Promise<{ suggestions: { threadId: string; key: string }[]; drift: { key: string; kind: string }[] }>;
  const queue = async () => ((await host.bb.storage.kv.get("jira:queue")) ?? []) as QueueOp[];

  it("refuses every action while Jira is off", async () => {
    await load({ jiraEnabled: false });
    expect(await act({ action: "fix", key: "PT-3879", kind: "todo-with-prs" })).toEqual({ ok: false, error: expect.stringMatching(/Jira is off/) });
    expect(await queue()).toEqual([]);
  });

  it("the plan carries drift from detectDrift with the stale setting", async () => {
    await load({ jiraEnabled: true, jiraStaleTicketDays: 30 });
    expect((await plan()).drift).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "PT-3879", kind: "todo-with-prs" }),
        expect.objectContaining({ key: "SRE-9", kind: "stale-unlinked" }),
      ]),
    );
    await harness.lifecycle.dispose();
    await load({ jiraEnabled: true, jiraStaleTicketDays: 60 });
    expect((await plan()).drift.map((d) => d.key)).not.toContain("SRE-9");
  });

  it("link writes an operator link (board + record) and removes the suggestion; nothing auto-links", async () => {
    await load({ jiraEnabled: true });
    expect((await plan()).suggestions).toEqual([{ threadId: "z", key: "PT-3570", why: "fuzzy" }]);
    expect(metadata.get("z")).toBeUndefined();
    expect(await act({ action: "link", key: "PT-3570", threadId: "z" })).toEqual({ ok: true });
    expect(metadata.get("z")?.linkedIssues).toEqual([expect.objectContaining({ jira: { key: "PT-3570" }, source: "operator" })]);
    expect((metadata.get("z")?.jira as { links: unknown[] }).links).toEqual([{ key: "PT-3570", role: "owner", source: "operator" }]);
    expect((await plan()).suggestions).toEqual([]);
    expect(await act({ action: "link", key: "PT-3570", threadId: "nope" })).toEqual({ ok: false, error: "unknown thread" });
  });

  it("dismiss-suggestion removes it and it stays dismissed after a newer snapshot", async () => {
    await load({ jiraEnabled: true });
    await plan();
    expect(await act({ action: "dismiss-suggestion", key: "PT-3570", threadId: "z" })).toEqual({ ok: true });
    expect((await plan()).suggestions).toEqual([]);
    await host.bb.storage.kv.set("jira:snapshot", { ...snapshot, takenAt: "2026-10-29T13:00:00Z" });
    expect((await plan()).suggestions).toEqual([]);
    expect(metadata.get("z")).toBeUndefined();
  });

  it("fix todo-with-prs: transition to indeterminate plus a plain comment listing the PR URLs", async () => {
    await load({ jiraEnabled: true });
    expect(await act({ action: "fix", key: "PT-3879", kind: "todo-with-prs" })).toEqual({ ok: true });
    const ops = await queue();
    expect(ops).toEqual([
      expect.objectContaining({ op: "transition", key: "PT-3879", toCategory: "indeterminate" }),
      expect.objectContaining({ op: "comment", key: "PT-3879", body: expect.stringContaining("https://github.com/growtherapy/infra/pull/42") }),
    ]);
    expect((ops[1] as { body: string }).body).not.toMatch(/[`$|;&]/);
  });

  it("fix refuses drift that is not there; all-done-still-open is not yet", async () => {
    await load({ jiraEnabled: true });
    expect(await act({ action: "fix", key: "PT-3570", kind: "todo-with-prs" })).toEqual({ ok: false, error: "no such drift" });
    expect(await act({ action: "fix", key: "PT-3570", kind: "all-done-still-open" })).toEqual({ ok: false, error: "not yet" });
    expect(await queue()).toEqual([]);
  });

  it("Give back without confirm queues nothing", async () => {
    await load({ jiraEnabled: true });
    expect(await act({ action: "fix", key: "SRE-9", kind: "stale-unlinked" })).toEqual({ ok: false, error: "confirm required" });
    expect(await queue()).toEqual([]);
  });

  it("the same fix twice queues only the first fix's ops (even concurrently)", async () => {
    await load({ jiraEnabled: true });
    const [a, b] = await Promise.all([
      act({ action: "fix", key: "PT-3879", kind: "todo-with-prs" }),
      act({ action: "fix", key: "PT-3879", kind: "todo-with-prs" }),
    ]);
    expect([a, b]).toEqual([{ ok: true }, { ok: true, alreadyQueued: true }]);
    expect((await queue()).map((o) => o.op)).toEqual(["transition", "comment"]);
    await act({ action: "fix", key: "SRE-9", kind: "stale-unlinked", confirm: true });
    expect(await act({ action: "fix", key: "SRE-9", kind: "stale-unlinked", confirm: true })).toEqual({ ok: true, alreadyQueued: true });
    expect((await queue()).map((o) => o.op)).toEqual(["transition", "comment", "comment", "assign"]);
  });

  it("started refuses an unknown thread and does not re-queue the transition", async () => {
    await load({ jiraEnabled: true });
    expect(await act({ action: "started", key: "SRE-10", threadId: "nope" })).toEqual({ ok: false, error: "unknown thread" });
    expect(await queue()).toEqual([]);
    await act({ action: "started", key: "SRE-10", threadId: "z" });
    expect(await act({ action: "started", key: "SRE-10", threadId: "pg" })).toEqual({ ok: true, alreadyQueued: true });
    expect(await queue()).toHaveLength(1);
  });

  it("fix stale-unlinked (Give back): a comment then assign none", async () => {
    await load({ jiraEnabled: true });
    expect(await act({ action: "fix", key: "SRE-9", kind: "stale-unlinked", confirm: true })).toEqual({ ok: true });
    expect(await queue()).toEqual([
      expect.objectContaining({ op: "comment", key: "SRE-9", body: expect.any(String) }),
      expect.objectContaining({ op: "assign", key: "SRE-9", to: "none" }),
    ]);
  });

  it("started: links the thread, and transitions only a ticket in new", async () => {
    await load({ jiraEnabled: true });
    expect(await act({ action: "started", key: "SRE-10", threadId: "z" })).toEqual({ ok: true });
    expect(metadata.get("z")?.linkedIssues).toEqual([expect.objectContaining({ jira: { key: "SRE-10" }, source: "operator" })]);
    expect(await act({ action: "started", key: "PT-3570", threadId: "pg" })).toEqual({ ok: true });
    expect(await queue()).toEqual([expect.objectContaining({ op: "transition", key: "SRE-10", toCategory: "indeterminate", threadId: "z" })]);
  });
});
