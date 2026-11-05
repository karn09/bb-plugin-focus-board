// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { JiraCardBadges } from "../components/jira-card-badges";

const rec = (over: object = {}) => ({
  links: [{ key: "PT-1", role: "owner" as const, source: "auto" as const }],
  enrolledAt: null, verifying: null, doneCheck: null, nudgedAt: null, deepCheckedAt: null, reason: null, checkInWith: null, ...over,
});
const t = (statusCategory: "new" | "indeterminate" | "done") => ({
  "PT-1": { key: "PT-1", summary: "s", status: "Doing", statusCategory, assignee: null, assignedToMe: true, issueType: "Task", isEpic: false, parentKey: null, epicKey: null, openChildren: 0, updatedAt: "", url: "u" },
});
const props = { threadId: "t1", enabled: true, stale: false, ticketByKey: t("indeterminate"), pendingOps: [], onAction: vi.fn() };

afterEach(cleanup);
describe("JiraCardBadges", () => {
  it("renders nothing when disabled", () => {
    const { container } = render(<JiraCardBadges {...props} enabled={false} record={rec({ links: [] })} />);
    expect(container.innerHTML).toBe("");
  });
  it.each([["new", "neutral"], ["indeterminate", "info"], ["done", "good"]] as const)("chip tone %s -> %s", (cat, tone) => {
    render(<JiraCardBadges {...props} ticketByKey={t(cat)} record={rec()} />);
    expect(screen.getByText("PT-1 · Doing").closest("[data-jira-chip]")!.getAttribute("data-tone")).toBe(tone);
  });
  it("stale marker", () => {
    render(<JiraCardBadges {...props} stale record={rec()} />);
    expect(screen.getByText("stale")).toBeTruthy();
  });
  it("no ticket chip with Find ticket button", () => {
    const onAction = vi.fn();
    render(<JiraCardBadges {...props} onAction={onAction} record={rec({ links: [] })} />);
    expect(screen.getByText("No ticket")).toBeTruthy();
    fireEvent.click(screen.getByText("Find ticket"));
    expect(onAction).toHaveBeenCalledWith("find-ticket", "t1");
  });
  it("reason, check-in (with clear), verifying spinner", () => {
    const onAction = vi.fn();
    render(<JiraCardBadges {...props} onAction={onAction} record={rec({ reason: "waiting on infra", checkInWith: "Sam", verifying: { startedAt: "x" } })} />);
    expect(screen.getByText("waiting on infra")).toBeTruthy();
    expect(screen.getByText("check in with Sam")).toBeTruthy();
    expect(document.querySelector("[data-jira-verifying]")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Clear check-in"));
    expect(onAction).toHaveBeenCalledWith("clear-check-in", "t1");
  });
  it("epic suggestion: a Promote button that only acts on click", () => {
    const onAction = vi.fn();
    render(<JiraCardBadges {...props} onAction={onAction} record={rec({ epicSuggested: true })} />);
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Promote PT-1 to an epic?"));
    expect(onAction).toHaveBeenCalledWith("promote-epic", "t1");
  });
  it("no Promote button without the suggestion", () => {
    render(<JiraCardBadges {...props} record={rec()} />);
    expect(screen.queryByText(/Promote/)).toBeNull();
  });
  it("pending next to a chip with an un-acked op for that key", () => {
    const op = { id: "o", createdAt: "", threadId: null, op: "comment" as const, key: "PT-1", body: "x" };
    render(<JiraCardBadges {...props} pendingOps={[op]} record={rec()} />);
    expect(screen.getByText("pending")).toBeTruthy();
  });
  it("Undo next to pending for the thread's own queued writes: calls onUndo with the shown op ids; keyboard reachable", () => {
    const onUndo = vi.fn();
    const mine = (id: string) => ({ id, createdAt: "", threadId: "t1", op: "comment" as const, key: "PT-1", body: "x" });
    render(<JiraCardBadges {...props} onUndo={onUndo} pendingOps={[mine("o1"), mine("o2"), { ...mine("o3"), threadId: "t2" }]} record={rec()} />);
    const b = screen.getByRole("button", { name: "Undo Jira changes" });
    expect(b.tagName).toBe("BUTTON");
    fireEvent.click(b);
    expect(onUndo).toHaveBeenCalledWith("t1", ["o1", "o2"]);
  });
  it("no Undo without the thread's own pending ops (another thread's or an unowned fix), nor with Jira off", () => {
    const op = { id: "o", createdAt: "", threadId: null, op: "comment" as const, key: "PT-1", body: "x" };
    const { rerender } = render(<JiraCardBadges {...props} onUndo={vi.fn()} pendingOps={[op, { ...op, id: "p", threadId: "t2" }]} record={rec()} />);
    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo Jira changes" })).toBeNull();
    rerender(<JiraCardBadges {...props} enabled={false} onUndo={vi.fn()} pendingOps={[{ ...op, threadId: "t1" }]} record={rec()} />);
    expect(screen.queryByRole("button", { name: "Undo Jira changes" })).toBeNull();
  });
  it("no stale marker when fresh; no pending marker for another key", () => {
    const op = { id: "o", createdAt: "", threadId: null, op: "comment" as const, key: "PT-2", body: "x" };
    render(<JiraCardBadges {...props} pendingOps={[op]} record={rec()} />);
    expect(screen.queryByText("stale")).toBeNull();
    expect(screen.queryByText("pending")).toBeNull();
  });
  it("failed Done check: reasons as plain lines, one Keep working, and a ⋯ menu per reason with Spin off / Not needed", () => {
    const onAction = vi.fn();
    const reasons = ["PR #7 still open", "<b>x</b>"];
    render(<JiraCardBadges {...props} onAction={onAction} record={rec({ reason: reasons.join("; "), doneCheck: { at: "x", verdict: "fail", reasons } })} />);
    expect(screen.getByText("<b>x</b>")).toBeTruthy();
    expect(document.querySelector("b")).toBeNull();
    expect(screen.queryByText(reasons.join("; "))).toBeNull(); // the checklist replaces the reason line
    expect(screen.getAllByText("Keep working")).toHaveLength(1);
    expect(screen.queryByText("Spin off")).toBeNull(); // one click deep
    expect(screen.queryByText("Not needed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More for: <b>x</b>" }));
    expect(screen.getByRole("menu").textContent).toContain("<b>x</b>");
    fireEvent.click(screen.getByRole("menuitem", { name: "Spin off" }));
    expect(onAction).toHaveBeenCalledWith("spin-off", "t1", 1, "<b>x</b>");
    expect(screen.queryByRole("menu")).toBeNull(); // running an entry closes the menu
    fireEvent.click(screen.getByRole("button", { name: "More for: PR #7 still open" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Not needed" }));
    expect(onAction).toHaveBeenCalledWith("not-needed", "t1", 0, "PR #7 still open");
    fireEvent.click(screen.getByText("Keep working"));
    expect(onAction).toHaveBeenCalledWith("keep-working", "t1");
    fireEvent.click(screen.getByText("Mark done anyway"));
    expect(onAction).toHaveBeenCalledWith("skip-done", "t1");
  });
  it("the ⋯ menu opened from the keyboard anchors under the button; Escape closes it and refocuses the button", () => {
    const reasons = ["PR #7 still open"];
    render(<JiraCardBadges {...props} record={rec({ doneCheck: { at: "x", verdict: "fail", reasons } })} />);
    const more = screen.getByRole("button", { name: "More for: PR #7 still open" });
    more.getBoundingClientRect = () => ({ left: 300, bottom: 200, top: 190, right: 310, width: 10, height: 10, x: 300, y: 190 }) as DOMRect;
    more.focus();
    fireEvent.click(more, { detail: 0, clientX: 0, clientY: 0 }); // Enter/Space: a click with no pointer position
    const menu = screen.getByRole("menu");
    expect([menu.style.left, menu.style.top]).toEqual(["300px", "200px"]);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Spin off" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(more);
  });
  it("pending confirm: a Confirm done button; Mark done anyway sits one click deep", () => {
    const onAction = vi.fn();
    render(<JiraCardBadges {...props} onAction={onAction} record={rec({ doneCheck: { at: "x", verdict: "pending-confirm", reasons: [] } })} />);
    fireEvent.click(screen.getByText("Confirm done"));
    expect(onAction).toHaveBeenCalledWith("confirm-done", "t1");
    expect(screen.getByText("Mark done anyway").closest("details")).toBeTruthy();
  });
  it("no Done buttons after a pass", () => {
    render(<JiraCardBadges {...props} record={rec({ doneCheck: { at: "x", verdict: "pass", reasons: [] } })} />);
    expect(screen.queryByText("Confirm done")).toBeNull();
    expect(screen.queryByText("Mark done anyway")).toBeNull();
  });
  it.each([
    ["verifying", { verifying: { startedAt: "x" } }],
    ["pending confirm", { doneCheck: { at: "x", verdict: "pending-confirm", reasons: [] } }],
  ])("%s: a Keep working button", (_, over) => {
    const onAction = vi.fn();
    render(<JiraCardBadges {...props} onAction={onAction} record={rec(over)} />);
    fireEvent.click(screen.getByText("Keep working"));
    expect(onAction).toHaveBeenCalledWith("keep-working", "t1");
  });
});

describe("JiraCardBadges: the deeper check's next step (Task 11)", () => {
  it("Run Done check, Open PR, Snooze; the reason renders as text", () => {
    const onAction = vi.fn();
    const onSnooze = vi.fn();
    const { rerender } = render(
      <JiraCardBadges {...props} onAction={onAction} onSnooze={onSnooze} record={rec({ reason: "<b>All PRs merged</b>" })} next={{ next: "done-check" }} />,
    );
    expect(screen.getByText("<b>All PRs merged</b>")).toBeTruthy();
    fireEvent.click(screen.getByText("Run Done check"));
    expect(onAction).toHaveBeenCalledWith("run-done-check", "t1");
    rerender(<JiraCardBadges {...props} onAction={onAction} onSnooze={onSnooze} record={rec({ reason: "PR #4: CI failing" })} next={{ next: "open-pr", prUrl: "https://github.com/o/r/pull/4" }} />);
    expect(screen.getByText("Open PR").getAttribute("href")).toBe("https://github.com/o/r/pull/4");
    rerender(<JiraCardBadges {...props} onAction={onAction} onSnooze={onSnooze} record={rec({ reason: "PR status unavailable" })} next={{ next: "snooze" }} />);
    expect(screen.queryByText("Run Done check")).toBeNull();
    fireEvent.click(screen.getByText("Snooze"));
    expect(onSnooze).toHaveBeenCalledWith("t1");
    expect(onAction).toHaveBeenCalledWith("dismiss-reason", "t1");
  });

  it("a Done check waiting on PR data says so; a no-data Confirm done shows why", () => {
    const { rerender } = render(<JiraCardBadges {...props} record={rec({ verifying: { startedAt: "2026-11-05T00:00:00Z", reasons: ["checking PRs"] } })} />);
    expect(screen.getByText("checking PRs")).toBeTruthy();
    rerender(<JiraCardBadges {...props} record={rec({ doneCheck: { at: "2026-11-05T00:00:00Z", verdict: "pending-confirm", reasons: ["Couldn't check PRs: confirm done"] } })} />);
    expect(screen.getByText("Couldn't check PRs: confirm done")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm done" })).toBeTruthy();
  });
});
