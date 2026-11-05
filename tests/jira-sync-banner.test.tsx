// @vitest-environment jsdom
// The board banner when Jira sync can't run (components/jira-column.tsx
// jiraSyncBannerMessage / JiraSyncBannerSlot, rendered first in the board's
// banner row): sync off, the last pass failed, or no pass for 3 minutes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Board } from "../components/board";
import { buildColumns } from "../components/grouping";
import { JiraBoardContext, type JiraBoardValue } from "../components/jira-card-badges";
import { jiraSyncBannerMessage, type JiraColumnData } from "../components/jira-column";

afterEach(cleanup);

const NOW = Date.parse("2026-11-05T15:00:00Z");
const OFF = 'Jira sync is off: turn on "Jira: sync automatically" in Focus Board settings';
const NOT_RUNNING = "Jira sync hasn't run: check `bb focus-board jira status`";
const ok = { error: null, stale: false, snapshotAgeMs: 60_000, syncRanAt: NOW - 30_000, syncEnabled: true };

describe("jiraSyncBannerMessage", () => {
  it("healthy sync: no banner", () => {
    expect(jiraSyncBannerMessage(ok, NOW)).toBeNull();
  });
  it("sync off", () => {
    expect(jiraSyncBannerMessage({ ...ok, syncEnabled: false }, NOW)).toBe(OFF);
  });
  it("the last pass failed: the column's error line, ahead of sync off", () => {
    expect(jiraSyncBannerMessage({ ...ok, error: "unauthorized" }, NOW)).toBe("Jira not connected: run `acli jira auth login --web`");
    expect(jiraSyncBannerMessage({ ...ok, error: "boom" }, NOW)).toBe("Jira refresh failed: boom");
    expect(jiraSyncBannerMessage({ ...ok, error: "acli not found on PATH", syncEnabled: false }, NOW)).toBe("acli not found on PATH");
    expect(jiraSyncBannerMessage({ ...ok, error: "gh: 1 of 1 mention searches failed (gh not found on PATH)" }, NOW)).toBe("gh not found on PATH");
  });
  it("a partial gh failure is the column's business, not the banner's", () => {
    expect(jiraSyncBannerMessage({ ...ok, error: "gh: 1 of 3 PRs unreadable (x)" }, NOW)).toBeNull();
  });
  it("no pass for 3 minutes (or ever)", () => {
    expect(jiraSyncBannerMessage({ ...ok, syncRanAt: NOW - 3 * 60_000 - 1 }, NOW)).toBe(NOT_RUNNING);
    expect(jiraSyncBannerMessage({ ...ok, syncRanAt: null }, NOW)).toBe(NOT_RUNNING);
    expect(jiraSyncBannerMessage({ ...ok, syncRanAt: NOW - 2 * 60_000 }, NOW)).toBeNull();
  });
});

const column = (over: Partial<JiraColumnData> = {}): JiraColumnData => ({
  tickets: [], threadsByKey: {}, suggestions: {}, drift: [], pending: [], allThreads: [],
  refreshRequestedAt: null, onStartThread: vi.fn(), onLink: vi.fn(), onDismiss: vi.fn(), onFix: vi.fn(), onOpenThread: vi.fn(),
  onRefresh: vi.fn(), now: NOW, ...ok, ...over,
});
const value = (col: JiraColumnData | undefined, enabled = true): JiraBoardValue => ({
  enabled, stale: false, ticketByKey: {}, pendingOps: [], onAction: vi.fn(), threads: {}, column: col,
});

function boardEl(v: JiraBoardValue | null) {
  const props = {
    columns: buildColumns([], "status", { projects: [], providers: [] }, new Map(), new Set<string>(), NOW, {}),
    groupBy: "status" as const,
    activeThreadId: null,
    doneIds: new Set<string>(),
    nestedChildrenByParent: new Map(),
    doneChildrenByParent: new Map(),
    childCountByParent: new Map(),
    dimmedIds: new Set<string>(),
    projectNameFor: () => "One",
    repoBaseFor: () => null,
    onOpenThread: vi.fn(),
    onClosePane: vi.fn(),
    onNewTask: vi.fn(),
    rankStore: {},
    onRankMove: vi.fn(),
    onDropDone: vi.fn(),
    onDropUnread: vi.fn(),
    onDropPinned: vi.fn(),
    menuActionsFor: () => [],
  } as unknown as Parameters<typeof Board>[0];
  const el = <Board {...props} />;
  return v === null ? el : <JiraBoardContext.Provider value={v}>{el}</JiraBoardContext.Provider>;
}
const board = (v: JiraBoardValue | null) => render(boardEl(v));
const banner = () => document.querySelector('[data-testid="jira-sync-banner"]');

describe("the board's Jira sync banner", () => {
  it("Jira off: no banner (no provider, or a disabled one)", () => {
    board(null);
    expect(banner()).toBeNull();
    cleanup();
    board(value(column({ syncEnabled: false }), false));
    expect(banner()).toBeNull();
  });

  it("one slim banner at the top of the banner row, on an opaque surface, with Run sync now", () => {
    const col = column({ syncEnabled: false });
    board(value(col));
    const b = banner()!;
    expect(b.closest("[data-banner-row]")?.firstElementChild).toBe(b);
    expect(b.textContent).toContain(OFF);
    expect(b.className.split(" ")).toEqual(expect.arrayContaining(["bg-amber-50", "dark:bg-amber-950"]));
    fireEvent.click(screen.getByRole("button", { name: "Run sync now" }));
    expect(col.onRefresh).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('[data-testid="jira-sync-banner"]')).toHaveLength(1);
  });

  it.each([
    ["a failed pass", { error: "boom" }, "Jira refresh failed: boom"],
    ["a missing tool", { error: "acli not found on PATH" }, "acli not found on PATH"],
    ["no pass for 3 minutes", { syncRanAt: NOW - 4 * 60_000 }, NOT_RUNNING],
  ] as const)("%s raises it", (_, over, text) => {
    board(value(column(over)));
    expect(banner()?.textContent).toContain(text);
  });

  it("healthy sync: no banner", () => {
    board(value(column()));
    expect(banner()).toBeNull();
  });

  it("dismissed for the session: hidden until the condition changes", () => {
    const { rerender } = board(value(column({ syncEnabled: false })));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Jira sync notice" }));
    expect(banner()).toBeNull();
    rerender(boardEl(value(column({ syncEnabled: false })))); // a refetch, same condition
    expect(banner()).toBeNull();
    rerender(boardEl(value(column({ error: "boom" })))); // a new condition
    expect(banner()?.textContent).toContain("Jira refresh failed: boom");
    rerender(boardEl(value(column()))); // healthy, then off again: shows again
    rerender(boardEl(value(column({ syncEnabled: false }))));
    expect(banner()?.textContent).toContain(OFF);
  });

  it("the no-pass condition appears on its own as the clock runs (no refetch needed)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      board(value(column({ now: undefined, syncRanAt: NOW - 2 * 60_000 })));
      expect(banner()).toBeNull();
      act(() => vi.advanceTimersByTime(90_000));
      expect(banner()?.textContent).toContain(NOT_RUNNING);
    } finally {
      vi.useRealTimers();
    }
  });
});
