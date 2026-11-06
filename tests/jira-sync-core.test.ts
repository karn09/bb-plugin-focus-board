// lib/jira-sync-core.ts against an injected fake runner (no executables).
// The fake answers from rules matched on "<tool> <args…>", logs every call,
// and reproduces acli's search field allowlist (refused fields fail the call).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JiraSnapshot, OpResult, type QueueOp } from "../lib/jira-schema";
import { createSyncCore, descriptionText, toTicket, type SyncWanted } from "../lib/jira-sync-core";

type Rule = { match: string; stdout?: string; fail?: string };
let rules: Record<"acli" | "gh", Rule[]>;
let calls: { tool: string; args: string[] }[];
let seq: string[];
let ops: QueueOp[];
let wanted: SyncWanted;
let acked: OpResult[][];
let ingested: unknown[];
let ackFails: boolean;
let claim: (id: string) => boolean;
let previous: JiraSnapshot | null;

// Real acli: `workitem search --fields` only accepts a fixed set (parent, updated, subtasks... are refused).
const SEARCH_OK = new Set(["key", "summary", "status", "assignee", "issuetype", "description", "priority", "labels"]);
const run = async (tool: "acli" | "gh", args: readonly string[]) => {
  calls.push({ tool, args: [...args] });
  const line = `${tool} ${args.join(" ")}`;
  seq.push(line);
  const fail = (stderr: string) => { throw new Error(`${tool} ${args[0] ?? ""} failed: ${stderr}`.slice(0, 500)); };
  const fi = args.indexOf("--fields");
  if (tool === "acli" && args.includes("search") && fi >= 0) {
    const bad = args[fi + 1]!.split(",").filter((f) => !SEARCH_OK.has(f));
    if (bad.length) fail(`✗ Error: fields '${bad.join(", ")}' are not allowed`);
  }
  const r = rules[tool].find((x) => line.includes(x.match)) ?? { match: "", stdout: "" };
  if (r.fail !== undefined) fail(r.fail);
  return r.stdout ?? "";
};
const core = () =>
  createSyncCore({
    run,
    previous: async () => previous,
    wanted: async () => wanted,
    pendingOps: async () => ops,
    claim: async (id) => claim(id),
    ack: async (r) => {
      seq.push(`ack ${r.map((x) => x.id).join(",")}`);
      if (ackFails) throw new Error("ack down");
      acked.push(r);
    },
    ingest: async (s) => void ingested.push(s),
  });
const pass = () => core().pass();
const snap = () => JiraSnapshot.parse(ingested.at(-1));
const acks = () => acked.flat();
const op = (o: object) => ({ id: "op1", createdAt: "2026-10-29T00:00:00Z", threadId: null, ...o }) as QueueOp;
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
const acliCalls = () => calls.filter((c) => c.tool === "acli").map((c) => c.args);

beforeEach(() => {
  rules = { acli: [], gh: [] };
  calls = [];
  seq = [];
  ops = [];
  wanted = { projects: ["ENG"], linkedKeys: [], prRefs: [], branchHeads: [], fullSync: true };
  acked = [];
  ingested = [];
  ackFails = false;
  claim = (id) => ops.some((o) => o.id === id);
  previous = null;
});

describe("toTicket", () => {
  it("derives category from status name when missing, and defaults the base url", () => {
    const noCat = (name: string) => toTicket(issue("ENG-1", { status: { name } }), "").statusCategory;
    expect([noCat("Done"), noCat("Closed"), noCat("To Do"), noCat("In Review")]).toEqual(["done", "done", "new", "indeterminate"]);
    const t = toTicket({ key: "ENG-1", fields: issue("ENG-1").fields }, "");
    expect(t.url).toBe("https://growtherapy.atlassian.net/browse/ENG-1");
  });

  it("maps a REST v3 shaped issue", () => {
    const t = toTicket(issue("ENG-1", { parent: { key: "ENG-9", fields: { issuetype: { name: "Epic" } } } }), "me1");
    expect(t).toMatchObject({
      key: "ENG-1", summary: "s ENG-1", status: "In Progress", statusCategory: "indeterminate",
      assignee: { accountId: "me1", displayName: "Me" }, assignedToMe: true, issueType: "Task",
      isEpic: false, parentKey: "ENG-9", epicKey: "ENG-9", openChildren: 0,
      // self points at an internal API host; browse links always use the site.
      url: "https://growtherapy.atlassian.net/browse/ENG-1",
    });
    expect(toTicket(issue("ENG-2", { assignee: null }), "me1")).toMatchObject({ assignee: null, assignedToMe: false });
    expect(toTicket(issue("ENG-3", { issuetype: { name: "Epic" } }), "")).toMatchObject({ isEpic: true });
  });
});

