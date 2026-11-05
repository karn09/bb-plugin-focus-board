// @vitest-environment jsdom
// The thread pane's Escape key behavior, governed by the "Esc stops running
// thread" toolbar toggle: ON (default), Escape stops a running thread and
// only closes the pane when the thread is not running; OFF, Escape always
// closes the pane as it always did.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ThreadPane } from "../components/thread-pane";
import { MenuPopover, MenuPopoverEntry } from "../components/menu-popover";
import { CompactViewportOverrideProvider } from "../components/ui/hooks/use-compact-viewport";

const stop = vi.fn();
const onClose = vi.fn();

vi.mock("@get-bb/plugin-sdk/app", () => ({
  // The pane's embedded chat is only imported for render; the Escape
  // handling under test does not involve it.
  ThreadChat: (): ReactNode => null,
  useSdk: () => ({ threads: { get: async () => ({}), stop } }),
  useRpc: () => ({ call: async () => ({ existence: {} }) }),
  useBbNavigate: () => ({ toThread: () => {} }),
  useSettings: () => ({ values: undefined, isLoading: false }),
}));

vi.mock("../components/pending-interaction-card", () => ({
  PendingInteractionCard: (): ReactNode => null,
}));

vi.mock("../components/decided-questions-card", () => ({
  DecidedQuestionsCard: (): ReactNode => null,
}));

const noop = () => {};

beforeEach(() => {
  stop.mockReset();
  stop.mockResolvedValue({});
  onClose.mockReset();
});

afterEach(cleanup);

function paneElement(
  thread: Parameters<typeof ThreadPane>[0]["thread"],
  {
    escStopsRunningThread = true,
    escapeSuppressed = false,
  }: { escStopsRunningThread?: boolean; escapeSuppressed?: boolean } = {},
) {
  return createElement(
    CompactViewportOverrideProvider,
    { isCompactViewport: false },
    createElement(ThreadPane, {
      thread,
      isArchived: false,
      isDone: false,
      onToggleDone: noop,
      onToggleArchived: noop,
      onToggleUnread: noop,
      onRename: async () => {},
      onMaximize: noop,
      onClose,
      escStopsRunningThread,
      escapeSuppressed,
    }),
  );
}

function renderPane(
  thread: Parameters<typeof ThreadPane>[0]["thread"],
  opts: { escStopsRunningThread?: boolean } = {},
) {
  return render(paneElement(thread, opts));
}

const pressEscape = () => {
  // The listener is a capture-phase document listener; fire on the document
  // like a real keydown would reach it.
  fireEvent.keyDown(document, { key: "Escape" });
};

