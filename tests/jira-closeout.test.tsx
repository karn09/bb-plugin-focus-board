// @vitest-environment jsdom
// The Jira closeout overlay (components/jira-closeout.tsx) and the card's
// "Closeout pending" chip, mounted through JiraBoardContext as the board does.
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { JiraBoardContext, JiraCardSlot, type JiraBoardValue } from "../components/jira-card-badges";
import { JiraCloseoutSlot } from "../components/jira-closeout";
import type { CloseoutDraft } from "../lib/jira-done-check";

afterEach(cleanup);

const BODY = 'Focus Board: thread "Ship it" is Done.\nPull requests:\n- https://github.com/o/r/pull/1';
const tk = (key: string, over: Partial<CloseoutDraft["tickets"][number]> = {}) => ({ key, body: BODY, transition: true, canTransition: true, ...over });
const draft = (tickets = [tk("PT-1")], over: Partial<CloseoutDraft> = {}): CloseoutDraft => ({ createdAt: "2026-11-06T00:00:00Z", skipped: false, tickets, ...over });
const ticket = (key: string) => ({
  key, summary: "s", status: "In Progress", statusCategory: "indeterminate" as const, assignee: null, assignedToMe: true, issueType: "Task", isEpic: false,
  parentKey: null, epicKey: null, openChildren: 0, updatedAt: "", url: "u",
});
const rec = { links: [{ key: "PT-1", role: "owner" as const, source: "auto" as const }], enrolledAt: null, verifying: null, doneCheck: null, nudgedAt: null, deepCheckedAt: null, reason: null, checkInWith: null };

function Board(p: { drafts: Record<string, CloseoutDraft>; requested?: Map<string, number>; enabled?: boolean; h: ReturnType<typeof handlers>; threads?: JiraBoardValue["threads"] }) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  const value: JiraBoardValue = {
    enabled: p.enabled ?? true, stale: false, ticketByKey: { "PT-1": ticket("PT-1"), "PT-2": ticket("PT-2") }, threads: p.threads ?? { t1: rec }, pendingOps: [], onAction: vi.fn(),
    closeout: { drafts: p.drafts, doneRequested: p.requested ?? new Map(), openFor, setOpenFor, ...p.h },
  };
  return (
    <JiraBoardContext.Provider value={value}>
      <JiraCardSlot threadId="t1" part="badges" />
      <JiraCloseoutSlot />
    </JiraBoardContext.Provider>
  );
}
const handlers = () => ({
  submit: vi.fn(async () => ({ ok: true })),
  skip: vi.fn(async () => ({ ok: true })),
  draftWithAgent: vi.fn(async () => ({ ok: true })),
});
const req = (at = Date.now()) => new Map([["t1", at]]);
const dialog = () => screen.queryByRole("dialog");
const area = (key: string) => screen.getByLabelText(`Comment for ${key}`) as HTMLTextAreaElement;

