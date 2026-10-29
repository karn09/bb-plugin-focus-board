import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import server from "../server";

const snap = (ageMs: number) => ({
  version: 1, takenAt: new Date(Date.now() - ageMs).toISOString(), ok: true, error: null, me: { accountId: "a" },
  tickets: [{ key: "PT-1", summary: "s", status: "In Progress", statusCategory: "indeterminate", assignee: null, assignedToMe: true, issueType: "Task", isEpic: false, parentKey: null, epicKey: null, openChildren: 0, updatedAt: "2026-10-29T00:00:00Z", url: "https://x/browse/PT-1" }],
  prs: [], mentions: [],
});
const rec = (over: object = {}) => ({ links: [{ key: "PT-1", role: "owner", source: "auto" }], enrolledAt: null, verifying: null, doneCheck: null, nudgedAt: null, deepCheckedAt: null, reason: null, checkInWith: "Sam", ...over });

describe("jira_board_state / jira_card_action", () => {
  let harness: FakePluginHarness;
  const metadata = new Map<string, Record<string, unknown>>();
  async function load(settings: Record<string, unknown>) {
    metadata.clear();
    const host = createFakePluginHost({
      pluginId: "focus-board",
      settings: settings as never,
      sdk: {
        threads: {
          list: async (args?: { archived?: boolean }) => (args?.archived ? [] : [makeThreadResponse({ id: "t1" })]),
          getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {},
          updatePluginMetadata: async ({ threadId, set }: { threadId: string; set?: Record<string, unknown> }) => {
            metadata.set(threadId, { ...(metadata.get(threadId) ?? {}), ...(set ?? {}) });
            return metadata.get(threadId);
          },
        } as never,
      },
    });
    harness = host.harness;
    await host.bb.storage.kv.set("jira:enabled-seen", true);
    await host.bb.storage.kv.set("jira:snapshot", snap(5 * 60_000));
    metadata.set("t1", { jira: rec() });
    await server(host.bb);
  }
  afterEach(async () => {
    await harness.lifecycle.dispose();
  });
  const state = () => harness.behavior.callRpc("jira_board_state", null) as Promise<any>;

  it("disabled: cheap { enabled: false } with nothing else", async () => {
    await load({ jiraEnabled: false });
    const s = await state();
    expect(s.enabled).toBe(false);
    expect(s.tickets).toEqual([]);
    expect(s.threads).toEqual({});
  });

  it("enabled: tickets, thread records, pending ops", async () => {
    await load({ jiraEnabled: true });
    await harness.behavior.runCli(["jira", "queue"]);
    const s = await state();
    expect(s.enabled).toBe(true);
    expect(s.tickets[0].key).toBe("PT-1");
    expect(s.threads.t1.checkInWith).toBe("Sam");
    expect(s.snapshotAge).toBeGreaterThan(0);
  });

  it("stale follows the live jiraRefreshMinutes setting, no status call first", async () => {
    await load({ jiraEnabled: true, jiraRefreshMinutes: 10 });
    expect((await state()).stale).toBe(false);
    await harness.behavior.setSettings({ jiraRefreshMinutes: 2 });
    expect((await state()).stale).toBe(true);
  });

  it("clear-check-in clears checkInWith, publishes jira-changed; other kinds are not yet", async () => {
    await load({ jiraEnabled: true });
    const r = await harness.behavior.callRpc("jira_card_action", { kind: "clear-check-in", threadId: "t1" });
    expect(r).toEqual({ ok: true });
    expect((metadata.get("t1")!.jira as { checkInWith: unknown }).checkInWith).toBeNull();
    expect(harness.inspection.realtimeSignals.some((s) => s.channel === "jira-changed")).toBe(true);
    expect(await harness.behavior.callRpc("jira_card_action", { kind: "find-ticket", threadId: "t1" })).toEqual({ ok: false, error: "not yet" });
  });

  it("ingest, enqueue, ack and thread writes publish jira-changed", async () => {
    await load({ jiraEnabled: true });
    const changed = () => harness.inspection.realtimeSignals.filter((s) => s.channel === "jira-changed").length;
    const before = changed();
    await harness.behavior.runCli(["jira", "ingest", "--file", "/nonexistent"]); // fails: no signal
    expect(changed()).toBe(before);
    const { createJiraStore } = await import("../lib/jira-store");
    let n = 0;
    const s = createJiraStore({ get: async () => null, set: async () => {} }, { getPluginMetadata: async () => ({}), updatePluginMetadata: async () => {} }, Date.now, { onChange: () => { n++; } });
    const op = await s.enqueue({ op: "comment", key: "PT-1", body: "x", threadId: null });
    await s.ingestSnapshot(snap(0));
    await s.writeThread("t1", { reason: "r" });
    await s.ack([{ id: op.id, ok: true, error: null, createdKey: null }]);
    expect(n).toBe(3); // ack of an op not in this store's kv is a no-op
  });
});
