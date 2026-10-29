// Task 9: ticket-matching instructions (agents.configure), the
// focus_board_jira_link / focus_board_spawn_child tools, and the
// find-ticket / promote-epic card actions.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import server from "../server";

const ticket = (key: string, isEpic = false) => ({
  key, summary: "s", status: "In Progress", statusCategory: "indeterminate", assignee: null, assignedToMe: true, issueType: isEpic ? "Epic" : "Task", isEpic,
  parentKey: null, epicKey: null, openChildren: 0, updatedAt: "2026-10-29T00:00:00Z", url: `https://x/browse/${key}`,
});
const snap = (tickets: object[]) => ({ version: 1, takenAt: new Date().toISOString(), ok: true, error: null, me: { accountId: "a" }, tickets, prs: [], mentions: [] });
const rec = (over: object = {}) => ({ links: [], enrolledAt: null, verifying: null, doneCheck: null, nudgedAt: null, deepCheckedAt: null, reason: null, checkInWith: null, ...over });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("jira agent side", () => {
  let harness: FakePluginHarness;
  const metadata = new Map<string, Record<string, unknown>>();
  const titles = new Map<string, string>();
  const children: ReturnType<typeof makeThreadResponse>[] = [];
  const status = new Map<string, string>();
  let spawn: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let send: ReturnType<typeof vi.fn>;

  async function load(settings: Record<string, unknown>, tickets: object[] = []) {
    metadata.clear();
    titles.clear();
    children.length = 0;
    status.clear();
    let n = 0;
    spawn = vi.fn(async (args: { parentThreadId: string; title?: string }) => {
      const row = makeThreadResponse({ id: `child${++n}`, parentThreadId: args.parentThreadId, title: args.title ?? null });
      children.push(row);
      return row;
    });
    update = vi.fn(async ({ threadId, title }: { threadId: string; title: string }) => {
      titles.set(threadId, title);
      return {};
    });
    send = vi.fn(async () => ({}));
    const host = createFakePluginHost({
      pluginId: "focus-board",
      settings: settings as never,
      sdk: {
        threads: {
          list: async (args?: { archived?: boolean }) => (args?.archived ? [] : [makeThreadResponse({ id: "t1" }), ...children]),
          get: async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({ id: threadId, title: titles.get(threadId) ?? null, status: (status.get(threadId) ?? "idle") as never }),
          update,
          spawn,
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
    await host.bb.storage.kv.set("jira:enabled-seen", true);
    await host.bb.storage.kv.set("jira:snapshot", snap(tickets));
    titles.set("t1", "Investigate slack thread");
    await server(host.bb);
    await flush();
  }
  afterEach(async () => {
    await harness.lifecycle.dispose();
  });
  const configure = (pluginMetadata: Record<string, unknown> = {}) =>
    harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata } as never));
  const jiraOf = (id: string) => metadata.get(id)?.jira as Record<string, any> | undefined;
  const link = (input: object, threadId = "t1") => harness.callAgentTool("focus_board_jira_link", input, { threadId, projectId: "p1" });
  const text = (r: { content: { text?: string }[] } | string) => (typeof r === "string" ? r : r.content.map((c) => c.text ?? "").join(""));

  it("configure, unlinked thread: matching instructions with the default project quoted", async () => {
    await load({ jiraEnabled: true });
    const c = await configure();
    expect(c.instructions).toContain("before creating a branch");
    expect(c.instructions).toContain('"SRE"');
    expect(c.instructions).toContain("project in (PT,SRE)");
    expect(c.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["focus_board_link_issue", "focus_board_group_set", "focus_board_jira_link", "focus_board_spawn_child"]));
  });

  it("configure, linked thread: the quoted key and the spawn rule", async () => {
    await load({ jiraEnabled: true });
    const c = await configure({ jira: rec({ links: [{ key: "PT-9", role: "owner", source: "agent" }] }) });
    expect(c.instructions).toContain('"PT-9"');
    expect(c.instructions).toContain("focus_board_spawn_child");
    expect(c.instructions).not.toContain("before creating a branch");
  });

  it("configure with Jira off: no jira tools, no instructions; the board's own tools stay", async () => {
    await load({ jiraEnabled: false });
    const c = await configure();
    expect(c.tools.map((t) => t.name).sort()).toEqual(["focus_board_group_set", "focus_board_link_issue"]);
    expect(c.instructions).toBeNull();
  });

  it("configure follows a settings flip", async () => {
    await load({ jiraEnabled: false });
    await harness.behavior.setSettings({ jiraEnabled: true });
    await flush();
    expect((await configure()).tools.map((t) => t.name)).toContain("focus_board_jira_link");
  });

  it("tools with Jira off: error, nothing written", async () => {
    await load({ jiraEnabled: false });
    const r = await link({ key: "PT-9", role: "owner", claimed: true });
    expect(r).toMatchObject({ isError: true });
    expect(text(r as never)).toContain("Jira is off");
    expect(jiraOf("t1")).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    const s = await harness.callAgentTool("focus_board_spawn_child", { title: "c", prompt: "p", ticketKey: "PT-10" }, { threadId: "t1", projectId: "p1" });
    expect(s).toMatchObject({ isError: true });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("jira_link rejects a bad key and writes nothing", async () => {
    await load({ jiraEnabled: true });
    await expect(link({ key: "PT-1; rm -rf", role: "owner", claimed: true })).rejects.toThrow();
    expect(jiraOf("t1")).toBeUndefined();
    expect(metadata.get("t1")?.linkedIssues).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it("owner link: record link (agent), board chip, title prefixed", async () => {
    await load({ jiraEnabled: true });
    const r = await link({ key: "PT-9", role: "owner", claimed: true });
    expect(jiraOf("t1")!.links).toEqual([{ key: "PT-9", role: "owner", source: "agent" }]);
    expect(metadata.get("t1")!.linkedIssues).toEqual([expect.objectContaining({ tracker: "external", source: "agent", jira: { key: "PT-9" } })]);
    expect(update).toHaveBeenCalledWith({ threadId: "t1", title: "PT-9: Investigate slack thread" });
    expect(text(r as never)).not.toMatch(/stop/i);
  });

  it("unclaimed owner link reminds the agent to claim it", async () => {
    await load({ jiraEnabled: true });
    expect(text((await link({ key: "PT-9", role: "owner", claimed: false })) as never)).toContain("acli");
  });

  it("a title already carrying the key is left alone", async () => {
    await load({ jiraEnabled: true });
    titles.set("t1", "Fix PT-9 flake");
    await link({ key: "PT-9", role: "owner", claimed: true });
    expect(update).not.toHaveBeenCalled();
  });

  it("watching: checkInWith set, the reply says stop", async () => {
    await load({ jiraEnabled: true });
    const r = await link({ key: "PT-9", role: "watching", ownerName: "Sam", claimed: false });
    expect(jiraOf("t1")!.checkInWith).toBe("Sam");
    expect(jiraOf("t1")!.links).toEqual([{ key: "PT-9", role: "watching", source: "agent" }]);
    expect(text(r as never)).toMatch(/\bstop\b/);
  });

  it("watching needs ownerName", async () => {
    await load({ jiraEnabled: true });
    await expect(link({ key: "PT-9", role: "watching", claimed: false })).rejects.toThrow();
  });

  it("spawn_child: exact pluginMetadata; the second child under a non-epic suggests promotion", async () => {
    await load({ jiraEnabled: true }, [ticket("PT-9")]);
    metadata.set("t1", { jira: rec({ links: [{ key: "PT-9", role: "owner", source: "agent" }] }) });
    const spawnChild = (k: string) => harness.callAgentTool("focus_board_spawn_child", { title: "Child work", prompt: "do it", ticketKey: k }, { threadId: "t1", projectId: "p1" });
    await spawnChild("PT-10");
    const args = spawn.mock.calls[0]![0] as Record<string, any>;
    expect(args).toMatchObject({ parentThreadId: "t1", projectId: "p1", prompt: "do it", title: "PT-10: Child work" });
    expect(args.pluginMetadata).toEqual({
      jira: rec({ links: [{ key: "PT-10", role: "owner", source: "agent" }], enrolledAt: expect.any(String) }),
    });
    expect(Date.parse(args.pluginMetadata.jira.enrolledAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(jiraOf("t1")!.epicSuggested).toBeUndefined();
    await spawnChild("PT-11");
    expect(jiraOf("t1")!.epicSuggested).toBe(true);
    await spawnChild("PT-12");
    expect(jiraOf("t1")!.epicSuggested).toBe(true);
  });

  it("spawn_child under an epic never suggests promotion", async () => {
    await load({ jiraEnabled: true }, [ticket("PT-9", true)]);
    metadata.set("t1", { jira: rec({ links: [{ key: "PT-9", role: "owner", source: "agent" }] }) });
    for (const k of ["PT-10", "PT-11", "PT-12"]) {
      await harness.callAgentTool("focus_board_spawn_child", { title: "c", prompt: "p", ticketKey: k }, { threadId: "t1", projectId: "p1" });
    }
    expect(jiraOf("t1")!.epicSuggested).toBeUndefined();
  });

  it("spawn_child rejects a bad ticketKey", async () => {
    await load({ jiraEnabled: true });
    await expect(harness.callAgentTool("focus_board_spawn_child", { title: "c", prompt: "p", ticketKey: "nope" }, { threadId: "t1", projectId: "p1" })).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("find-ticket card action: an idle thread gets the matching turn", async () => {
    await load({ jiraEnabled: true });
    expect(await harness.behavior.callRpc("jira_card_action", { kind: "find-ticket", threadId: "t1" })).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
    const sent = (send.mock.calls[0]![0] as { input: { text: string }[] }).input[0]!.text;
    expect(sent).toContain("before creating a branch");
  });

  it("find-ticket on a busy thread waits for idle", async () => {
    await load({ jiraEnabled: true });
    status.set("t1", "active");
    expect(await harness.behavior.callRpc("jira_card_action", { kind: "find-ticket", threadId: "t1" })).toEqual({ ok: true });
    expect(send).not.toHaveBeenCalled();
    status.set("t1", "idle");
    await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "t1" }), lastAssistantText: null });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it("find-ticket: a failed send is an error, not a silent drop", async () => {
    await load({ jiraEnabled: true });
    send.mockRejectedValueOnce(new Error("boom"));
    expect(await harness.behavior.callRpc("jira_card_action", { kind: "find-ticket", threadId: "t1" })).toEqual({ ok: false, error: expect.stringContaining("boom") });
  });

  it("promote-epic: changes nothing until clicked; the click asks the agent and clears the suggestion", async () => {
    await load({ jiraEnabled: true });
    metadata.set("t1", { jira: rec({ links: [{ key: "PT-9", role: "owner", source: "agent" }], epicSuggested: true }) });
    expect(send).not.toHaveBeenCalled();
    expect(await harness.behavior.callRpc("jira_card_action", { kind: "promote-epic", threadId: "t1" })).toEqual({ ok: true });
    const sent = (send.mock.calls[0]![0] as { input: { text: string }[] }).input[0]!.text;
    expect(sent).toContain('"PT-9"');
    expect(sent).toContain("acli");
    expect(jiraOf("t1")!.epicSuggested).toBeUndefined();
    expect(jiraOf("t1")!.links).toHaveLength(1);
  });

  it("promote-epic without a suggestion is refused", async () => {
    await load({ jiraEnabled: true });
    metadata.set("t1", { jira: rec({ links: [{ key: "PT-9", role: "owner", source: "agent" }] }) });
    expect(await harness.behavior.callRpc("jira_card_action", { kind: "promote-epic", threadId: "t1" })).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
  });
});
