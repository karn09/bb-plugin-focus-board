// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { JiraColumn } from "../components/jira-column";
import { JIRA_COLUMN_ID, buildColumns, withJiraColumn } from "../components/grouping";
import { jiraStartThreadSeed } from "../lib/new-thread-seed";
import type { JiraTicket } from "../lib/jira-schema";

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
});

afterEach(cleanup);

describe("JiraColumn", () => {
  it("stale shows the snapshot age; unauthorized shows the login hint", () => {
    const { rerender } = render(<JiraColumn {...base()} stale snapshotAgeMs={6 * 60_000 + 5_000} />);
    expect(screen.getByText("data 6 min old")).toBeTruthy();
    rerender(<JiraColumn {...base()} error="unauthorized" />);
    expect(screen.getByText("Jira not connected: run `acli jira auth login --web`")).toBeTruthy();
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
    expect(p.onFix).toHaveBeenLastCalledWith(p.drift[1]);
  });

  it("collapsed renders a strip that expands", () => {
    const onCollapsedChange = vi.fn();
    render(<JiraColumn {...base()} collapsed onCollapsedChange={onCollapsedChange} />);
    expect(screen.queryByText("PT-3570")).toBeNull();
    fireEvent.click(screen.getByLabelText("Expand Jira column"));
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
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
    expect(withJiraColumn(cols, "status", true)[0]).toEqual({ id: JIRA_COLUMN_ID, label: "Jira", threads: [] });
    expect(withJiraColumn(cols, "status", true).slice(1)).toEqual(cols);
    expect(withJiraColumn(cols, "status", false)).toBe(cols);
    expect(withJiraColumn(cols, "project", true)).toBe(cols);
  });
});
