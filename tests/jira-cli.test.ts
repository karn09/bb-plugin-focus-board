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
    const host = createFakePluginHost({
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
