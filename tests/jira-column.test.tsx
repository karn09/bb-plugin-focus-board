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
const NOW = Date.parse("2026-11-05T15:00:00Z");
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
  refreshRequestedAt: null as number | null,
  syncRanAt: NOW - 30_000 as number | null,
  syncEnabled: true,
  onRefresh: vi.fn(),
  allThreads: [
    { id: "a", title: "PT-3878 A: plan the cutover" },
    { id: "b", title: "Resolve WAF IP set drift" },
    { id: "c", title: "Decommission UAT environment" },
  ],
  now: NOW,
});

afterEach(cleanup);

describe("JiraColumn", () => {
  it("Refresh asks for a sync; while it is pending the button reads Refreshing… and is disabled", () => {
    const p = base();
    const { rerender } = render(<JiraColumn {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh Jira" }));
    expect(p.onRefresh).toHaveBeenCalledTimes(1);
    rerender(<JiraColumn {...p} refreshRequestedAt={NOW - 10_000} />);
    const b = screen.getByRole("button", { name: "Refresh Jira" }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.textContent).toContain("Refreshing");
  });

  it("a request older than 3 minutes no longer blocks the button", () => {
    render(<JiraColumn {...base()} refreshRequestedAt={NOW - 4 * 60_000} />);
    expect((screen.getByRole("button", { name: "Refresh Jira" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says so when sync has not run for 3 minutes", () => {
    const { rerender } = render(<JiraColumn {...base()} syncRanAt={null} />);
    expect(screen.getByText("Jira sync hasn't run: check `bb focus-board jira status`")).toBeTruthy();
    rerender(<JiraColumn {...base()} syncRanAt={NOW - 4 * 60_000} />);
    expect(screen.getByText(/Jira sync hasn't run/)).toBeTruthy();
    rerender(<JiraColumn {...base()} />);
    expect(screen.queryByText(/Jira sync hasn't run/)).toBeNull();
  });

  it("says how to turn sync on when the setting is off, ahead of any stale-data line", () => {
    render(<JiraColumn {...base()} syncEnabled={false} syncRanAt={null} stale snapshotAgeMs={30 * 60_000} />);
    expect(screen.getByText('Jira sync is off: turn on "Jira: sync automatically" in Focus Board settings')).toBeTruthy();
    expect(screen.queryByText(/hasn't run|min old/)).toBeNull();
  });

  it("Link to thread: search the board's threads, pick one, and it links (already-linked threads are left out)", () => {
    const p = base();
    render(<JiraColumn {...p} />);
    const card = screen.getByText("Atlantis migration").closest("article")!;
    fireEvent.click(card.querySelector("[data-jira-link-thread]")!);
    const box = screen.getByRole("searchbox", { name: "Find a thread to link to PT-3878" });
    expect(screen.queryByRole("option", { name: "PT-3878 A: plan the cutover" })).toBeNull();
    fireEvent.change(box, { target: { value: "waf" } });
    expect(screen.queryByRole("option", { name: "Decommission UAT environment" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Resolve WAF IP set drift" }));
    expect(p.onLink).toHaveBeenCalledWith("PT-3878", "b");
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("an error status shows ahead of the sync-off line (auth, gh partial, refresh failed)", () => {
    const lines = () => [...document.querySelectorAll("[data-jira-column] header ~ p")].map((p) => p.textContent);
    const off = 'Jira sync is off: turn on "Jira: sync automatically" in Focus Board settings';
    const { rerender } = render(<JiraColumn {...base()} syncEnabled={false} error="unauthorized" />);
    expect(lines()).toEqual(["Jira not connected: run `acli jira auth login --web`", off]);
    rerender(<JiraColumn {...base()} syncEnabled={false} error="gh: 1 of 3 PRs unreadable (x)" />);
    expect(lines()).toEqual(["gh: 1 of 3 PRs unreadable (x)", off]);
    rerender(<JiraColumn {...base()} syncEnabled={false} error="boom" />);
    expect(lines()).toEqual(["Jira refresh failed: boom", off]);
    rerender(<JiraColumn {...base()} syncEnabled={false} />);
    expect(lines()).toEqual([off]);
  });

  it("a missing tool reads as that tool not found on PATH", () => {
    const { rerender } = render(<JiraColumn {...base()} error="acli not found on PATH" />);
    expect(screen.getByText("acli not found on PATH")).toBeTruthy();
    rerender(<JiraColumn {...base()} error="gh: 2 of 2 PRs unreadable (gh not found on PATH)" />);
    expect(screen.getByText("gh not found on PATH")).toBeTruthy();
  });

  it("stale shows the snapshot age; unauthorized shows the login hint", () => {
    const { rerender } = render(<JiraColumn {...base()} stale snapshotAgeMs={6 * 60_000 + 5_000} />);
    expect(screen.getByText("data 6 min old")).toBeTruthy();
    rerender(<JiraColumn {...base()} error="unauthorized" />);
    expect(screen.getByText("Jira not connected: run `acli jira auth login --web`")).toBeTruthy();
  });

  it("no data yet (no snapshot, no error) points at `jira sync`, not the login", () => {
    render(<JiraColumn {...base()} snapshotAgeMs={null} error={null} />);
    expect(screen.getByText("No Jira data yet: run `bb focus-board jira sync`")).toBeTruthy();
    expect(screen.queryByText(/Jira not connected/)).toBeNull();
  });

  it("a refresh error that merely mentions 'author' is not read as a login problem", () => {
    render(<JiraColumn {...base()} error="field 'author' unknown" />);
    expect(screen.getByText("Jira refresh failed: field 'author' unknown")).toBeTruthy();
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
    expect(jiraStartThreadSeed(ticket("PT-1", "No body"), now).prompt).toBe("PT-1: No body\n\nhttps://growtherapy.atlassian.net/browse/PT-1");
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
