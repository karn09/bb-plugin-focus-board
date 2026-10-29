// @vitest-environment jsdom
// Issue #174: the collapsed child-dot strip works per child instead of per
// family. Hovering one child's dot shows a preview of that child (title plus
// what the SDK exposes: state label, last-activity age, indicator label — the
// SDK does not expose a thread's messages); clicking a dot opens that child in
// the thread pane WITHOUT expanding the family's nested rows; and while the
// rows stay collapsed, the family's currently open child (and only it) is
// listed below the strip.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { ThreadCard, previewLeftFor } from "../components/thread-card";
import { thread } from "./thread-fixture";

function family(): { parent: PluginSidebarThread; children: PluginSidebarThread[] } {
  return {
    parent: thread({ id: "thr_parent", displayTitle: "Parent", updatedAt: 5000 }),
    children: [
      thread({ id: "thr_c1", parentThreadId: "thr_parent", displayTitle: "Child one", updatedAt: 4000 }),
      thread({ id: "thr_c2", parentThreadId: "thr_parent", displayTitle: "Child two", isUnread: true, updatedAt: 3900 }),
      thread({
        id: "thr_c3",
        parentThreadId: "thr_parent",
        displayTitle: "Child three",
        status: "active",
        updatedAt: 3800,
        indicator: "background-agent",
        indicatorLabel: "Background agent running",
      }),
    ],
  };
}

type CardProps = Parameters<typeof ThreadCard>[0];

function renderCard(overrides: Partial<CardProps> = {}) {
  const { parent, children } = family();
  const props = {
    thread: parent,
    stateDot: null,
    isActive: false,
    isDone: false,
    projectName: "One",
    onOpen: vi.fn(),
    onOpenThread: vi.fn(),
    childThreads: children,
    ...overrides,
  } as unknown as CardProps;
  return render(<ThreadCard {...props} />);
}

function toggle(collapsed: boolean): HTMLElement {
  const button = document.querySelector(
    `button[data-child-threads-toggle][aria-label="${collapsed ? "Expand subthreads" : "Collapse subthreads"}"]`,
  );
  if (!(button instanceof HTMLElement)) throw new Error("missing child-section toggle");
  return button;
}

function dots(): HTMLElement {
  const strip = document.querySelector("[data-child-thread-dots]");
  if (!(strip instanceof HTMLElement)) throw new Error("missing child dot strip");
  return strip;
}

/** One dot button in the collapsed strip, by its child id. */
function dot(id: string): HTMLElement {
  const button = document.querySelector<HTMLElement>(`button[data-child-dot="${id}"]`);
  if (button === null) throw new Error(`missing dot for ${id}`);
  return button;
}

/** The hover preview bubble: a single fixed-position portal node, open
 * only while a dot is hovered or focused. Opens one by enter. */
function openPreview(id: string): HTMLElement {
  fireEvent.mouseEnter(dot(id));
  const bubble = document.querySelector("[data-child-dot-preview]");
  if (!(bubble instanceof HTMLElement)) throw new Error(`missing open preview for ${id}`);
  return bubble;
}

function activeRow(): HTMLElement | null {
  return document.querySelector("[data-child-active-row]");
}

function row(id: string): HTMLElement | null {
  return document.querySelector(`[data-thread-card="${id}"]`);
}

afterEach(cleanup);

