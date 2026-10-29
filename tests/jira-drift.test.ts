import { describe, expect, it } from "vitest";
import { detectDrift } from "../lib/jira-drift";
import type { GhPr, JiraTicket } from "../lib/jira-schema";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const DAY = 86_400_000;
const ticket = (over: Partial<JiraTicket> = {}): JiraTicket => ({
  key: "PT-3879", summary: "Terraform module cleanup", status: "In Progress", statusCategory: "indeterminate",
  assignee: { accountId: "me", displayName: "Me" }, assignedToMe: true, issueType: "Task", isEpic: false,
  parentKey: null, epicKey: null, openChildren: 0, updatedAt: "2026-10-28T00:00:00Z",
  url: "https://growtherapy.atlassian.net/browse/PT-3879", ...over,
});
const pr = (number: number, over: Partial<GhPr> = {}): GhPr => ({
  repo: "growtherapy/infra", number, state: "merged", headRef: `b-${number}`, title: "", body: "",
  checks: "pass", reviewDecision: null, updatedAt: "2026-10-28T00:00:00Z", ...over,
});
const th = (id: string, done = false, prs: GhPr[] = []) => ({ id, done, prs });

describe("detectDrift", () => {
  it("a To Do ticket with 2 merged PRs across 2 linked threads is one todo-with-prs naming both PRs", () => {
    const d = detectDrift(ticket({ statusCategory: "new", status: "To Do" }), [th("a", false, [pr(101)]), th("b", false, [pr(202)])], NOW, 30);
    expect(d).toHaveLength(1);
    expect(d[0]!.kind).toBe("todo-with-prs");
    expect(d[0]!.key).toBe("PT-3879");
    expect(d[0]!.detail).toContain("101");
    expect(d[0]!.detail).toContain("202");
  });

  it("the same PR on two threads counts once; closed PRs and epics never count", () => {
    const t = ticket({ statusCategory: "new", status: "To Do" });
    expect(detectDrift(t, [th("a", false, [pr(1)]), th("b", false, [pr(1)])], NOW, 30)[0]!.detail).toContain("1 open or merged PR");
    expect(detectDrift(t, [th("a", false, [pr(1, { state: "closed" })])], NOW, 30)).toEqual([]);
    expect(detectDrift({ ...t, isEpic: true }, [th("a", false, [pr(1)])], NOW, 30)).toEqual([]);
  });

  it("7 linked threads with 6 Done: no all-done-still-open; all 7 Done: it fires", () => {
    const seven = (doneCount: number) => Array.from({ length: 7 }, (_, i) => th(`p${i}`, i < doneCount));
    expect(detectDrift(ticket(), seven(6), NOW, 30).map((d) => d.kind)).not.toContain("all-done-still-open");
    expect(detectDrift(ticket(), seven(7), NOW, 30).map((d) => d.kind)).toEqual(["all-done-still-open"]);
    expect(detectDrift(ticket({ statusCategory: "done", status: "Done" }), seven(7), NOW, 30)).toEqual([]);
  });

  it("stale-unlinked at 31 days with no links; nothing at 29; the threshold is the setting", () => {
    const at = (days: number) => ticket({ updatedAt: new Date(NOW - days * DAY).toISOString() });
    expect(detectDrift(at(31), [], NOW, 30).map((d) => d.kind)).toEqual(["stale-unlinked"]);
    expect(detectDrift(at(29), [], NOW, 30)).toEqual([]);
    expect(detectDrift(at(29), [], NOW, 20).map((d) => d.kind)).toEqual(["stale-unlinked"]);
    expect(detectDrift(at(31), [th("a")], NOW, 30)).toEqual([]);
    expect(detectDrift({ ...at(31), assignedToMe: false }, [], NOW, 30)).toEqual([]);
  });
});