describe("Escape stops a running thread (toggle ON)", () => {
  it("stops an active thread instead of closing the pane", () => {
    renderPane({
      id: "thr_test",
      displayTitle: "Test thread",
      status: "active",
      isUnread: false,
      isPinned: false,
    });
    pressEscape();
    expect(stop).toHaveBeenCalledWith({ threadId: "thr_test" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stops a starting thread too", () => {
    renderPane({
      id: "thr_test",
      displayTitle: "Test thread",
      status: "starting",
      isUnread: false,
      isPinned: false,
    });
    pressEscape();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("holds the pane open while a stop is already in flight", () => {
    renderPane({
      id: "thr_test",
      displayTitle: "Test thread",
      status: "stopping",
      isUnread: false,
      isPinned: false,
    });
    pressEscape();
    expect(stop).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes the pane once the thread is idle", () => {
    renderPane({
      id: "thr_test",
      displayTitle: "Test thread",
      status: "idle",
      isUnread: false,
      isPinned: false,
    });
    pressEscape();
    expect(stop).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Escape closes the pane regardless of status (toggle OFF)", () => {
  it("closes an active thread's pane without stopping it", () => {
    renderPane(
      {
        id: "thr_test",
        displayTitle: "Test thread",
        status: "active",
        isUnread: false,
        isPinned: false,
      },
      { escStopsRunningThread: false },
    );
    pressEscape();
    expect(stop).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Escape double-tap debounce", () => {
  // The double-tap guard: after the pane acts on an Escape (stop or close),
  // further Escapes inside a short window are swallowed, so a double-tap
  // meant to stop a running thread never cascades into closing the pane.
  const threadWith = (status: "active" | "stopping" | "idle") => ({
    id: "thr_test",
    displayTitle: "Test thread",
    status,
    isUnread: false,
    isPinned: false,
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("swallows a second Escape right after stopping the thread", () => {
    renderPane(threadWith("active"));
    pressEscape();
    vi.advanceTimersByTime(100);
    pressEscape();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close the pane when a double-tap lands after the stop settled", () => {
    const view = renderPane(threadWith("active"));
    pressEscape();
    vi.advanceTimersByTime(100);
    // The stop settled between the two taps; the second tap used to close.
    view.rerender(paneElement(threadWith("idle")));
    pressEscape();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes only once when a double-tap lands on an idle thread", () => {
    renderPane(threadWith("idle"));
    pressEscape();
    vi.advanceTimersByTime(100);
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("acts again once the debounce window has passed", () => {
    const view = renderPane(threadWith("active"));
    pressEscape();
    vi.advanceTimersByTime(100);
    view.rerender(paneElement(threadWith("idle")));
    vi.advanceTimersByTime(600);
    pressEscape();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stops again on a deliberate second press after the window", () => {
    renderPane(threadWith("active"));
    pressEscape();
    vi.advanceTimersByTime(600);
    pressEscape();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("never acts on held-key auto-repeat", () => {
    renderPane(threadWith("active"));
    fireEvent.keyDown(document, { key: "Escape", repeat: true });
    expect(stop).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a swallowed Escape does not extend the debounce window", () => {
    const view = renderPane(threadWith("active"));
    pressEscape(); // t=0: stops, arms the window
    vi.advanceTimersByTime(400);
    view.rerender(paneElement(threadWith("idle")));
    pressEscape(); // t=400: inside the window, swallowed
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    pressEscape(); // t=800: 800ms since the stop, past the window — closes
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Escape stands down while an overlay owns the key (composer modal open)", () => {
  it("neither stops a running thread nor closes the pane", () => {
    renderPane(
      {
        id: "thr_test",
        displayTitle: "Test thread",
        status: "active",
        isUnread: false,
        isPinned: false,
        projectName: null,
        branchName: null,
      },
      { escapeSuppressed: true },
    );
    pressEscape();
    expect(stop).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close an idle thread's pane either", () => {
    renderPane(
      {
        id: "thr_test",
        displayTitle: "Test thread",
        status: "idle",
        isUnread: false,
        isPinned: false,
        projectName: null,
        branchName: null,
      },
      { escStopsRunningThread: false, escapeSuppressed: true },
    );
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
  });
});
describe("Escape on an open menu stays with the menu", () => {
  function PaneWithMenu({ menuOpen, onMenuClose }: { menuOpen: boolean; onMenuClose: () => void }) {
    return createElement(
      "div",
      null,
      paneElement({ id: "thr_test", displayTitle: "Test thread", status: "active", isUnread: false, isPinned: false, projectName: null, branchName: null }),
      createElement(
        MenuPopover,
        { open: menuOpen ? { x: 10, y: 10 } : null, onClose: onMenuClose, label: "Thread actions", title: "t" },
        createElement(MenuPopoverEntry, { label: "Pin", icon: "Pin", onRun: noop }),
      ),
    );
  }

  it("closes the menu without stopping the thread; the next Escape reaches the pane undebounced", () => {
    const onMenuClose = vi.fn();
    const { rerender } = render(createElement(PaneWithMenu, { menuOpen: true, onMenuClose }));
    // Fired on the focused menu entry, as a real keydown would be.
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onMenuClose).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    rerender(createElement(PaneWithMenu, { menuOpen: false, onMenuClose }));
    pressEscape();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