describe("a child dot's hover preview", () => {
  // The bubble renders through a portal to body, fixed-positioned from the
  // dot's viewport rect at enter/focus — NOT inside the dot button: the
  // card wrapper is overflow-hidden and the board's scroller clips too, so
  // an in-card bubble was constrained to the card box (operator report).

  it("carries the child's title", () => {
    renderCard({ isCollapsed: true });
    expect(openPreview("thr_c2").textContent).toContain("Child two");
  });

  it("carries the child's state label and indicator label", () => {
    renderCard({ isCollapsed: true });
    // thr_c2 is unread; thr_c3 runs an agent with the host's indicator label.
    expect(openPreview("thr_c2").textContent).toContain("Unread");
    expect(openPreview("thr_c3").textContent).toContain("Background agent running");
  });

  it("sizes to its content, capped at the preview width", () => {
    // The fixed bubble's shrink-to-fit base is the viewport (the portal
    // left the 16px dot's coordinate space), so it hugs short content
    // instead of reserving the full cap's width (operator report: too much
    // empty space at the right), and long titles stop at the cap.
    renderCard({ isCollapsed: true });
    const bubble = openPreview("thr_c2");
    const classes = bubble.className.split(" ");
    expect(classes).toContain("w-max");
    expect(classes).toContain("max-w-64");
    expect(classes).not.toContain("w-64");
    expect(bubble.firstElementChild?.className).toContain("line-clamp-2");
  });

  it("opens over the hovered dot, not inside the card's box", () => {
    renderCard({ isCollapsed: true });
    const bubble = openPreview("thr_c2");
    expect(bubble.className).toContain("fixed");
    expect(bubble.parentElement).toBe(document.body);
    // Closed on leave: the portal node goes away entirely.
    fireEvent.mouseLeave(dot("thr_c2"));
    expect(document.querySelector("[data-child-dot-preview]")).toBeNull();
  });

  it("lights an amber halo behind the dot while it is hovered or focused", () => {
    renderCard({ isCollapsed: true });
    const button = dot("thr_c2");
    // The halo rides the button's own hover/focus (the group-hover variant
    // cannot style a button from its own group marker — `:is(.group:hover *)`
    // matches only descendants, and the halo target IS the group element).
    // Amber: the grey accent wash was too subtle at this size (operator).
    expect(button.className).toContain("hover:bg-amber-500/20");
    expect(button.className).toContain("focus-visible:bg-amber-500/20");
    expect(button.className).not.toContain("hover:bg-accent");
  });

  it("is aria-hidden: the dot's aria-label carries the child's name for screen readers", () => {
    renderCard({ isCollapsed: true });
    const button = dot("thr_c2");
    expect(button.getAttribute("aria-label")).toContain("Child two");
    expect(openPreview("thr_c2").hasAttribute("aria-hidden")).toBe(true);
  });
});

describe("the preview bubble clamps itself to the viewport", () => {
  // The bubble centers on its dot but a dot near a screen edge pushed the
  // bubble's far half off screen (operator report). previewLeftFor is the
  // pure decision — the clamped left edge; the dot's enter/focus handlers
  // feed it the dot's center and apply the result as the bubble's inline
  // style.
  it("centers a dot with room on both sides", () => {
    expect(previewLeftFor(508, 1200)).toBe(380); // 508 - 128
  });

  it("clamps to the screen's left margin for a dot near the left edge", () => {
    // Dot center 8px: centering would put the bubble's left edge at -120;
    // it holds at the 8px margin instead.
    expect(previewLeftFor(8, 1200)).toBe(8);
  });

  it("clamps to the screen's right margin for a dot near the right edge", () => {
    // Dot center 1180px: centering would put the bubble's right edge at
    // 1308; it holds so its right edge sits 8px inside the 1200 viewport.
    expect(previewLeftFor(1180, 1200)).toBe(936);
  });

  it("a viewport narrower than the bubble still gets an on-screen left", () => {
    expect(previewLeftFor(100, 200)).toBe(8);
  });

  it("mouse-enter applies the clamp as the bubble's inline left", () => {
    renderCard({ isCollapsed: true });
    const bubble = openPreview("thr_c1");
    // jsdom rects collapse to 0,0: the dot's center is 0, so the clamp
    // holds the bubble at the 8px margin; the exact number is the pure
    // function's contract above, the wiring's is a clamped left at all.
    expect(bubble.style.left).toBe("8px");
  });

  it("a fresh hover over another dot re-decides the placement", () => {
    renderCard({ isCollapsed: true });
    fireEvent.mouseEnter(dot("thr_c1"));
    fireEvent.mouseEnter(dot("thr_c3"));
    expect(document.querySelector("[data-child-dot-preview]")).not.toBeNull();
  });
});

