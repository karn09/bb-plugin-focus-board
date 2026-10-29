import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import server from "../server";

const link = (url: string, key?: string) => ({
  tracker: "external", url, hostname: "x.atlassian.net", createdAt: "2026-10-29T00:00:00Z", source: "operator",
  ...(key ? { jira: { key } } : {}),
});
const ghPull = (n: number) => ({
  tracker: "github", repo: "o/r", issue: n, kind: "pull",
  href: `https://github.com/o/r/pull/${n}`, createdAt: "2026-10-29T00:00:00Z", source: "operator",
});
const fixture = (over: object = {}) => ({
  version: 1, takenAt: new Date().toISOString(), ok: true, error: null, me: { accountId: "a" },
  tickets: [], prs: [], mentions: [], ...over,
});

describe("bb focus-board jira CLI", () => {
  let harness: FakePluginHarness;
  let host: ReturnType<typeof createFakePluginHost>;
  const metadata = new Map<string, Record<string, unknown>>();
  let threads: ReturnType<typeof makeThreadResponse>[] = [];
  const dir = mkdtempSync(join(tmpdir(), "jira-cli-"));
  const file = (name: string, v: unknown) => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(v));
    return p;
  };

  async function load() {
    metadata.clear();
    threads = [];
    host = createFakePluginHost({
      pluginId: "focus-board",
      sdk: {
        threads: {
          list: async (args?: { archived?: boolean }) => (args?.archived ? [] : threads),
          getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {},
          updatePluginMetadata: async ({ threadId, set }: { threadId: string; set?: Record<string, unknown> }) => {
            metadata.set(threadId, { ...(metadata.get(threadId) ?? {}), ...(set ?? {}) });
            return metadata.get(threadId);
          },
        },
      },
    });
    harness = host.harness;
    await server(host.bb);
  }
  afterEach(async () => {
    await harness.lifecycle.dispose();
  });

  it("ingest then status prints ok, age 0s", async () => {
    await load();
    const r = await harness.behavior.runCli(["jira", "ingest", "--file", file("s.json", fixture())]);
    expect(r.exitCode).toBe(0);
    const s = await harness.behavior.runCli(["jira", "status"]);
    expect(s.stdout).toContain("ok, age 0s");
  });

  it("ingest of {} exits 1", async () => {
    await load();
    const r = await harness.behavior.runCli(["jira", "ingest", "--file", file("bad.json", {})]);
    expect(r.exitCode).toBe(1);
  });

  it("wanted lists PT-3879 once when two threads link it, plus PR refs", async () => {
    await load();
    threads = [makeThreadResponse({ id: "t1" }), makeThreadResponse({ id: "t2" })];
    metadata.set("t1", { linkedIssues: [link("https://x.atlassian.net/browse/PT-3879", "PT-3879"), ghPull(7)] });
    metadata.set("t2", {
      linkedIssues: [link("https://x.atlassian.net/browse/PT-3879", "PT-3879")],
      jira: { links: [{ key: "SRE-5", role: "owner", source: "auto" }], enrolledAt: null, verifying: null, doneCheck: null, nudgedAt: null, deepCheckedAt: null, reason: null, checkInWith: null },
    });
    const r = await harness.behavior.runCli(["jira", "wanted", "--json"]);
    expect(r.exitCode).toBe(0);
    const w = JSON.parse(r.stdout);
    expect(w.linkedKeys.sort()).toEqual(["PT-3879", "SRE-5"]);
    expect(w.prRefs).toEqual([{ repo: "o/r", number: 7 }]);
    expect(w.projects).toEqual(["PT", "SRE"]);
    expect(w.branchHeads).toEqual([]);
  });

  it("wanted also lists configured-project keys from titles, branches and PR head refs (unassigned tickets auto-link)", async () => {
    await load();
    threads = [
      makeThreadResponse({ id: "t1", title: "PT-3893: tidy the runbook (UTF-8)", environmentBranchName: null } as never),
      makeThreadResponse({ id: "t2", title: "no key", environmentBranchName: "sre-12-alerts" } as never),
      makeThreadResponse({ id: "t3", title: "PR only", environmentBranchName: null } as never),
    ];
    metadata.set("t3", { linkedIssues: [ghPull(7)] });
    const pr = { repo: "o/r", number: 7, state: "open", headRef: "pt-3894-fix", title: "t", body: "", checks: "pass", reviewDecision: null, updatedAt: "2026-10-29T00:00:00Z" };
    await harness.behavior.runCli(["jira", "ingest", "--file", file("w.json", fixture({ prs: [pr] }))]);
    const w = JSON.parse((await harness.behavior.runCli(["jira", "wanted", "--json"])).stdout);
    expect(w.linkedKeys.sort()).toEqual(["PT-3893", "PT-3894", "SRE-12"]);
  });

  it("status shows a partial gh failure on an ok snapshot", async () => {
    await load();
    await harness.behavior.runCli(["jira", "ingest", "--file", file("p.json", fixture({ error: "gh: 1 of 2 PRs unreadable (boom)" }))]);
    const s = (await harness.behavior.runCli(["jira", "status"])).stdout;
    expect(s).toContain("ok");
    expect(s).toContain("gh: 1 of 2 PRs unreadable (boom)");
    expect(s).not.toContain("stale");
  });

  it("failed first snapshot: ingest and status surface the error", async () => {
    await load();
    const r = await harness.behavior.runCli(["jira", "ingest", "--file", file("f.json", { ok: false, error: "acli signed out" })]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ingested (failure: acli signed out)");
    expect((await harness.behavior.runCli(["jira", "status"])).stdout).toContain("acli signed out");
  });

  it("status staleness follows live settings without running status first", async () => {
    await load();
    const old = fixture({ takenAt: new Date(Date.now() - 5 * 60_000).toISOString() });
    await harness.behavior.runCli(["jira", "ingest", "--file", file("o.json", old)]);
    await harness.behavior.setSettings({ jiraRefreshMinutes: 10 });
    expect((await harness.behavior.runCli(["jira", "status"])).stdout).not.toContain("(stale)");
    await harness.behavior.setSettings({ jiraRefreshMinutes: 2 });
    expect((await harness.behavior.runCli(["jira", "status"])).stdout).toContain("(stale)");
  });

  it("rejects stdin, and invalid JSON leaves the stored snapshot unchanged", async () => {
    await load();
    await harness.behavior.runCli(["jira", "ingest", "--file", file("g.json", fixture())]);
    const dash = await harness.behavior.runCli(["jira", "ingest", "--file", "-"]);
    expect(dash.exitCode).toBe(1);
    expect(dash.stderr).toContain("stdin");
    const p = join(dir, "junk.json");
    writeFileSync(p, "{not json");
    expect((await harness.behavior.runCli(["jira", "ingest", "--file", p])).exitCode).toBe(1);
    expect((await harness.behavior.runCli(["jira", "status"])).stdout).toContain("ok, age 0s");
  });

  it("ack removes a pending op", async () => {
    await load();
    await harness.behavior.runCli(["jira", "ingest", "--file", file("h.json", fixture())]);
    await host.bb.storage.kv.set("jira:queue", [{ id: "op1", createdAt: "2026-10-29T00:00:00Z", threadId: null, op: "comment", key: "PT-1", body: "x" }]);
    expect(JSON.parse((await harness.behavior.runCli(["jira", "queue", "--json"])).stdout).ops).toHaveLength(1);
    await harness.behavior.runCli(["jira", "ack", "--file", file("k.json", [{ id: "op1", ok: true, error: null, createdKey: null }])]);
    expect(JSON.parse((await harness.behavior.runCli(["jira", "queue", "--json"])).stdout).ops).toEqual([]);
  });

  it("queue and ack round-trip", async () => {
    await load();
    const q = await harness.behavior.runCli(["jira", "queue", "--json"]);
    expect(JSON.parse(q.stdout)).toEqual({ ops: [] });
    const a = await harness.behavior.runCli(["jira", "ack", "--file", file("a.json", [{ id: "x", ok: true, error: null, createdKey: null }])]);
    expect(a.exitCode).toBe(0);
    const bad = await harness.behavior.runCli(["jira", "ack", "--file", file("b.json", [{ nope: 1 }])]);
    expect(bad.exitCode).toBe(1);
  });

  it("setup prints the automation command", async () => {
    await load();
    const r = await harness.behavior.runCli(["jira", "setup"]);
    expect(r.stdout).toContain('--cron "*/2 * * * *"');
    expect(r.stdout).toContain("jira-sync.mjs");
    expect(r.stdout).toContain("--project proj_personal");
  });
});