// A representative Jira REST v3 description (Atlassian Document Format).
const ADF = {
  type: "doc", version: 1,
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Goal" }] },
    { type: "paragraph", content: [{ type: "text", text: "Move the " }, { type: "text", text: "WAF", marks: [{ type: "strong" }] }, { type: "text", text: " rules." }] },
    { type: "bulletList", content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "plan" }] }] },
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "apply" }, { type: "hardBreak" }, { type: "text", text: "then verify" }] }] },
    ] },
    { type: "paragraph", content: [{ type: "mention", attrs: { id: "x", text: "@Sam" } }, { type: "text", text: " owns it" }] },
  ],
};

describe("descriptionText", () => {
  it("turns ADF into plain text: blocks on their own lines, list items as '- '", () => {
    expect(descriptionText(ADF)).toBe("Goal\n\nMove the WAF rules.\n\n- plan\n- apply\nthen verify\n\n@Sam owns it");
  });
  it("strings pass through; anything else (or empty) is omitted", () => {
    expect(descriptionText("  plain text  ")).toBe("plain text");
    expect(descriptionText(null)).toBeUndefined();
    expect(descriptionText(42)).toBeUndefined();
    expect(descriptionText({ foo: 1 })).toBeUndefined();
    expect(descriptionText({ type: "doc", content: [] })).toBeUndefined();
  });
  it("a 10,000-deep tree is cut at the depth cap instead of blowing the stack", () => {
    let deep: Record<string, unknown> = { type: "text", text: "bottom" };
    for (let i = 0; i < 10_000; i++) deep = { type: "blockquote", content: [deep] };
    expect(() => descriptionText({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "top" }] }, deep] })).not.toThrow();
    expect(descriptionText({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "top" }] }, deep] })).toBe("top");
  });
  it("a description that throws costs only the description, not the fetch", () => {
    const evil = { type: "doc", get content() { throw new Error("bad tree"); } };
    const t = toTicket(issue("ENG-1", { description: evil }), "me1");
    expect(t.key).toBe("ENG-1");
    expect(t).not.toHaveProperty("description");
  });
  it("caps at 2,000 chars with …", () => {
    const d = descriptionText("x".repeat(5_000))!;
    expect(d).toHaveLength(2_000);
    expect(d.endsWith("…")).toBe(true);
  });
});