describe("the child open in the pane reads selected on its dot", () => {
  // The active child's dot holds a persistent emphasis (accent background
  // plus the app's active ring) so the operator can see which dot is the
  // thread open in the pane, matching the listed active row below.
  function activeDot(id: string): HTMLElement {
    const button = dot(id);
    if (!button.hasAttribute("data-child-dot-active")) {
      throw new Error(`dot ${id} does not read selected`);
    }
    return button;
  }

  it("the open child's dot holds the emphasis; its siblings stay quiet", () => {
    renderCard({ isCollapsed: true, onCollapsedChange: vi.fn(), activeThreadId: "thr_c2" });
    const active = activeDot("thr_c2");
    expect(active.className).toMatch(/(^| )bg-accent\//);
    expect(active.className).toMatch(/(^| )ring-2( |$)/);
    expect(dot("thr_c1").hasAttribute("data-child-dot-active")).toBe(false);
    expect(dot("thr_c1").className).not.toMatch(/(^| )bg-accent\//);
    expect(dot("thr_c3").hasAttribute("data-child-dot-active")).toBe(false);
  });

  it("no dot reads selected when nothing in the family is open", () => {
    renderCard({ isCollapsed: true, activeThreadId: null });
    expect(dot("thr_c1").hasAttribute("data-child-dot-active")).toBe(false);
    expect(dot("thr_c2").hasAttribute("data-child-dot-active")).toBe(false);
  });

  it("no dot reads selected when the open thread is not a nested child", () => {
    renderCard({ isCollapsed: true, activeThreadId: "thr_other" });
    expect(dot("thr_c1").hasAttribute("data-child-dot-active")).toBe(false);
  });
});

describe("clicking a child dot opens that child", () => {
  it("opens the child's pane without expanding the family's rows", () => {
    const onOpenThread = vi.fn();
    const onCollapsedChange = vi.fn();
    renderCard({ isCollapsed: true, onCollapsedChange, onOpenThread });
    fireEvent.click(dot("thr_c2"));
    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread).toHaveBeenCalledWith("thr_c2");
    // The family stays folded: no rows render, no expansion is reported.
    expect(row("thr_c1")).toBeNull();
    expect(row("thr_c3")).toBeNull();
    expect(onCollapsedChange).not.toHaveBeenCalled();
    expect(document.querySelector("[data-child-thread-dots]")).not.toBeNull();
  });

  it("keeps the collapse held in local (unpersisted) state", () => {
    renderCard();
    fireEvent.click(toggle(false));
    fireEvent.click(dot("thr_c1"));
    expect(row("thr_c1")).toBeNull();
    expect(document.querySelector("[data-child-thread-dots]")).not.toBeNull();
  });

  it("does not open the child when it lands outside the card's gestures (bubbling blocked)", () => {
    const onOpen = vi.fn();
    renderCard({ isCollapsed: true, onCollapsedChange: vi.fn(), onOpen });
    fireEvent.click(dot("thr_c1"));
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("the active child lists itself below the collapsed strip", () => {
  it("with the active child among the children, only it renders as a row", () => {
    renderCard({ isCollapsed: true, onCollapsedChange: vi.fn(), activeThreadId: "thr_c2" });
    const active = activeRow();
    if (active === null) throw new Error("missing active-child row");
    expect(active.contains(document.querySelector('[data-thread-card="thr_c2"]'))).toBe(true);
    expect(row("thr_c1")).toBeNull();
    expect(row("thr_c3")).toBeNull();
    // It reads as the active row: the open thread's ring marker.
    expect(document.querySelector('[data-thread-card="thr_c2"]')?.getAttribute("aria-current")).toBe("true");
  });

  it("switches to another child when the pane moves to it", () => {
    const view = renderCard({ isCollapsed: true, onCollapsedChange: vi.fn(), activeThreadId: "thr_c1" });
    expect(document.querySelector('[data-thread-card="thr_c1"]')).not.toBeNull();
    view.rerender(threadCardWithActive("thr_c3"));
    expect(document.querySelector('[data-thread-card="thr_c1"]')).toBeNull();
    expect(document.querySelector('[data-thread-card="thr_c3"]')).not.toBeNull();
  });

  it("does not render when nothing in the family is open", () => {
    renderCard({ isCollapsed: true, onCollapsedChange: vi.fn(), activeThreadId: null });
    expect(activeRow()).toBeNull();
  });

  it("does not render when the active thread is not one of the nested children", () => {
    renderCard({ isCollapsed: true, onCollapsedChange: vi.fn(), activeThreadId: "thr_other" });
    expect(activeRow()).toBeNull();
  });

  it("does not render while the rows are expanded — the rows list the whole family", () => {
    renderCard({ activeThreadId: "thr_c2" });
    expect(activeRow()).toBeNull();
    expect(row("thr_c2")).not.toBeNull();
  });

  it("does not render when the pane cannot be opened (no onOpenThread)", () => {
    renderCard({ isCollapsed: true, activeThreadId: "thr_c2", onOpenThread: undefined });
    expect(activeRow()).toBeNull();
  });
});

describe("the strip keeps its expand role", () => {
  it("clicking the strip's background (not a dot) re-expands the rows", () => {
    const onCollapsedChange = vi.fn();
    renderCard({ isCollapsed: true, onCollapsedChange });
    fireEvent.click(dots());
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });
});

describe("the dot grid and the child rows share one dot column", () => {
  // jsdom does no layout, so the alignment contract is pinned at the class
  // level: the strip's indent and glyph geometry put its first dot's left
  // edge at the same x as the rows' dot (strip margin 12px + centered glyph
  // inside its 16px button = 17px; rows: 1px border + 8px padding + the
  // row anchor's own 8px = 17px).
  it("the strip's indent puts its dots in the rows' dot column", () => {
    renderCard({ isCollapsed: true, onCollapsedChange: vi.fn(), activeThreadId: "thr_c2" });
    expect(dots().className).toContain("ml-3");
    expect(dots().className).not.toContain("ml-[18px]");
  });

  it("the active child row uses the rows' indent geometry, not a new one", () => {
    // Render the expanded card to read the rows container's own indent
    // classes, then the collapsed one, and compare: the active row is one
    // of the family's rows, so it must not carry geometry of its own.
    const expanded = renderCard();
    const rows = document.querySelector("[data-nested-rows]");
    if (!(rows instanceof HTMLElement)) throw new Error("missing rows container");
    const rowsGeometry = rows.className;
    expanded.unmount();

    renderCard({ isCollapsed: true, onCollapsedChange: vi.fn(), activeThreadId: "thr_c2" });
    const active = document.querySelector("[data-child-active-row]");
    if (!(active instanceof HTMLElement)) throw new Error("missing active row");
    expect(active.className).toBe(rowsGeometry);
  });
});

describe("the strip flattens the family, a child's sub-dots following its dot", () => {
  // The 2026-10-16 musing (docs/musings/2026-10-16-child-dot-strip-grandchildren.md):
  // the count names the fold tier (rows plus sub-rows, issue #120) while the
  // strip painted one dot per direct child (issue #174), so an orchestrator
  // card read "19 child threads" over nine dots (operator report,
  // 2026-10-16). The strip now paints every rendered member, family-ordered:
  // a child's dot leads its own smaller sub-dots, so the dots and the count
  // agree member for member.

  function grandFamily() {
    const childOne = thread({
      id: "thr_c1",
      parentThreadId: "thr_parent",
      displayTitle: "Child one",
      status: "active",
      updatedAt: 4000,
    });
    const subOne = thread({
      id: "thr_c1_s1",
      parentThreadId: "thr_c1",
      displayTitle: "Sub one",
      status: "idle",
      updatedAt: 3900,
    });
    const subTwo = thread({
      id: "thr_c1_s2",
      parentThreadId: "thr_c1",
      displayTitle: "Sub two",
      status: "idle",
      isUnread: true,
      updatedAt: 3800,
    });
    const childTwo = thread({
      id: "thr_c2",
      parentThreadId: "thr_parent",
      displayTitle: "Child two",
      status: "active",
      updatedAt: 3700,
    });
    return {
      children: [childOne, childTwo],
      subsByParent: new Map([["thr_c1", [subOne, subTwo]]]),
    };
  }

  function renderGrandCard(overrides: Partial<CardProps> = {}) {
    const { children, subsByParent } = grandFamily();
    const props = {
      thread: thread({ id: "thr_parent", displayTitle: "Parent", updatedAt: 5000 }),
      stateDot: null,
      isActive: false,
      isDone: false,
      projectName: "One",
      onOpen: vi.fn(),
      onOpenThread: vi.fn(),
      childThreads: children,
      grandchildThreadsByParent: subsByParent,
      ...overrides,
    } as unknown as CardProps;
    return render(<ThreadCard {...props} />);
  }

  function dotIds(): string[] {
    return Array.from(
      document.querySelectorAll("[data-child-thread-dots] button[data-child-dot]"),
    ).map((button) => button.getAttribute("data-child-dot") ?? "");
  }

  function glyphClasses(id: string): string[] {
    const glyph = dot(id).querySelector("[data-child-dot-glyph]");
    if (glyph === null) throw new Error(`missing glyph for ${id}`);
    return glyph.className.split(" ");
  }

  it("a child's dot leads its sub-dots in family order, never appended at the end", () => {
    renderGrandCard({ isCollapsed: true });
    expect(dotIds()).toEqual(["thr_c1", "thr_c1_s1", "thr_c1_s2", "thr_c2"]);
  });

  it("sub-dots draw one size step smaller than their parent's dot", () => {
    renderGrandCard({ isCollapsed: true });
    expect(glyphClasses("thr_c1")).toContain("size-1.5");
    expect(glyphClasses("thr_c1_s1")).toContain("size-1");
    expect(glyphClasses("thr_c1_s1")).not.toContain("size-1.5");
  });

  it("a family wraps as a unit: the group span never splits across lines", () => {
    renderGrandCard({ isCollapsed: true });
    const group = document.querySelector('[data-child-dot-group="thr_c1"]');
    if (!(group instanceof HTMLElement)) throw new Error("missing child dot group");
    expect(group.className).toContain("flex-nowrap");
  });

  it("clicking a sub-dot opens the sub-thread's pane", () => {
    const onOpenThread = vi.fn();
    renderGrandCard({ isCollapsed: true, onCollapsedChange: vi.fn(), onOpenThread });
    fireEvent.click(dot("thr_c1_s1"));
    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread).toHaveBeenCalledWith("thr_c1_s1");
  });

  it("a sub-dot previews like a child dot: title plus the state the SDK exposes", () => {
    renderGrandCard({ isCollapsed: true });
    expect(openPreview("thr_c1_s2").textContent).toContain("Sub two");
    expect(openPreview("thr_c1_s2").textContent).toContain("Unread");
  });

  it("a parent dot's preview names its sub-threads; a childless dot's does not", () => {
    renderGrandCard({ isCollapsed: true });
    expect(openPreview("thr_c1").textContent).toContain("2 sub-threads");
    expect(openPreview("thr_c2").textContent).not.toContain("sub-thread");
  });

  it("the open sub-thread reads selected on its dot", () => {
    renderGrandCard({ isCollapsed: true, onCollapsedChange: vi.fn(), activeThreadId: "thr_c1_s1" });
    expect(dot("thr_c1_s1").hasAttribute("data-child-dot-active")).toBe(true);
    expect(dot("thr_c2").hasAttribute("data-child-dot-active")).toBe(false);
  });

  it("the idle filter hides an idle sub-dot with its row", () => {
    renderGrandCard({ isCollapsed: true, hideIdleChildren: true });
    // Sub one is idle and hides; sub two (unread) and both working children stay.
    expect(dotIds()).toEqual(["thr_c1", "thr_c1_s2", "thr_c2"]);
  });

  it("the dots agree with the count: the operator's 19-over-9 reading cannot recur", () => {
    // Nine children, the first five carrying two sub-threads each: both the
    // toggle's count and the strip's dots read 19 (the AssetCALC report's
    // numbers, now consistent by construction).
    const children = Array.from({ length: 9 }, (_, index) =>
      thread({
        id: `thr_c${index + 1}`,
        parentThreadId: "thr_parent",
        displayTitle: `Child ${index + 1}`,
        updatedAt: 5000 - index,
      }),
    );
    const subsByParent = new Map<string, PluginSidebarThread[]>();
    for (let parentIndex = 0; parentIndex < 5; parentIndex += 1) {
      subsByParent.set(
        `thr_c${parentIndex + 1}`,
        [1, 2].map((sub) =>
          thread({
            id: `thr_c${parentIndex + 1}_s${sub}`,
            parentThreadId: `thr_c${parentIndex + 1}`,
            displayTitle: `Sub ${parentIndex + 1}.${sub}`,
            updatedAt: 3000,
          }),
        ),
      );
    }
    const props = {
      thread: thread({ id: "thr_parent", displayTitle: "Parent", updatedAt: 6000 }),
      stateDot: null,
      isActive: false,
      isDone: false,
      projectName: "One",
      onOpen: vi.fn(),
      onOpenThread: vi.fn(),
      childThreads: children,
      grandchildThreadsByParent: subsByParent,
      isCollapsed: true,
    } as unknown as CardProps;
    render(<ThreadCard {...props} />);
    const label = document.querySelector("button[data-child-threads-toggle]");
    expect(label?.textContent).toContain("19 child threads");
    expect(dotIds()).toHaveLength(19);
  });
});

function threadCardWithActive(activeThreadId: string) {
  const { parent, children } = family();
  const props = {
    thread: parent,
    stateDot: null,
    isActive: false,
    isDone: false,
    projectName: "One",
    onOpen: vi.fn(),
    onOpenThread: vi.fn(),
    childThreads: children,
    isCollapsed: true,
    onCollapsedChange: vi.fn(),
    activeThreadId,
  } as unknown as CardProps;
  return <ThreadCard {...props} />;
}
describe("Jira Needs-you on the child dot (Task 11)", () => {
  it("a child with a Jira reason shows the attention dot; without the set it stays quiet", async () => {
    const { withNeedsYou } = await import("../components/grouping");
    renderCard({ isCollapsed: true, errorAckIds: withNeedsYou(new Set(), new Set(["thr_c1"])) } as Partial<CardProps>);
    expect(dot("thr_c1").innerHTML).toMatch(/bg-amber-500(?!\/)/);
    cleanup();
    renderCard({ isCollapsed: true });
    expect(dot("thr_c1").innerHTML).not.toMatch(/bg-amber-500(?!\/)/);
  });
});
