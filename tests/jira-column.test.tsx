// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { JiraColumn, jiraThreadsByKey } from "../components/jira-column";
import { JIRA_COLUMN_ID, buildColumns, withJiraColumn } from "../components/grouping";
import { jiraStartThreadSeed } from "../lib/new-thread-seed";
import type { JiraTicket, QueueOp } from "../lib/jira-schema";

const ticket = (key: string, summary: string, over: Partial<JiraTicket> = {}): JiraTicket => ({
  key, summary, status: "In Progress", statusCategory: "indeterminate", assignee: null, assignedToMe: true,
  issueType: "Task", isEpic: false, parentKey: null, epicKey: null, openChildren: 0,
  updatedAt: "2026-10-28T00:00:00Z", url: `https://growtherapy.atlassian.net/browse/${key}`, ...over,
});
const base = () => ({
  tickets: [ticket("PT-3570", "Automated Atlantis plan review"), ticket("PT-3878", "Atlantis migration")],
  threadsByKey: { "PT-3878": [{ id: "a", title: "PT-3878 A: plan the cutover" }] },
  suggestions: {},
  drift: [],
  stale: false,
  snapshotAgeMs: 60_000,
  error: null,
  hideLinked: false,
  onHideLinkedChange: vi.fn(),
  onStartThread: vi.fn(),
  onLink: vi.fn(),
  onDismiss: vi.fn(),
  onFix: vi.fn(),
  onOpenThread: vi.fn(),
  pending: [] as QueueOp[],
});

afterEach(cleanup);

