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
  it("pending next to a chip with an un-acked op for that key", () => {
    const op = { id: "o", createdAt: "", threadId: null, op: "comment" as const, key: "PT-1", body: "x" };
    render(<JiraCardBadges {...props} pendingOps={[op]} record={rec()} />);
    expect(screen.getByText("pending")).toBeTruthy();
  });
});