describe("Jira closeout overlay", () => {
  it("auto-opens only for a draft of a thread this board moved to Done", async () => {
    const h = handlers();
    const requested = req();
    const { rerender } = render(<Board drafts={{}} requested={requested} h={h} />);
    expect(dialog()).toBeNull();
    rerender(<Board drafts={{ t1: draft() }} requested={requested} h={h} />);
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(area("PT-1").value).toBe(BODY);
    cleanup();
    render(<Board drafts={{ t1: draft() }} h={h} />); // found on load, or made by the CLI
    expect(dialog()).toBeNull();
    expect(screen.getByRole("button", { name: "Closeout pending" })).toBeTruthy();
  });

  it("an edited body is what Post & close sends; unchecking the move reads Post", async () => {
    const h = handlers();
    render(<Board drafts={{ t1: draft() }} requested={req()} h={h} />);
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(screen.getByText("DONE")).toBeTruthy();
    fireEvent.change(area("PT-1"), { target: { value: "Shipped the fix." } });
    const box = screen.getByRole("checkbox", { name: "Move PT-1 to Done" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(screen.queryByText("DONE")).toBeNull();
    expect(screen.getByText("IN PROGRESS")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Post & close" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    await waitFor(() => expect(h.submit).toHaveBeenCalledWith("t1", [{ key: "PT-1", body: "Shipped the fix.", transition: false }]));
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it("a ticket that cannot move to Done: the checkbox is disabled with the hint", async () => {
    render(<Board drafts={{ t1: draft([tk("PT-1", { transition: false, canTransition: false, blocked: "epic" })]) }} requested={req()} h={handlers()} />);
    await waitFor(() => expect(dialog()).not.toBeNull());
    const box = screen.getByRole("checkbox", { name: "Move PT-1 to Done" }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(box.getAttribute("aria-describedby")!)!.textContent).toContain("epic");
    expect(screen.getByRole("button", { name: "Post" })).toBeTruthy();
  });

  it("Draft with agent: sends the instruction; an agent body refreshes an untouched textarea, an edited one offers Use it", async () => {
    const h = handlers();
    const requested = req();
    const two = [tk("PT-1"), tk("PT-2")];
    const { rerender } = render(<Board drafts={{ t1: draft(two) }} requested={requested} h={h} />);
    await waitFor(() => expect(dialog()).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Instruction for the agent"), { target: { value: "shorter" } });
    fireEvent.click(screen.getByRole("button", { name: "Draft with agent" }));
    await waitFor(() => expect(h.draftWithAgent).toHaveBeenCalledWith("t1", "shorter"));
    fireEvent.change(area("PT-2"), { target: { value: "mine" } });
    rerender(<Board drafts={{ t1: draft(two, { agentDrafting: true }) }} requested={requested} h={h} />);
    expect(screen.getByText("The agent is drafting…")).toBeTruthy();
    rerender(<Board drafts={{ t1: draft([tk("PT-1", { body: "agent one" }), tk("PT-2", { body: "agent two" })]) }} requested={requested} h={h} />);
    await waitFor(() => expect(area("PT-1").value).toBe("agent one"));
    expect(area("PT-2").value).toBe("mine");
    expect(screen.getByText(/Agent draft ready/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use it" }));
    expect(area("PT-2").value).toBe("agent two");
  });

  it("Later closes and keeps the chip; the chip reopens the overlay; Skip Jira skips", async () => {
    const h = handlers();
    render(<Board drafts={{ t1: draft() }} requested={req()} h={h} />);
    await waitFor(() => expect(dialog()).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.skip).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Closeout pending" }));
    await waitFor(() => expect(dialog()).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Skip Jira" }));
    await waitFor(() => expect(h.skip).toHaveBeenCalledWith("t1"));
  });

  it("a refused post shows the error and keeps the overlay open", async () => {
    const h = { ...handlers(), submit: vi.fn(async () => ({ ok: false, error: "nothing to close out" })) };
    render(<Board drafts={{ t1: draft() }} requested={req()} h={h} />);
    await waitFor(() => expect(dialog()).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Post & close" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("nothing to close out"));
    expect(dialog()).not.toBeNull();
  });

  it("a Done that made no draft is forgotten: a later CLI-made draft does not auto-open", async () => {
    const h = handlers();
    const requested = req(Date.now() - 1000);
    const passedNoDraft = { t1: { ...rec, doneCheck: { at: new Date().toISOString(), verdict: "pass" as const, reasons: [] } } };
    const { rerender } = render(<Board drafts={{}} requested={requested} threads={{ t1: rec }} h={h} />);
    expect(requested.size).toBe(1); // still checking
    rerender(<Board drafts={{}} requested={requested} threads={passedNoDraft} h={h} />);
    await waitFor(() => expect(requested.size).toBe(0));
    rerender(<Board drafts={{ t1: draft() }} requested={requested} threads={passedNoDraft} h={h} />);
    expect(dialog()).toBeNull();
  });

  it("a remembered Done expires after 5 minutes", async () => {
    const requested = req(Date.now() - 6 * 60_000);
    render(<Board drafts={{}} requested={requested} h={handlers()} />);
    await waitFor(() => expect(requested.size).toBe(0));
  });

  it("the overlay closes when its draft disappears (posted or skipped elsewhere)", async () => {
    const h = handlers();
    const requested = req();
    const { rerender } = render(<Board drafts={{ t1: draft() }} requested={requested} h={h} />);
    await waitFor(() => expect(dialog()).not.toBeNull());
    rerender(<Board drafts={{}} requested={requested} h={h} />);
    await waitFor(() => expect(dialog()).toBeNull());
    rerender(<Board drafts={{ t1: draft() }} requested={requested} h={h} />);
    expect(dialog()).toBeNull(); // closed for good, not hidden: a new draft only shows via the chip
  });

  it("Jira off renders nothing", () => {
    const { container } = render(<Board enabled={false} drafts={{ t1: draft() }} requested={req()} h={handlers()} />);
    expect(container.innerHTML).toBe("");
    expect(dialog()).toBeNull();
  });
});