describe("JiraColumn", () => {
  it("stale shows the snapshot age; unauthorized shows the login hint", () => {
    const { rerender } = render(<JiraColumn {...base()} stale snapshotAgeMs={6 * 60_000 + 5_000} />);
    expect(screen.getByText("data 6 min old")).toBeTruthy();
    rerender(<JiraColumn {...base()} error="unauthorized" />);
    expect(screen.getByText("Jira not connected: run `acli jira auth login --web`")).toBeTruthy();
  });

  it("a partial gh failure on an ok snapshot shows the gh line, not the login hint", () => {
    render(<JiraColumn {...base()} error="gh: 1 of 3 PRs unreadable (gh pr failed: run gh auth login)" />);
    expect(screen.getByText("gh: 1 of 3 PRs unreadable (gh pr failed: run gh auth login)")).toBeTruthy();
    expect(screen.queryByText(/Jira not connected/)).toBeNull();
  });

  it("hide-linked hides tickets that have threads; the toggle reports the flip", () => {
    const p = base();
    const { rerender } = render(<JiraColumn {...p} />);
    expect(screen.getByText("PT-3878")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Hide linked tickets"));
    expect(p.onHideLinkedChange).toHaveBeenCalledWith(true);
    rerender(<JiraColumn {...p} hideLinked />);
    expect(screen.queryByText("PT-3878")).toBeNull();
    expect(screen.getByText("PT-3570")).toBeTruthy();
  });

  it("linked threads open the thread", () => {
    const p = base();
    render(<JiraColumn {...p} />);
    fireEvent.click(screen.getByText("PT-3878 A: plan the cutover"));
    expect(p.onOpenThread).toHaveBeenCalledWith("a");
  });

  it("a suggestion shows Might be: <title>; Link calls onLink; nothing links on render", () => {
    const p = { ...base(), suggestions: { "PT-3570": [{ threadId: "waf", title: "Resolve WAF IP set drift" }] } };
    render(<JiraColumn {...p} />);
    expect(screen.getByText("Might be: Resolve WAF IP set drift")).toBeTruthy();
    expect(p.onLink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(p.onLink).toHaveBeenCalledWith("PT-3570", "waf");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
    expect(p.onDismiss).toHaveBeenCalledWith("PT-3570", "waf");
  });

  it("Start thread on an unlinked ticket hands the ticket over", () => {
    const p = base();
    render(<JiraColumn {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(p.onStartThread).toHaveBeenCalledWith(p.tickets[0]);
  });

  it("todo-with-prs fixes in one click; Give back fixes only after the confirm", () => {
    const p = {
      ...base(),
      drift: [
        { key: "PT-3878", kind: "todo-with-prs" as const, detail: "To Do in Jira, but 2 PRs" },
        { key: "PT-3570", kind: "stale-unlinked" as const, detail: "No activity for 31 days" },
      ],
    };
    render(<JiraColumn {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Move to In Progress" }));
    expect(p.onFix).toHaveBeenCalledWith(p.drift[0]);
    fireEvent.click(screen.getByRole("button", { name: "Give back" }));
    expect(p.onFix).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Comment and unassign" }));
    expect(p.onFix).toHaveBeenLastCalledWith(p.drift[1], { confirm: true });
    expect(p.onFix.mock.calls[0]).toEqual([p.drift[0]]);
  });

  it("a fix whose op is already pending shows queued, not the button", () => {
    const pending: QueueOp[] = [
      { id: "o1", createdAt: "", threadId: null, op: "transition", key: "PT-3878", toCategory: "indeterminate" },
      { id: "o2", createdAt: "", threadId: null, op: "assign", key: "PT-3570", to: "none" },
    ];
    const p = {
      ...base(),
      pending,
      drift: [
        { key: "PT-3878", kind: "todo-with-prs" as const, detail: "d1" },
        { key: "PT-3570", kind: "stale-unlinked" as const, detail: "d2" },
      ],
    };
    render(<JiraColumn {...p} />);
    expect(screen.queryByRole("button", { name: "Move to In Progress" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Give back" })).toBeNull();
    expect(screen.getAllByText("queued")).toHaveLength(2);
  });

  it("collapsed renders a strip that expands", () => {
    const onCollapsedChange = vi.fn();
    render(<JiraColumn {...base()} collapsed onCollapsedChange={onCollapsedChange} />);
    expect(screen.queryByText("PT-3570")).toBeNull();
    fireEvent.click(screen.getByLabelText("Expand Jira column"));
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });
});

describe("jiraThreadsByKey", () => {
  it("merges record links with the plan's autoLinks, deduped, titled", () => {
    const rec = (keys: string[]) => ({ links: keys.map((key) => ({ key, role: "owner" as const, source: "auto" as const })) });
    const titleOf = new Map([["a", "A"], ["b", "B"]]);
    expect(
      jiraThreadsByKey({ a: rec(["PT-1"]) }, [{ threadId: "a", key: "PT-1" }, { threadId: "b", key: "PT-1" }, { threadId: "b", key: "PT-2" }], titleOf),
    ).toEqual({ "PT-1": [{ id: "a", title: "A" }, { id: "b", title: "B" }], "PT-2": [{ id: "b", title: "B" }] });
  });
});

describe("jiraStartThreadSeed", () => {
  it("builds the exact prompt and pluginMetadata seed", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    const seed = jiraStartThreadSeed({ ...ticket("PT-3570", "Automated Atlantis plan review"), description: "Wire it up." }, now);
    expect(seed.prompt).toBe("PT-3570: Automated Atlantis plan review\n\nhttps://growtherapy.atlassian.net/browse/PT-3570\n\nWire it up.");
    expect(seed.pluginMetadata).toEqual({
      jira: expect.objectContaining({
        links: [{ key: "PT-3570", role: "owner", source: "operator" }],
        enrolledAt: "2026-10-29T12:00:00.000Z",
      }),
    });
  });
});

describe("withJiraColumn", () => {
  const ctx = { projects: [], providers: [] };
  it("prepends an empty jira column only on the Attention view with Jira on; else returns the same array", () => {
    const cols = buildColumns([], "status", ctx);
    expect(JIRA_COLUMN_ID).toBe("__jira");
    expect(withJiraColumn(cols, "status", true)[0]).toEqual({ id: JIRA_COLUMN_ID, label: "Jira", threads: [] });
    expect(withJiraColumn(cols, "status", true).slice(1)).toEqual(cols);
    expect(withJiraColumn(cols, "status", false)).toBe(cols);
    expect(withJiraColumn(cols, "project", true)).toBe(cols);
  });
});
