// Runs scripts/jira-sync.mjs against stub acli/gh/bb executables on PATH.
// Stubs log argv (+ the content of any --file) and answer from rules in <name>.rules.json.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { JiraSnapshot, OpResult } from "../lib/jira-schema";
// @ts-expect-error plain .mjs
import { toTicket } from "../scripts/jira-sync.mjs";

const STUB = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const dir = process.env.STUB_DIR, name = path.basename(process.argv[1]);
const argv = process.argv.slice(2);
const i = argv.indexOf("--file");
const file = i >= 0 ? fs.readFileSync(argv[i + 1], "utf8") : null;
fs.appendFileSync(path.join(dir, name + ".log"), JSON.stringify({ argv, file }) + "\\n");
const rp = path.join(dir, name + ".rules.json");
const rules = fs.existsSync(rp) ? JSON.parse(fs.readFileSync(rp, "utf8")) : [];
const line = argv.join(" ");
const r = rules.find((r) => line.includes(r.match)) || { stdout: "" };
if (r.stderr) process.stderr.write(r.stderr);
process.stdout.write(r.stdout ?? "");
process.exit(r.code ?? 0);
`;

let dir: string;
const rules = (name: string, r: object[]) => writeFileSync(join(dir, `${name}.rules.json`), JSON.stringify(r));
const calls = (name: string): { argv: string[]; file: string | null }[] => {
  const p = join(dir, `${name}.log`);
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const run = () =>
  execFileSync("node", [join(__dirname, "../scripts/jira-sync.mjs")], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_DIR: dir },
    encoding: "utf8",
  });
const ingested = () => JSON.parse(calls("bb").find((c) => c.argv.includes("ingest"))!.file!);
const acks = () => calls("bb").filter((c) => c.argv.includes("ack")).map((c) => JSON.parse(c.file!));
const op = (o: object) => ({ id: "op1", createdAt: "2026-10-29T00:00:00Z", threadId: null, ...o });
const wanted = { projects: ["ENG"], linkedKeys: [], prRefs: [], branchHeads: [] };
const issue = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  self: "https://x.atlassian.net/rest/api/3/issue/1",
  fields: {
    summary: `s ${key}`,
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    assignee: { accountId: "me1", displayName: "Me" },
    issuetype: { name: "Task" },
    updated: "2026-10-29T00:00:00.000+0000",
    ...over,
  },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jira-sync-"));
  for (const n of ["acli", "gh", "bb"]) {
    writeFileSync(join(dir, n), STUB);
    chmodSync(join(dir, n), 0o755);
  }
  rules("bb", [
    { match: "jira wanted", stdout: JSON.stringify(wanted) },
    { match: "jira queue", stdout: JSON.stringify({ ops: [] }) },
  ]);
});

describe("toTicket", () => {
  it("maps a REST v3 shaped issue", () => {
    const t = toTicket(issue("ENG-1", { parent: { key: "ENG-9", fields: { issuetype: { name: "Epic" } } } }), "me1");
    expect(t).toMatchObject({
      key: "ENG-1", summary: "s ENG-1", status: "In Progress", statusCategory: "indeterminate",
      assignee: { accountId: "me1", displayName: "Me" }, assignedToMe: true, issueType: "Task",
      isEpic: false, parentKey: "ENG-9", epicKey: "ENG-9", openChildren: 0,
      url: "https://x.atlassian.net/browse/ENG-1",
    });
    expect(toTicket(issue("ENG-2", { assignee: null }), "me1")).toMatchObject({ assignee: null, assignedToMe: false });
    expect(toTicket(issue("ENG-3", { issuetype: { name: "Epic" } }), "")).toMatchObject({ isEpic: true });
  });
});

describe("jira-sync.mjs", () => {
  it("emits a snapshot that parses with the real schema", () => {
    rules("acli", [
      { match: "assignee = currentUser()", stdout: JSON.stringify([issue("ENG-1"), issue("ENG-2", { issuetype: { name: "Epic" } })]) },
      { match: "parent in", stdout: JSON.stringify([issue("ENG-5", { parent: { key: "ENG-2" } })]) },
    ]);
    run();
    const snap = JiraSnapshot.parse(ingested());
    expect(snap.ok).toBe(true);
    expect(snap.me.accountId).toBe("me1");
    expect(snap.tickets.find((t) => t.key === "ENG-2")!.openChildren).toBe(1);
    expect(snap.tickets.every((t) => t.assignedToMe)).toBe(true);
  });

  it("fetches PRs and mentions", () => {
    rules("bb", [
      { match: "jira wanted", stdout: JSON.stringify({ ...wanted, linkedKeys: ["ENG-1"], prRefs: [{ repo: "o/r", number: 7 }] }) },
      { match: "jira queue", stdout: JSON.stringify({ ops: [] }) },
    ]);
    rules("acli", [{ match: "search", stdout: JSON.stringify([issue("ENG-1")]) }]);
    rules("gh", [
      { match: "pr view", stdout: JSON.stringify({ state: "OPEN", mergedAt: null, headRefName: "b", title: "t", body: "ENG-1", reviewDecision: "APPROVED", updatedAt: "2026-10-29T00:00:00Z", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }) },
      { match: "search prs", stdout: JSON.stringify([{ repository: { nameWithOwner: "o/r" }, number: 3, closedAt: "2026-10-28T00:00:00Z" }]) },
    ]);
    run();
    const snap = JiraSnapshot.parse(ingested());
    expect(snap.prs).toEqual([expect.objectContaining({ repo: "o/r", number: 7, state: "open", checks: "pass", reviewDecision: "approved" })]);
    expect(snap.mentions).toEqual([{ key: "ENG-1", repo: "o/r", number: 3, mergedAt: "2026-10-28T00:00:00Z" }]);
    expect(snap.tickets).toHaveLength(1);
  });

  it("transition op on a Done ticket makes no transition call, acks ok", () => {
    rules("bb", [
      { match: "jira wanted", stdout: JSON.stringify(wanted) },
      { match: "jira queue", stdout: JSON.stringify({ ops: [op({ op: "transition", key: "ENG-1", toCategory: "done" })] }) },
    ]);
    rules("acli", [{ match: "workitem view", stdout: JSON.stringify(issue("ENG-1", { status: { name: "Done", statusCategory: { key: "done" } } })) }]);
    run();
    expect(calls("acli").some((c) => c.argv.includes("transition"))).toBe(false);
    expect(OpResult.array().parse(acks()[0])).toEqual([{ id: "op1", ok: true, error: null, createdKey: null }]);
  });

  it("transition op moves a non-Done ticket by status name", () => {
    rules("bb", [
      { match: "jira wanted", stdout: JSON.stringify(wanted) },
      { match: "jira queue", stdout: JSON.stringify({ ops: [op({ op: "transition", key: "ENG-1", toCategory: "done" })] }) },
    ]);
    rules("acli", [{ match: "workitem view", stdout: JSON.stringify(issue("ENG-1")) }]);
    run();
    const t = calls("acli").find((c) => c.argv.includes("transition"))!;
    expect(t.argv).toEqual(expect.arrayContaining(["--key", "ENG-1", "--status", "Done", "--yes"]));
    expect(acks()[0][0].ok).toBe(true);
  });

  it("comment op skips when the marker already exists", () => {
    rules("bb", [
      { match: "jira wanted", stdout: JSON.stringify(wanted) },
      { match: "jira queue", stdout: JSON.stringify({ ops: [op({ op: "comment", key: "ENG-1", body: "hi" })] }) },
    ]);
    rules("acli", [{ match: "comment list", stdout: JSON.stringify({ comments: [{ body: "hi\n\n[fb:op1]" }] }) }]);
    run();
    expect(calls("acli").some((c) => c.argv.includes("create"))).toBe(false);
    expect(acks()[0][0].ok).toBe(true);
  });

  it("comment op posts body with marker when absent", () => {
    rules("bb", [
      { match: "jira wanted", stdout: JSON.stringify(wanted) },
      { match: "jira queue", stdout: JSON.stringify({ ops: [op({ op: "comment", key: "ENG-1", body: "hi" })] }) },
    ]);
    rules("acli", [{ match: "comment list", stdout: "[]" }]);
    run();
    const c = calls("acli").find((c) => c.argv.includes("comment") && c.argv.includes("create"))!;
    expect(c.argv[c.argv.indexOf("--body") + 1]).toBe("hi\n\n[fb:op1]");
  });

  it("assign me / none and create", () => {
    rules("bb", [
      { match: "jira wanted", stdout: JSON.stringify(wanted) },
      { match: "jira queue", stdout: JSON.stringify({ ops: [
        op({ id: "a", op: "assign", key: "ENG-1", to: "me" }),
        op({ id: "b", op: "assign", key: "ENG-1", to: "none" }),
        op({ id: "c", op: "create", project: "ENG", issueType: "Task", summary: "S", description: "D", parentKey: "ENG-2" }),
      ] }) },
    ]);
    rules("acli", [{ match: "workitem create", stdout: JSON.stringify({ key: "ENG-77" }) }]);
    run();
    const a = calls("acli").filter((c) => c.argv.includes("assign"));
    expect(a[0].argv).toEqual(expect.arrayContaining(["--assignee", "@me"]));
    expect(a[1].argv).toContain("--remove-assignee");
    expect(acks().flat()).toEqual([
      { id: "a", ok: true, error: null, createdKey: null },
      { id: "b", ok: true, error: null, createdKey: null },
      { id: "c", ok: true, error: null, createdKey: "ENG-77" },
    ]);
  });

  it("a failing op acks ok:false with the error", () => {
    rules("bb", [
      { match: "jira wanted", stdout: JSON.stringify(wanted) },
      { match: "jira queue", stdout: JSON.stringify({ ops: [op({ op: "assign", key: "ENG-1", to: "me" })] }) },
    ]);
    rules("acli", [{ match: "assign", code: 1, stderr: "boom" }]);
    run();
    expect(acks()[0][0]).toMatchObject({ ok: false, error: expect.stringContaining("boom") });
  });

  it("acli auth failure ingests ok:false with the error", () => {
    rules("acli", [{ match: "search", code: 1, stderr: "unauthorized: please login" }]);
    run();
    const snap = JiraSnapshot.parse(ingested());
    expect(snap.ok).toBe(false);
    expect(snap.error).toContain("unauthorized");
  });

  it("gh failure ingests tickets with prs [] and an error", () => {
    rules("bb", [
      { match: "jira wanted", stdout: JSON.stringify({ ...wanted, prRefs: [{ repo: "o/r", number: 7 }] }) },
      { match: "jira queue", stdout: JSON.stringify({ ops: [] }) },
    ]);
    rules("acli", [{ match: "search", stdout: JSON.stringify([issue("ENG-1")]) }]);
    rules("gh", [{ match: "", code: 1, stderr: "gh: not logged in" }]);
    run();
    const snap = JiraSnapshot.parse(ingested());
    expect(snap.prs).toEqual([]);
    expect(snap.error).toBeTruthy();
    expect(snap.tickets).toHaveLength(1);
  });

  it("never passes a space-joined command as one argv entry", () => {
    rules("bb", [
      { match: "jira wanted", stdout: JSON.stringify({ ...wanted, linkedKeys: ["ENG-1"], prRefs: [{ repo: "o/r", number: 7 }] }) },
      { match: "jira queue", stdout: JSON.stringify({ ops: [op({ op: "comment", key: "ENG-1", body: "x" })] }) },
    ]);
    run();
    const heads = new Set(["acli", "gh", "bb", "jira", "workitem", "search", "pr", "view"]);
    for (const n of ["acli", "gh", "bb"])
      for (const c of calls(n))
        for (const a of c.argv) expect(heads.has(a.split(" ")[0]) && a.includes(" ")).toBe(false);
  });
});