describe("sync pass", () => {
  it("views ask for the description and the ticket carries it as plain text", async () => {
    rules.acli = [
      { match: "assignee = currentUser()", stdout: JSON.stringify([issue("ENG-1"), issue("ENG-2")]) },
      { match: "workitem view ENG-1", stdout: JSON.stringify(issue("ENG-1", { description: ADF })) },
    ];
    await pass();
    expect(acliCalls().filter((a) => a[3] === "view").every((a) => a.join(" ").includes("--fields parent,updated,description"))).toBe(true);
    const [one, two] = snap().tickets;
    expect(one!.description).toBe(descriptionText(ADF));
    expect(two).not.toHaveProperty("description");
  });

  it("ingests a snapshot that parses with the real schema", async () => {
    rules.acli = [
      { match: "assignee = currentUser()", stdout: JSON.stringify([issue("ENG-1"), issue("ENG-2", { issuetype: { name: "Epic" } })]) },
      { match: "parent = ENG-2", stdout: JSON.stringify([{ key: "ENG-5" }]) },
    ];
    await pass();
    const s = snap();
    expect(s.ok).toBe(true);
    expect(s.me.accountId).toBe("me1");
    expect(s.tickets.find((t) => t.key === "ENG-2")!.openChildren).toBe(1);
    expect(s.tickets.every((t) => t.assignedToMe)).toBe(true);
  });

  it("fullSync:false: drains the queue but fetches nothing and ingests nothing", async () => {
    wanted = { ...wanted, fullSync: false };
    ops = [op({ op: "assign", key: "ENG-1", to: "me" })];
    await pass();
    expect(acks()).toEqual([{ id: "op1", ok: true, error: null, createdKey: null }]);
    expect(calls.some((c) => c.args.includes("search"))).toBe(false);
    expect(ingested).toEqual([]);
  });

  it("asks search only for fields acli allows, and gets parent/updated from view", async () => {
    rules.acli = [
      { match: "assignee = currentUser()", stdout: JSON.stringify([issue("ENG-1", { updated: undefined })]) },
      { match: "workitem view ENG-1", stdout: JSON.stringify(issue("ENG-1", { parent: { key: "ENG-9", fields: { issuetype: { name: "Epic" } } }, updated: "2026-10-20T10:00:00.000-0400" })) },
      { match: "parent = ENG-1", stdout: JSON.stringify([{ key: "ENG-11" }, { key: "ENG-12" }]) },
    ];
    await pass();
    const s = snap();
    expect(s.ok).toBe(true);
    expect(s.tickets[0]).toMatchObject({ key: "ENG-1", parentKey: "ENG-9", epicKey: "ENG-9", updatedAt: "2026-10-20T10:00:00.000-0400", openChildren: 2, url: "https://growtherapy.atlassian.net/browse/ENG-1" });
  });

  it("the fake reproduces acli's field refusal (guard against a hollow allowlist test)", async () => {
    await expect(run("acli", ["jira", "workitem", "search", "--jql", "x", "--fields", "key,parent"])).rejects.toThrow(/fields 'parent' are not allowed/);
  });

  it("views and child searches run at most 5 at a time", async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `ENG-${i + 1}`);
    rules.acli = [{ match: "assignee = currentUser()", stdout: JSON.stringify(keys.map((k) => issue(k))) }];
    let inFlight = 0;
    let peak = 0;
    await createSyncCore({
      run: async (tool, args) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return run(tool, args);
      },
      previous: async () => null,
      wanted: async () => wanted,
      pendingOps: async () => [],
      claim: async () => true,
      ack: async () => {},
      ingest: async (s) => void ingested.push(s),
    }).pass();
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
    expect(snap().tickets.map((t) => t.key)).toEqual(keys); // input order kept
  });

  it("linked keys not assigned to me are fetched with key in (…), deduped against mine", async () => {
    wanted = { ...wanted, linkedKeys: ["ENG-1", "ENG-7", "bad key"] };
    rules.acli = [
      { match: "assignee = currentUser()", stdout: JSON.stringify([issue("ENG-1")]) },
      { match: "key in (ENG-1,ENG-7)", stdout: JSON.stringify([issue("ENG-1"), issue("ENG-7", { assignee: { accountId: "sam", displayName: "Sam" } })]) },
    ];
    await pass();
    expect(snap().tickets.map((t) => [t.key, t.assignedToMe])).toEqual([["ENG-1", true], ["ENG-7", false]]);
    expect(acliCalls().some((a) => a.join(" ").includes("project in (ENG)"))).toBe(true);
  });

  it("a malformed key in a search result is never viewed or put into JQL", async () => {
    wanted = { ...wanted, linkedKeys: ["ENG-7"] };
    rules.acli = [
      { match: "assignee = currentUser()", stdout: JSON.stringify([issue("ENG-1"), issue("ENG-1) OR project = X OR (key = ENG-2")]) },
      { match: "key in (ENG-7)", stdout: JSON.stringify([issue("eng 7; drop"), issue("ENG-7")]) },
    ];
    await pass();
    expect(snap().tickets.map((t) => t.key)).toEqual(["ENG-1", "ENG-7"]);
    const lines = acliCalls().map((a) => a.join(" "));
    expect(lines.some((l) => l.includes("OR project = X"))).toBe(false);
    expect(lines.some((l) => l.includes("drop"))).toBe(false);
  });

  it("fetches PRs and mentions", async () => {
    wanted = { ...wanted, linkedKeys: ["ENG-1"], prRefs: [{ repo: "o/r", number: 7 }] };
    rules.acli = [{ match: "search", stdout: JSON.stringify([issue("ENG-1")]) }];
    rules.gh = [
      { match: "pr view", stdout: JSON.stringify({ state: "OPEN", mergedAt: null, headRefName: "b", title: "t", body: "ENG-1", reviewDecision: "APPROVED", updatedAt: "2026-10-29T00:00:00Z", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }) },
      { match: "search prs", stdout: JSON.stringify([{ repository: { nameWithOwner: "o/r" }, number: 3, closedAt: "2026-10-28T00:00:00Z" }]) },
    ];
    await pass();
    const s = snap();
    expect(s.prs).toEqual([expect.objectContaining({ repo: "o/r", number: 7, state: "open", checks: "pass", reviewDecision: "approved" })]);
    expect(s.mentions).toEqual([{ key: "ENG-1", repo: "o/r", number: 3, mergedAt: "2026-10-28T00:00:00Z" }]);
    expect(s.tickets).toHaveLength(1);
  });

  it("transition op on a Done ticket makes no transition call, acks ok", async () => {
    ops = [op({ op: "transition", key: "ENG-1", toCategory: "done" })];
    rules.acli = [{ match: "workitem view", stdout: JSON.stringify(issue("ENG-1", { status: { name: "Done", statusCategory: { key: "done" } } })) }];
    await pass();
    expect(acliCalls().some((a) => a.includes("transition"))).toBe(false);
    expect(OpResult.array().parse(acked[0])).toEqual([{ id: "op1", ok: true, error: null, createdKey: null }]);
  });

  it("transition op moves a non-Done ticket by status name", async () => {
    ops = [op({ op: "transition", key: "ENG-1", toCategory: "done" })];
    rules.acli = [{ match: "workitem view", stdout: JSON.stringify(issue("ENG-1")) }];
    await pass();
    const t = acliCalls().find((a) => a.includes("transition"))!;
    expect(t).toEqual(expect.arrayContaining(["--key", "ENG-1", "--status", "Done", "--yes"]));
    expect(acked[0]![0]!.ok).toBe(true);
  });

  it("transition tries the conventional names in order until one works", async () => {
    ops = [op({ op: "transition", key: "ENG-1", toCategory: "done" })];
    rules.acli = [
      { match: "workitem view", stdout: JSON.stringify(issue("ENG-1")) },
      { match: "--status Done", fail: "no such transition" },
      { match: "--status Closed", stdout: "" },
    ];
    await pass();
    expect(acliCalls().filter((a) => a.includes("transition")).map((a) => a[a.indexOf("--status") + 1])).toEqual(["Done", "Closed"]);
    expect(acked[0]![0]!.ok).toBe(true);
  });

  it("comment op skips when the marker already exists", async () => {
    ops = [op({ op: "comment", key: "ENG-1", body: "hi" })];
    rules.acli = [{ match: "comment list", stdout: JSON.stringify({ comments: [{ body: "hi\n\n[fb:op1]" }] }) }];
    await pass();
    expect(acliCalls().some((a) => a.includes("create"))).toBe(false);
    expect(acked[0]![0]!.ok).toBe(true);
  });

  it("comment op posts body with marker when absent", async () => {
    ops = [op({ op: "comment", key: "ENG-1", body: "hi" })];
    rules.acli = [{ match: "comment list", stdout: "[]" }];
    await pass();
    const c = acliCalls().find((a) => a.includes("comment") && a.includes("create"))!;
    expect(c[c.indexOf("--body") + 1]).toBe("hi\n\n[fb:op1]");
  });

  it("assign me / none and create", async () => {
    ops = [
      op({ id: "a", op: "assign", key: "ENG-1", to: "me" }),
      op({ id: "b", op: "assign", key: "ENG-1", to: "none" }),
      op({ id: "c", op: "create", project: "ENG", issueType: "Task", summary: "S", description: "D", parentKey: "ENG-2" }),
    ];
    rules.acli = [{ match: "workitem create", stdout: JSON.stringify({ key: "ENG-77" }) }];
    await pass();
    const a = acliCalls().filter((x) => x.includes("assign"));
    expect(a[0]).toEqual(expect.arrayContaining(["--assignee", "@me"]));
    expect(a[1]).toContain("--remove-assignee");
    expect(acliCalls().find((x) => x.includes("create"))).toEqual(expect.arrayContaining(["--parent", "ENG-2"]));
    expect(acks()).toEqual([
      { id: "a", ok: true, error: null, createdKey: null },
      { id: "b", ok: true, error: null, createdKey: null },
      { id: "c", ok: true, error: null, createdKey: "ENG-77" },
    ]);
  });

  it("a failing op acks ok:false with the error", async () => {
    ops = [op({ op: "assign", key: "ENG-1", to: "me" })];
    rules.acli = [{ match: "assign", fail: "boom" }];
    await pass();
    expect(acked[0]![0]).toMatchObject({ ok: false, error: expect.stringContaining("boom") });
  });

  it("acli auth failure ingests ok:false with the error", async () => {
    rules.acli = [{ match: "search", fail: "unauthorized: please login" }];
    await pass();
    const s = snap();
    expect(s.ok).toBe(false);
    expect(s.error).toContain("unauthorized");
  });

  it("gh failure ingests tickets with prs [] and an error", async () => {
    wanted = { ...wanted, prRefs: [{ repo: "o/r", number: 7 }] };
    rules.acli = [{ match: "search", stdout: JSON.stringify([issue("ENG-1")]) }];
    rules.gh = [{ match: "", fail: "gh: not logged in" }];
    await pass();
    const s = snap();
    expect(s.prs).toEqual([]);
    expect(s.error).toBeTruthy();
    expect(s.tickets).toHaveLength(1);
  });

  it("one unreadable PR: the others are kept, ok stays true, the error counts the failures", async () => {
    wanted = { ...wanted, linkedKeys: ["ENG-1"], prRefs: [{ repo: "o/r", number: 7 }, { repo: "o/r", number: 8 }] };
    rules.acli = [{ match: "search", stdout: JSON.stringify([issue("ENG-1")]) }];
    rules.gh = [
      { match: "pr view 8", fail: "no such PR" },
      { match: "pr view 7", stdout: JSON.stringify({ state: "MERGED", mergedAt: "2026-10-28T00:00:00Z", headRefName: "b", title: "t", body: "", reviewDecision: null, updatedAt: "2026-10-29T00:00:00Z", statusCheckRollup: [] }) },
      { match: "search prs", stdout: JSON.stringify([]) },
    ];
    await pass();
    const s = snap();
    expect(s.ok).toBe(true);
    expect(s.prs.map((p) => p.number)).toEqual([7]);
    expect(s.error).toMatch(/^gh: 1 of 2 PRs unreadable \(.*no such PR.*\)$/);
  });

  describe("PR fetch speed", () => {
    afterEach(() => vi.useRealTimers());
    const prJson = (state: string) => JSON.stringify({ state, mergedAt: state === "MERGED" ? "2026-10-28T00:00:00Z" : null, headRefName: "b", title: "t", body: "", reviewDecision: null, updatedAt: "2026-10-29T00:00:00Z", statusCheckRollup: [] });
    const ghPr = (number: number, state: "open" | "merged" | "closed") => ({ repo: "o/r", number, state, headRef: "old", title: "old", body: "", checks: "none" as const, reviewDecision: null, updatedAt: "2026-10-01T00:00:00Z" });
    const prev = (prs: ReturnType<typeof ghPr>[]): JiraSnapshot => ({ version: 1, takenAt: "2026-10-29T00:00:00Z", ok: true, error: null, me: { accountId: "me1" }, tickets: [], prs, mentions: [] });
    const peakOf = async (sub: string, build: () => void) => {
      build();
      let inFlight = 0;
      let peak = 0;
      await createSyncCore({
        run: async (tool, args) => {
          const hit = `${tool} ${args.join(" ")}`.includes(sub);
          if (hit) peak = Math.max(peak, ++inFlight);
          await new Promise((r) => setTimeout(r, 1));
          if (hit) inFlight--;
          return run(tool, args);
        },
        previous: async () => null,
        wanted: async () => wanted,
        pendingOps: async () => [],
        claim: async () => true,
        ack: async () => {},
        ingest: async (s) => void ingested.push(s),
      }).pass();
      return peak;
    };
    beforeEach(() => {
      rules.acli = [{ match: "search", stdout: JSON.stringify([issue("ENG-1")]) }];
      rules.gh = [{ match: "pr view", stdout: prJson("OPEN") }, { match: "search prs", stdout: "[]" }];
    });
    it("pr views run at most 6 at a time, in input order", async () => {
      const peak = await peakOf("pr view", () => {
        wanted = { ...wanted, prRefs: Array.from({ length: 20 }, (_, i) => ({ repo: "o/r", number: i + 1 })) };
      });
      expect(peak).toBe(6);
      expect(snap().prs.map((p) => p.number)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    });
    it("mention searches run at most 3 at a time", async () => {
      const peak = await peakOf("search prs", () => {
        wanted = { ...wanted, linkedKeys: Array.from({ length: 10 }, (_, i) => `ENG-${i + 1}`) };
      });
      expect(peak).toBe(3);
    });
    it("terminal PRs in the previous snapshot are reused as-is; open/unknown ones are re-fetched", async () => {
      wanted = { ...wanted, prRefs: [1, 2, 3, 4].map((number) => ({ repo: "o/r", number })) };
      previous = prev([ghPr(1, "merged"), ghPr(2, "closed"), ghPr(3, "open")]);
      await pass();
      const viewed = calls.filter((c) => c.args[0] === "pr").map((c) => c.args[2]);
      expect(viewed).toEqual(["3", "4"]);
      const s = snap();
      expect(s.prs.map((p) => p.number)).toEqual([1, 2, 3, 4]);
      expect(s.prs[0]).toEqual(ghPr(1, "merged"));
      expect(s.prs[1]).toEqual(ghPr(2, "closed"));
      expect(s.prs[2]).toEqual(expect.objectContaining({ number: 3, headRef: "b", title: "t" }));
    });
    it("the failure count only counts refs attempted this pass", async () => {
      wanted = { ...wanted, prRefs: [1, 2, 3].map((number) => ({ repo: "o/r", number })) };
      previous = prev([ghPr(1, "merged")]);
      rules.gh = [{ match: "pr view 3", fail: "no such PR" }, ...rules.gh];
      await pass();
      expect(snap().error).toMatch(/^gh: 1 of 2 PRs unreadable /);
      expect(snap().prs.map((p) => p.number)).toEqual([1, 2]);
    });
    it("mentions are reused within 30 minutes and refetched after", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-05T10:00:00Z"));
      wanted = { ...wanted, linkedKeys: ["ENG-1"] };
      rules.gh = [{ match: "search prs", stdout: JSON.stringify([{ repository: { nameWithOwner: "o/r" }, number: 3, closedAt: "2026-10-28T00:00:00Z" }]) }];
      const c = core();
      const searches = () => calls.filter((x) => x.args[0] === "search").length;
      await c.pass();
      expect(searches()).toBe(1);
      vi.setSystemTime(new Date("2026-11-05T10:29:00Z"));
      await c.pass();
      expect(searches()).toBe(1);
      expect(snap().mentions).toEqual([{ key: "ENG-1", repo: "o/r", number: 3, mergedAt: "2026-10-28T00:00:00Z" }]);
      vi.setSystemTime(new Date("2026-11-05T10:31:00Z"));
      await c.pass();
      expect(searches()).toBe(2);
      // A fresh core (a restart) refetches.
      await core().pass();
      expect(searches()).toBe(3);
    });
    it("a failed mention search is not cached", async () => {
      wanted = { ...wanted, linkedKeys: ["ENG-1"] };
      rules.gh = [{ match: "search prs", fail: "rate limited" }];
      const c = core();
      await c.pass();
      expect(snap().error).toMatch(/1 of 1 mention searches failed/);
      await c.pass();
      expect(calls.filter((x) => x.args[0] === "search")).toHaveLength(2);
    });
  });

  it("never passes a space-joined command as one argv entry", async () => {
    wanted = { ...wanted, linkedKeys: ["ENG-1"], prRefs: [{ repo: "o/r", number: 7 }] };
    ops = [op({ op: "comment", key: "ENG-1", body: "x" })];
    await pass();
    const heads = new Set(["acli", "gh", "jira", "workitem", "search", "pr", "view"]);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) for (const a of c.args) expect(heads.has(a.split(" ")[0]!) && a.includes(" ")).toBe(false);
  });

  const events = () =>
    seq.map((l) => (l.startsWith("ack ") ? "ack" : /^acli jira workitem (transition|assign |create|comment create)/.test(l) ? "apply" : null)).filter(Boolean);

  it("applies then acks each op in order (apply1, ack1, apply2, ack2)", async () => {
    ops = [op({ id: "o1", op: "assign", key: "ENG-1", to: "me" }), op({ id: "o2", op: "assign", key: "ENG-2", to: "none" })];
    await pass();
    expect(events()).toEqual(["apply", "ack", "apply", "ack"]);
    const lines = seq.filter((l) => /assign|^ack/.test(l));
    expect(lines[0]).toContain("ENG-1");
    expect(lines[1]).toBe("ack o1");
    expect(lines[2]).toContain("ENG-2");
    expect(lines[3]).toBe("ack o2");
  });

  it("an op cancelled after the pass read the queue is not applied and not acked", async () => {
    ops = [op({ id: "o1", op: "assign", key: "ENG-1", to: "me" }), op({ id: "o2", op: "assign", key: "ENG-2", to: "none" })];
    // The undo lands while o1 is applying: o2 is gone from the store before its turn.
    claim = (id) => {
      if (id === "o1") ops = ops.filter((o) => o.id !== "o2");
      return ops.some((o) => o.id === id);
    };
    await pass();
    expect(seq.filter((l) => /workitem assign|^ack/.test(l))).toEqual([expect.stringContaining("ENG-1"), "ack o1"]);
  });

  it("replay after a failed ack does not duplicate comment, create, or transition", async () => {
    ops = [
      op({ id: "c1", op: "comment", key: "ENG-1", body: "hi" }),
      op({ id: "n1", op: "create", project: "ENG", issueType: "Task", summary: "S", description: "D", parentKey: null }),
      op({ id: "t1", op: "transition", key: "ENG-1", toCategory: "done" }),
    ];
    // Pass 1: the ack fails, so the pass stops after op c1 is applied.
    ackFails = true;
    rules.acli = [{ match: "comment list", stdout: "[]" }];
    await expect(pass()).rejects.toThrow("ack down");
    expect(acliCalls().filter((a) => a.includes("comment") && a.includes("create"))).toHaveLength(1);
    // Pass 2: Jira now has the comment, the create's marker is findable, the ticket is Done; ack works.
    ackFails = false;
    rules.acli = [
      { match: "comment list", stdout: JSON.stringify({ comments: [{ body: "hi\n\n[fb:c1]" }] }) },
      { match: 'description ~ "fb:n1"', stdout: JSON.stringify([{ key: "ENG-50" }]) },
      { match: "workitem view", stdout: JSON.stringify(issue("ENG-1", { status: { name: "Done", statusCategory: { key: "done" } } })) },
    ];
    await pass();
    const a = acliCalls();
    expect(a.filter((x) => x.includes("comment") && x.includes("create"))).toHaveLength(1);
    expect(a.some((x) => x.includes("workitem") && x.includes("create") && !x.includes("comment"))).toBe(false);
    expect(a.some((x) => x.includes("transition"))).toBe(false);
    expect(acks().find((r) => r.id === "n1")).toMatchObject({ ok: true, createdKey: "ENG-50" });
    expect(acks().map((r) => r.id)).toEqual(["c1", "n1", "t1"]);
  });

  it("create puts the marker at the end of the description", async () => {
    ops = [op({ id: "n2", op: "create", project: "ENG", issueType: "Task", summary: "S", description: "D", parentKey: null })];
    rules.acli = [{ match: "workitem create", stdout: JSON.stringify({ key: "ENG-8" }) }];
    await pass();
    const c = acliCalls().find((a) => a.includes("create"))!;
    expect(c[c.indexOf("--description") + 1]).toBe("D\n\n[fb:n2]");
  });

  it("unknown toCategory acks ok:false with a clear error", async () => {
    ops = [op({ op: "transition", key: "ENG-1", toCategory: "new" })];
    rules.acli = [{ match: "workitem view", stdout: JSON.stringify(issue("ENG-1", { status: { name: "Done", statusCategory: { key: "done" } } })) }];
    await pass();
    expect(acked[0]![0]).toMatchObject({ ok: false, error: expect.stringContaining("unsupported toCategory") });
  });
});
