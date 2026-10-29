import { isValidElement, memo, type DragEvent, type ReactNode, useState } from "react";
import { createPortal } from "react-dom";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { attentionPulseRef } from "./attention-pulse-gate";
import { DOT_PULSE_ATTR, dotPulseStyle } from "./dot-pulse";
import { pulsePeriodMs } from "@/lib/pulse-rate";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { threadState, THREAD_STATE_LABELS, type StateAcks } from "./grouping";
import { resolveRepoSlug, type TicketRef } from "@/lib/tickets";
import {
  ticketChipRows,
  ticketChipIconHref,
  ticketChipIdText,
  ticketStatusRepo,
  type TicketChip,
  type TicketChipRow,
} from "@/lib/ticket-chips";

import { DRAG_ID_KEY, DOT_DRAG_TYPE, childRankKey, rankDragType } from "../lib/rank";
import { cardTicketRefs, type ThreadLink } from "../lib/link-metadata";
import { describeWakeAt } from "../lib/snooze";
import { usePortalScopeProps } from "../lib/portal-scope";
import { deriveCardStatus } from "./card-status";
import { usePaneCoversBoard } from "./pane-sheet-coverage";
import { ThreadCardMenu, type CardMenuAction } from "./thread-card-menu";
import { useTicketChipFit } from "./use-ticket-chip-fit";
import { useWallpaperActive } from "./wallpaper-contrast";
import { JiraCardSlot } from "./jira-card-badges";

/**
 * The chip placement contract (issue #104): the issues block is held to the
 * first row's left half — the midpoint plus a small gutter — whenever it holds
 * several ids, so its id list reflows onto fresh lines instead of sliding under
 * the PRs block. A lone ticket name may claim the whole row instead.
 */
const CHIP_MIDPOINT_CAP = "max-w-[calc(50%-2px)]";
const CHIP_FULL_ROW = "max-w-full";

/** The tag block's ceiling: it may claim up to 75% of the row, right-anchored. */
const CHIP_TAG_MAX_WIDTH = "max-w-[75%]";

/**
 * An id long enough to need the fit path. Short ids (`#43`) never overflow at
 * any lane width, so only chips carrying a long external key arm the measuring
 * observer — the board's many short-id cards pay nothing.
 */
const LONG_ID_CHARS = 10;

/**
 * The select-with-modifiers gesture on a sweep-mode card click, reduced to
 * what the board's semantics consume: Shift extends the selection from the
 * anchor through the clicked card; cmd/ctrl — and a plain click — toggle
 * just that one. Outside sweep mode modifiers mean browser navigation and
 * never reach here.
 */
export interface SweepClickGesture {
  shiftKey: boolean;
}

function relativeTime(timestamp: number, now: number): string {
  const diff = now - timestamp;
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const ACCENT_CLASS: Record<string, string> = {
  working: "bg-blue-500/70",
  attention: "bg-amber-500/80",
  unread: "bg-emerald-500/70",
  idle: "bg-transparent",
};

const DOT_CLASS: Record<string, string> = {
  working: "bg-blue-500",
  attention: "bg-amber-500",
  unread: "bg-emerald-500",
  idle: "bg-muted-foreground/30",
};

export interface ThreadCardProps {
  thread: PluginSidebarThread;
  stateDot: ReactNode;
  isActive: boolean;
  isDone: boolean;
  /** Done ids; a done nested child (or a done parent's family) renders dimmed. */
  doneIds?: ReadonlySet<string>;
  /**
   * Clear-error acknowledgment ids (issue #157): an acked error arm reads
   * quiet — the card's accent, its dot and its nested child dots alike, so
   * an acknowledged card settles out of Needs you and the family strip
   * stops pulsing for it.
   */
  errorAckIds?: ReadonlySet<string>;
  /** Highlighted because a sweep armed in this column captured the card. */
  isSweepHighlighted?: boolean;
  /**
   * A confirmed sweep is archiving THIS card right now: a throbber on the
   * card while the highlight stays on, so a slow loop reads as progress,
   * not a frozen board.
   */
  isSweeping?: boolean;
  /**
   * Sweep mode is active in this card's column: clicks toggle the card in
   * or out of the sweep selection instead of opening the pane.
   */
  isSweepSelecting?: boolean;
  /**
   * In sweep mode but not selected: a quieter ring marks the card as
   * toggleable, distinct from the selected highlight.
   */
  isSweepSelectable?: boolean;
  /**
   * A sweep-mode card click, with the modifiers users select with: Shift
   * extends the selection from the anchor through this card, cmd/ctrl (and
   * a plain click) toggle just this one.
   */
  onSweepToggle?: (threadId: string, gesture: SweepClickGesture) => void;
  /**
   * The title-row checkbox's write, wired both ways: the "done" menu
   * action's run, which marks a not-done thread done and a done thread not
   * done (the card mirrors: an empty box on not-done cards, a checked one
   * on done). The first click arms, the second fires this. Absent → no
   * checkbox renders (unwired surfaces: compact context minis). The board
   * passes the menu action's run, so the checkbox shares the menu's full
   * done recipe with no second source of truth.
   */
  onMarkDone?: () => void;
  projectName: string;
  menuActions?: readonly CardMenuAction[];
  /** Children that render as nested rows beneath this card, in display order. */
  childThreads?: readonly PluginSidebarThread[];
  /**
   * The sub-row tier: parent id → that parent's nested children, for the
   * rows themselves (a child row nests its own children as sub-rows — issue
   * #120). The same map the board passes for the card tier, so a child row
   * and a standalone card draw from one source; absent → rows render childless.
   */
  grandchildThreadsByParent?: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  /**
   * The same-family nested-row reorder gesture (the board owns every
   * decision — target, guard, write). Wired only when the rows can actually
   * reorder: ranking on, the write available, and the family renders more
   * than one row. Absent → the rows keep their plain drag-out behavior.
   */
  childRankDrag?: {
    onDragOver: (hoverChildId: string, event: DragEvent) => void;
    onDrop: (hoverChildId: string, event: DragEvent) => void;
    onDragLeave: (event: DragEvent) => void;
    /** The row currently carrying the insertion line, and its half. */
    line?: { childId: string; zone: "before" | "after" };
  };
  /**
   * The dot-strip reorder gesture of the same family (issue #249, goals 3
   * and 4): a collapsed strip's dot drags to reorder its own tier of the
   * family, and the preview bubble naming the dragged member stays open for
   * the whole gesture — mid-drag hovers never steal the tooltip. The board
   * owns every decision (tier match, guards, the write), exactly as it does
   * for the row reorder above; the dot is the drag SOURCE and the same-tier
   * dots are its only targets. A dot drag never leaves the hierarchy: the
   * strip authorises nothing outside it (un-parenting is the explicit morph
   * gesture of a later cut). Wired only where reordering is real — ranking
   * on, the write available, and more than one member on the strip. Absent →
   * the dots stay the click-preview controls they have always been.
   */
  childDotDrag?: {
    onDragStart: (memberId: string, event: DragEvent) => void;
    onDragOver: (hoverMemberId: string, event: DragEvent) => void;
    onDrop: (hoverMemberId: string, event: DragEvent) => void;
    onDragEnd: () => void;
    /** The dot currently carrying the insertion line, and its half. */
    line?: { memberId: string; zone: "before" | "after" };
    /**
     * The boundary handoff of the morph (issue #249, goal 5): the board
     * reports the drag left the strip's box, the gesture's tail is now an
     * ordinary card drag, and the dragged member's family card becomes the
     * in-place morph — a soft amber ring and a gentle dim on the card root
     * (`data-dot-escape`), while the pinned bubble expands to the full-card
     * surface by gaining the project and branch line. The insertion line
     * dies with the escape; no dot-specific promise survives it.
     */
    escaped?: boolean;
  };
  /**
   * The strip as a nest target for a CARD drag (issue #249, goal 6): the
   * collapsed dot field claims the dragover so the card's own edge/nest
   * promises never fire under the cursor, and the drop write is the
   * board's (the existing reparent path, guard included). Unclaimed for
   * dot-marked drags: they keep their home rules on the same surface.
   */
  stripNestDrag?: {
    onDragOver: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
    onDragLeave: () => void;
  };
  /**
   * The hover report behind the collapse: the CARD the strip would child,
   * with the pointer position for the pinned bubble. Non-null only while a
   * card drag hovers THIS family's strip; the dragged card collapses into
   * tooltip plus dot (an amber-ringed strip, a trailing ghost dot, and the
   * full-card bubble at the pointer), and everything clears on leave, drop,
   * and dragend.
   */
  stripNestHover?: { member: PluginSidebarThread; x: number; y: number } | null;
  /**
   * The child-count chip's number: ALL visible children of this parent
   * (including ones rendering standalone), not just the nested rows.
   */
  childCount?: number;
  /** Reduced opacity for family members that did not match the filters. */
  dimmed?: boolean;
  /**
   * The lane this card's drag belongs to. Written into the drag type name so
   * the board can recognise a same-lane drag during `dragover`, which is the
   * only moment it can authorise the drop.
   */
  rankKey?: string;
  /**
   * Snooze wake lookup (lib/snooze): the wake epoch-ms for a snoozed thread,
   * null when it is not snoozed. A snoozed card dims in place, carries a
   * "Snoozed · wakes …" chip, and refuses drag so it cannot join the very
   * sweeps and lane moves its sleep is meant to skip. Applies to nested
   * child rows too, via the same lookup.
   */
  snoozeFor?: (threadId: string) => number | null;
  /**
   * Token burn rate lookup in tokens per second (issue #279), from
   * `usePulseRates`. The collapsed strip's `working` dots pulse at a period
   * derived from it (lib/pulse-rate); an absent id is the honest unmeasured
   * state and holds the base period. Consulted for the strip's members only.
   */
  pulseRateFor?: (threadId: string) => number | undefined;
  /** Reports the card a drag started on, so the board can hold it. */
  onRankDragStart?: (threadId: string | null) => void;
  onOpen: () => void;
  /** The currently open thread; a nested child row matching it is highlighted. */
  activeThreadId?: string | null;
  /**
   * A caller-forced focus-solid marker (the `data-focus-solid` attribute in
   * the render): the parent-lane board renders a family as sibling cells
   * rather than nested rows, so it forces the marker on the lane's cells
   * when the lane holds the focused thread. Marker only — the solid surface
   * stays with the focused thread's own card.
   */
  familySolid?: boolean;
  /**
   * The dissolve slot's old-lane copy of the card (a transport ghost): the
   * slot li is already aria-hidden and inert, so the anchor never reports
   * `aria-current` either — the live card owns the marker. A ghost that
   * claims current makes the board's active-card locator resolve DOM-first
   * in the OLD lane, and once the destination scroll moves that lane
   * offscreen the marker reads a card that is not where the board followed
   * (issue #105). Decorative marking only: the active ring and slot visuals
   * are untouched.
   */
  isTransportGhost?: boolean;
  /** Open a (nested child) thread's pane. */
  onOpenThread?: (threadId: string) => void;
  /** Right-click menu actions for a nested child thread. */
  childMenuActions?: (thread: PluginSidebarThread) => readonly CardMenuAction[];
  /**
   * Controlled collapsed state for the nested rows: true hides the rows and
   * shows the collapsed "N child threads" summary in their place. Absent →
   * uncontrolled local state, so callers that do not persist still get a
   * working toggle.
   */
  isCollapsed?: boolean;
  /** Reports a collapse/expand gesture. Paired with `isCollapsed`. */
  onCollapsedChange?: (collapsed: boolean) => void;
  /**
   * Controlled idle-children filter: true hides the family's idle children in
   * BOTH views — the nested rows and the collapsed dot strip. Absent →
   * uncontrolled local state, so callers that do not persist still get a
   * working toggle (the same fallback as the fold above).
   */
  hideIdleChildren?: boolean;
  /** Reports an idle-filter gesture. Paired with `hideIdleChildren`. */
  onHideIdleChildrenChange?: (hide: boolean) => void;
  /** GitHub repo base for the thread's project, when it has one. */
  repoHrefBase?: string;
  /** GitHub cache status lookup (repo slug + number), when it is wired. The
   *  lookup's shape is the RPC WIRE's minimal `{kind, state}`, not the
   *  server-side `GitHubItemStatus` — the RPC strips `updatedAtMs` before the
   *  board ever sees a row, and the chip's glyph reads kind and state only. */
  statusFor?: (repo: string | null, number: number | undefined) =>
    | { kind: string; state: string }
    | undefined;
  /**
   * The board's own links for this thread (metadata key "linkedIssues"):
   * GitHub items a thread's text never names, from the link CLI / tool.
   * They join the chip row like text refs — see lib/link-metadata.ts.
   */
  linkedIssues?: ThreadLink[];
  /**
   * Issue #191: the board's links per child thread id — the lookup behind
   * the cards' `linkedIssues`, reused so nested child rows chip exactly
   * what each child chips standalone. Absent → child rows chip text refs
   * only.
   */
  childLinkedIssuesFor?: (threadId: string) => ThreadLink[] | undefined;
  /**
   * Hrefs the server's tracker_validate confirmed as existing (the chip
   * rule: a text ref chips only when something attached to the project can
   * validate it). Store links skip validation and always chip. Undefined =
   * caller not wired to validation → the pre-validation behavior (chips
   * render unfiltered), which keeps component-level previews sane.
   */
  validatedHrefs?: ReadonlySet<string>;
  // Ruler+wrap mini variant: fits the 136×92 context card grid.
  compact?: boolean;
  /**
   * Attention reporting (components/attention-freeze): the caller captures
   * the card's rendered placement when the pointer enters it and releases
   * the pin on leave — the freeze that keeps an attended card from moving.
   * Nested child rows report too, with their own id.
   */
  onAttentionEnter?: (threadId: string) => void;
  onAttentionLeave?: (threadId: string) => void;
}

/** Glyph shapes' colors: open is the one colored state; merged and closed read plain. */
const STATUS_ICON_CLASS: Record<string, string> = {
  OPEN: "text-emerald-500",
  CLOSED: "text-muted-foreground/50",
};

/**
 * One pinned preview bubble (issue #174's shape): the member's title above
 * a supporting line under it, FIXED over the anchor from its viewport rect,
 * portaled to body — the card wrapper is overflow-hidden and the board's
 * scroller clips too, so an in-card bubble would be constrained to the card
 * box (operator report). Decorative only (aria-hidden); the anchor's
 * aria-label carries its name for screen readers. The left is
 * previewLeftFor's screen-edge clamp; the bottom sits a hair above the
 * anchor's top edge. Three variants share the shape: a DOT's hover preview
 * (`dot`, the pre-drag reading), the dot-morph's full-card expansion
 * (`drag`, issue #249 goal 5: the project and branch line joins), and the
 * strip-nest collapse (`strip`, goal 6: the hovered CARD's surface read at
 * the pointer).
 */
function DotPreviewBubble({
  member,
  projectName,
  centerX,
  topY,
  variety,
  subCount = 0,
}: {
  member: PluginSidebarThread;
  projectName: string;
  centerX: number;
  topY: number;
  variety: "dot" | "drag" | "strip";
  subCount?: number;
}): ReactNode {
  const now = Date.now();
  return createPortal(
    <span
      aria-hidden
      data-child-dot-preview=""
      data-strip-nest={variety === "strip" ? "" : undefined}
      // The portal leaves the plugin's scoping root, so it carries
      // the dialog-overlay scope attributes (lib/portal-scope) —
      // without them the compiled utilities never match the body
      // child and the bubble renders unstyled.
      {...usePortalScopeProps()}
      className="pointer-events-none fixed z-50 mb-0 w-max max-w-64 rounded border border-border bg-popover px-2 py-1 text-left shadow-md"
      style={{
        // Border-box explicit: the compiled CSS ships without a
        // preflight (the host provides it), and a body-level portal
        // lives where that guarantee need not hold — without this,
        // the width carried the padding and borders and the clamp's
        // arithmetic drifted.
        boxSizing: "border-box",
        left: previewLeftFor(centerX, window.innerWidth, CHILD_PREVIEW_WIDTH_PX),
        top: topY - 4,
        transform: "translateY(-100%)",
      }}
    >
      <span className="block line-clamp-2 text-[11px] font-medium leading-tight text-popover-foreground">
        {member.displayTitle}
      </span>
      <span className="mt-0.5 block text-[10px] leading-tight text-popover-foreground/70">
        {THREAD_STATE_LABELS[threadState(member)] ?? threadState(member)}{" "}
        · {relativeTime(member.updatedAt, now)}
        {member.indicatorLabel === null ? null : ` · ${member.indicatorLabel}`}
      </span>
      {variety === "dot" ? null : (
        // The full-card supporting lines: the goal-5 morph (drag) and the
        // goal-6 collapse (strip) both read as the member's card surface.
        <span className="mt-0.5 block truncate text-[10px] leading-tight text-popover-foreground/70">
          {projectName}
          {(member.environment?.branchName ?? member.host?.name ?? "") === ""
            ? null
            : ` · ${member.environment?.branchName ?? member.host?.name ?? ""}`}
        </span>
      )}
      {subCount > 0 ? (
        <span className="mt-0.5 block text-[10px] leading-tight text-popover-foreground/70">
          {subCount} {subCount === 1 ? "sub-thread" : "sub-threads"}
        </span>
      ) : null}
    </span>,
    document.body,
  );
}

/**
 * The family card's rows fold to this many whole rows; the rest go behind a
 * "Show all" handle. A whole-row budget replaces the old pixel cap
 * (`max-h-64` plus an overflow scroll): a pixel cap cannot end on a row
 * boundary, so it sliced the last row and hid the rest behind an overlay
 * scrollbar with no affordance (operator report 2026-10-22, "grandchildren
 * don't pop out"). Counting rows bounds the card at roughly the old height
 * while every rendered row stays whole, and the withheld rows stay one
 * click away.
 */
export const FAMILY_ROWS_BEFORE_FOLD = 5;

/** One rendered family row: a child row and the sub-rows the fold kept under it. */
export interface FoldedFamilyRow {
  child: PluginSidebarThread;
  subRows: readonly PluginSidebarThread[];
}

export interface FoldedFamilyRows {
  /** The rows to render now, in family order. */
  rows: FoldedFamilyRow[];
  /** Every visible row in the family: child rows plus their sub-rows. */
  totalRows: number;
  /** True when rows were withheld, so a Show all handle is due. */
  folded: boolean;
}

/**
 * Fold the family's rows to a whole-row budget, in family order: each child
 * row, then as many of its sub-rows as the budget still allows. Children
 * keep the sub-rows that fit under them, so a fold never reorders the family
 * or strands a child from its own sub-rows. `showAll` renders every row and
 * reports `folded: false`.
 */
export function foldFamilyRows(
  children: readonly PluginSidebarThread[],
  subRowsFor: (parentId: string) => readonly PluginSidebarThread[],
  showAll: boolean,
  budget: number = FAMILY_ROWS_BEFORE_FOLD,
): FoldedFamilyRows {
  const totalRows = children.reduce(
    (count, child) => count + 1 + subRowsFor(child.id).length,
    0,
  );
  if (showAll || totalRows <= budget) {
    return {
      rows: children.map((child) => ({ child, subRows: subRowsFor(child.id) })),
      totalRows,
      folded: false,
    };
  }
  const rows: FoldedFamilyRow[] = [];
  let remaining = Math.max(0, budget);
  for (const child of children) {
    if (remaining <= 0) break;
    remaining -= 1; // the child's own row
    const subs = subRowsFor(child.id);
    const take = subs.slice(0, Math.max(0, remaining));
    remaining -= take.length;
    rows.push({ child, subRows: take });
  }
  return { rows, totalRows, folded: true };
}

/**
 * The collapsed dot's hover preview bubble width CAP (the `max-w-64`
 * class; both are `--spacing * 64` at the default scale). The bubble
 * itself sizes to its content (`w-max`): the fixed portal's shrink-to-fit
 * base is the viewport, so short previews hug their text. The viewport
 * clamp assumes the CAP as the worst case — a narrower bubble can only
 * land further inside the clamped left, never off screen.
 */
export const CHILD_PREVIEW_WIDTH_PX = 256;

/** The margin the bubble keeps from the screen's edges. */
const PREVIEW_VIEWPORT_MARGIN_PX = 8;

/**
 * The hover preview bubble's left edge for one dot against the viewport
 * (issue #174's overflow follow-up): the bubble centers on its dot, and a
 * dot near a screen edge pushes half the bubble off screen. The clamped
 * left holds it on screen instead. The bubble renders as a fixed-position
 * portal to body, so no ancestor — the overflow-hidden card, the lanes, the
 * board's own scroller — can clip it.
 */
export function previewLeftFor(
  dotCenterX: number,
  viewportWidth: number,
  bubbleWidth: number = CHILD_PREVIEW_WIDTH_PX,
): number {
  const min = PREVIEW_VIEWPORT_MARGIN_PX;
  const max = Math.max(
    min,
    viewportWidth - PREVIEW_VIEWPORT_MARGIN_PX - bubbleWidth,
  );
  return Math.round(Math.min(Math.max(dotCenterX - bubbleWidth / 2, min), max));
}

/**
 * The card spotlight (issue #123): while ONE card is under the pointer, the
 * other cards recede a step and the hovered one never does. The rule is
 * hand-written and injected once by components/card-spotlight.ts — one block,
 * one exemption list (the hovered card, plus the `data-spotlight-immune`
 * marker components/card-status.ts computes). Pure CSS; the card just wears
 * the marker. The pane-open card arms a second arm of the same rule through
 * `data-focus-solid`; see components/card-spotlight.ts.
 */
/**
 * The hovered card's surface, one source of truth. Scheme-aware since the
 * #195 follow-up: in the DARK theme the card token mixes toward BLACK — an
 * OPAQUE surface darker than the rest state, where darkening IS the emphasis
 * (`accent` was the first cut: it is ink-ward, so on the dark canvas it
 * LIGHTENED the hovered card, the opposite of the prominence the operator
 * asked for). The LIGHT theme keeps the card's opaque surface untouched: the
 * same mix darkens a near-white card (98.5%) into mid-gray (78.8%), and on a
 * light canvas that reads MUTED, not emphasized (#195) — the hover ring
 * (`hover:ring-border`) plus the spotlight's sibling recede carry the
 * emphasis there instead. The `dark:` variant is Tailwind's media-based
 * scheme switch, the same one the amber banners already ride.
 */
export const HOVER_SURFACE =
  "dark:hover:bg-[color-mix(in_oklab,var(--card)_80%,black)]";

/**
 * The solid surface the pane-held (focused) card keeps: the click-into twin
 * of HOVER_SURFACE. The same card token mixed toward BLACK under the same
 * `dark:` scheme rule (#195), so the DARK canvas holds the darker, opaque
 * surface for as long as the thread pane stays open, while the LIGHT canvas
 * leaves the card surface untouched and the active ring plus the recede
 * carry the emphasis. ThreadCard applies it to the card wearing
 * `data-focus-solid`; see components/card-spotlight.ts for the recede arm.
 */
export const CARD_SURFACE_SOLID =
  "dark:bg-[color-mix(in_oklab,var(--card)_80%,black)]";

/**
 * One provider-grouped chip (lib/ticket-chips.ts): all the provider's IDs of
 * one kind (issue or pull) inside a single chip shell — the provider mark
 * leading, the kind glyph naming the chip's kind, then one link per ID.
 *
 * The mark names the tracker: GitHub's brand on github.com, else the site's
 * favicon (falling back to a generic ticket glyph). It links to that kind's
 * list page: the repo's filtered page where the group's base is known,
 * GitHub's own global page otherwise; an unknown external tracker's mark
 * stays inert. Each ID keeps its own href, and the kind glyph names issue vs
 * PR wherever the tracker encodes one (GitHub and Forgejo both do),
 * carrying the state color on GitHub, where it is read from the group's
 * primary (first) ref's status; a Forgejo glyph reads plain until a state
 * source exists. ID text stays neutral and each ID's state survives on its
 * hover title. The chip's id flow wraps, so a long ID list reflows onto
 * extra lines instead of overflowing the card.
 */
function ProviderTicketChip({
  row,
  chip,
  statusFor,
  projectRepo,
  condensed = false,
  interactive = true,
}: {
  row: TicketChipRow;
  chip: TicketChip;
  statusFor?: (repo: string | null, number: number | undefined) =>
    | { kind: string; state: string }
    | undefined;
  projectRepo: string | null;
  /**
   * Issue #191: the nested child row's smaller cut — tighter min-height,
   * one text step down, smaller marks. The card's own chip rows stay the
   * full size.
   */
  condensed?: boolean;
  /**
   * The row variant renders INSIDE the child row's own anchor (issue
   * #127): a link inside the link is forbidden HTML (#171's rule), so the
   * non-interactive cut renders its mark and ids as spans — the ids keep
   * their labels and hover bubbles, the hrefs never appear. Default true
   * renders the card's own anchors.
   */
  interactive?: boolean;
}) {
  // External providers show the site's favicon (forgejo bases, external
  // links — each carries its hostname; bb's app shell sets no CSP header,
  // verified 2026-10-08, so the browser may load it directly). A failed or
  // blocked load collapses to the plain ticket glyph.
  const [faviconFailed, setFaviconFailed] = useState(false);
  const isGithub = row.provider === "github";
  const markHref = ticketChipIconHref(row, chip.kind);
  // The ids' vertical anchor: a chip whose ids all fit one line centers its
  // content vertically (the shell's min-height would otherwise leave the
  // mark, glyph, and ids hugging the top); a many-id chip keeps them
  // top-anchored so the mark and glyph stay pinned at the top-left corner
  // beside the first id line. The ref count stands in for "fits one line"
  // — short ids do for three or fewer; very long external labels that wrap
  // stay centered, a harmless cosmetic drift.
  const singleRow = chip.refs.length <= 3;
  // A long id (an external ticket key) may overflow its chip; the fit hook
  // scales the text down to keep it on one line (issue #104, mock 5). Short
  // ids never overflow, so they skip the measurement entirely.
  const needsFit =
    !condensed &&
    chip.refs.some((ref) => ticketChipIdText(ref).length > LONG_ID_CHARS);
  const idsFlowRef = useTicketChipFit(needsFit);
  const className = cn(
    "inline-flex min-w-0 max-w-full gap-x-1 rounded bg-muted py-0.5 font-mono leading-none text-muted-foreground",
    // The condensed cut (nested child rows): one min-height and text step
    // down plus a tighter pad, per the operator's spec — smaller, more
    // compressed than the full card's chip row.
    condensed ? "min-h-4 px-0.5 text-[9px]" : "min-h-5 px-1 text-[10px]",
    singleRow ? "items-center" : "items-start",
  );
  const markSize = condensed ? "size-2.5 shrink-0" : "size-3 shrink-0";
  const mark =
    isGithub ? (
      <Icon name="GithubMark" className={markSize} aria-hidden />
    ) : row.hostname !== undefined && !faviconFailed ? (
      <img
        src={`https://${row.hostname}/favicon.ico`}
        alt=""
        loading="lazy"
        className={`${markSize} rounded-[2px]`}
        onError={() => setFaviconFailed(true)}
      />
    ) : (
      <Icon name="Ticket" className={markSize} aria-hidden />
    );
  const markElement = interactive && markHref ? (
    <a
      href={markHref}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      title={chip.kind === "pull" ? "Pull requests list" : "Issues list"}
      className="inline-flex shrink-0"
      data-ticket-chip-mark=""
    >
      {mark}
    </a>
  ) : (
    <span className="inline-flex shrink-0" data-ticket-chip-mark="">
      {mark}
    </span>
  );
  // The kind glyph self-corrects the moment status arrives: the primary
  // ref's live state names it (merged PR → merge glyph, closed → closed
  // glyph), defaulting to the open shapes before status lands. Status kind
  // overrides the chip's structural kind too — a kindless "#N" that turns
  // out to be a merged PR swaps to the pull shapes. A GitHub ref always
  // leads a glyph. An external ref leads one when it names an ITEM (it has a
  // number): a Forgejo id defaults to the issue glyph like GitHub's does,
  // and a `/pulls/N` URL or a hydrated store kind names the PR. A tracker
  // item with no item number (a Linear "PROJ-142" label) shows no glyph —
  // its favicon names the source, and calling it an issue would be a guess.
  const primary = chip.refs[0];
  const primaryStatus =
    isGithub && primary !== undefined
      ? statusFor?.(ticketStatusRepo(primary, projectRepo), primary.number)
      : undefined;
  const kind = primaryStatus?.kind === "pull" ? "pull" : chip.kind;
  const showKindGlyph = isGithub || primary?.number !== undefined;
  const kindGlyph = showKindGlyph ? (
    <Icon
      name={
        kind === "pull"
          ? (primaryStatus?.state === "MERGED"
              ? "Merge"
              : primaryStatus?.state === "CLOSED"
                ? "PullRequestClosed"
                : "PullRequest")
          : (primaryStatus?.state === "CLOSED" ? "IssueClosed" : "IssueOpen")
      }
      className={cn(
        "shrink-0",
        condensed ? "size-2.5" : "size-3",
        primaryStatus === undefined
          ? undefined
          : STATUS_ICON_CLASS[primaryStatus.state],
      )}
      aria-label={
        primaryStatus === undefined
          ? isGithub
            ? undefined
            : primary?.number !== undefined
              ? `${kind} #${primary.number}`
              : kind
          : `${kind} ${primaryStatus.state}`
      }
    />
  ) : null;
  // External items name their own tracker in the favicon and carry no
  // GitHub kind glyph.
  const ids = chip.refs.map((ref, index) => {
    // The kind glyph keeps the state shape (and open's emerald); merged and
    // closed glyphs and all id text read plain. A merged id dims grey and
    // strikes through so it reads as done, with no color on hover. Each id
    // enlarges on hover by transform — never a layout change, so no id ever
    // bumps a neighbor. The row variant's ids render as spans: the child row
    // is one anchor (#127), so the id never nests a link in it (#171's
    // contract) — the label, state, and bubble all survive, the href does not.
    const status =
      isGithub && ref.number !== undefined
        ? statusFor?.(ticketStatusRepo(ref, projectRepo), ref.number)
        : undefined;
    const title = status === undefined ? undefined : `${status.kind} ${status.state}`;
    const text = ticketChipIdText(ref);
    // The bubble repeats the id above the cell — a native title tooltip
    // draws under the pointer and gets hidden by it, so the id gets its own
    // bubble that the cursor cannot cover. The hover title keeps its state
    // role; the id itself rides an aria-label for keyboard and screen
    // readers.
    const cell = "group/id relative inline-flex origin-left whitespace-nowrap transition-transform hover:scale-110";
    const bubble = (
      <span
        data-ticket-tip=""
        className="pointer-events-none absolute bottom-full left-0 z-20 mb-1 hidden whitespace-nowrap rounded border border-border bg-popover px-1.5 py-0.5 font-mono text-[10px] leading-none text-popover-foreground shadow-md group-hover/id:block"
      >
        {text}
      </span>
    );
    const body = (
      <span className={status?.state === "MERGED" ? "line-through opacity-60" : undefined}>
        {text}
      </span>
    );
    return ref.href === undefined || !interactive ? (
      <span key={index} title={title} aria-label={text} className={cell} data-ticket-id={text}>
        {body}
        {bubble}
      </span>
    ) : (
      <a
        key={index}
        href={ref.href}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
        title={title}
        aria-label={text}
        className={cell}
        data-ticket-id={text}
      >
        {body}
        {bubble}
      </a>
    );
  });
  return (
    <span className={className} data-ticket-chip="" data-provider-row={row.key}>
      {markElement}
      {kindGlyph}
      {/* The ids sit in a wrapping flex flow: no fixed tracks, so a short
          list reserves no phantom width (the empty-column-gap trap of the
          old three-track grid) and a list of wide external labels wraps onto
          extra lines instead of overflowing the card. min-w-0 lets the shell
          shrink with the row so this flow, not the shell, does the wrapping;
          the mark and glyph never join the id flow. Every id stays nowrap, so
          the flow breaks only BETWEEN ids, never inside one; a lone id wider
          than the room scales down through useTicketChipFit instead of
          breaking (issue #104). */}
      <span
        ref={idsFlowRef}
        data-ticket-ids
        data-ticket-ids-fit={needsFit ? "" : undefined}
        className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5"
      >
        {ids}
      </span>
    </span>
  );
}

/**
 * One tag chip (issue #104): a free-text external label — an external link that
 * names no tracker item, so it earns no issue/PR glyph and never joins the
 * issue/PR pair. A tag names a theme rather than an item's source, so its mark
 * is the generic globe instead of a favicon.
 *
 * Placement is the card's: tags live in a bottom-right, right-anchored block.
 * The text never shrinks and never breaks mid-word; it wraps only at its own
 * word separators (the hyphens in a slug like
 * `mobile-notifications-badging-rollout-v12-alpha`), which is CSS's default
 * break set once `white-space` stays normal.
 */
function TagChip({ row, tagRef }: { row: TicketChipRow; tagRef: TicketRef }) {
  const text = ticketChipIdText(tagRef);
  return (
    <span
      className="inline-flex min-h-5 min-w-0 max-w-full items-center gap-x-1 rounded bg-muted px-1 py-0.5 font-mono text-[10px] leading-none text-muted-foreground"
      data-ticket-chip=""
      data-ticket-tag={row.key}
      data-provider-row={row.key}
    >
      {/* An inert mark: a tag is not a list page, so it links nothing. */}
      <span className="inline-flex shrink-0" data-ticket-chip-mark="">
        <Icon name="Globe" className="size-3 shrink-0" aria-hidden />
      </span>
      {tagRef.href === undefined ? (
        <span className="min-w-0 break-normal" data-ticket-id={text}>
          {text}
        </span>
      ) : (
        <a
          href={tagRef.href}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
          title={text}
          aria-label={text}
          className="min-w-0 break-normal"
          data-ticket-id={text}
        >
          {text}
        </a>
      )}
    </span>
  );
}

function ChildRow({
  child,
  dimmed,
  errorAcks = new Set<string>(),
  isActive,
  isTransportGhost = false,
  onOpenThread,
  menuActions,
  snoozeFor,
  rankKey,
  onRankDragStart,
  rankDrag,
  onAttentionEnter,
  onAttentionLeave,
  chipRows,
  statusFor,
  projectRepo = null,
}: {
  child: PluginSidebarThread;
  /** A done child row dims, as does any child of a done parent. */
  dimmed?: boolean;
  /** Clear-error acknowledgment ids (issue #157): an acked error row dot sits quiet. */
  errorAcks?: ReadonlySet<string>;
  /** The open thread's row gets the same active ring a standalone card gets. */
  isActive?: boolean;
  /** The dissolve slot's old-lane copy: never reports aria-current (see ThreadCard's contract). */
  isTransportGhost?: boolean;
  onOpenThread: (threadId: string) => void;
  menuActions?: readonly CardMenuAction[];
  /** Snooze wake lookup, for the row's little clock marker. */
  snoozeFor?: (threadId: string) => number | null;
  /** The parent slot's lane rides along so dropping the child on any lane's
   * floor (its own via the same type, another via the lane mismatch) can
   * read the gesture. */
  rankKey?: string;
  onRankDragStart?: (threadId: string | null) => void;
  /**
   * The same-family reorder gesture from the board (targeting, guards, and
   * the write all live there). Only the row's events and its insertion line
   * live here. Absent → the row stays a drag SOURCE only.
   */
  rankDrag?: {
    onDragOver: (hoverChildId: string, event: DragEvent) => void;
    onDrop: (hoverChildId: string, event: DragEvent) => void;
    onDragLeave: (event: DragEvent) => void;
    line?: { childId: string; zone: "before" | "after" };
  };
  /** Attention reporting for the row itself (nested rows pin their slots). */
  onAttentionEnter?: (threadId: string) => void;
  onAttentionLeave?: (threadId: string) => void;
  /**
   * Issue #191: the child's own provider-grouped chip rows (the same
   * `cardTicketRefs` the thread chips with standalone) — rendered condensed
   * and inert after the title. Absent/empty → no chip block.
   */
  chipRows?: readonly TicketChipRow[];
  /** GitHub cache status lookup for the row's chips, when wired — the RPC
   *  wire's minimal `{kind, state}` (see the card's own prop note). */
  statusFor?: (repo: string | null, number: number | undefined) =>
    | { kind: string; state: string }
    | undefined;
  /** The thread's project repo slug ("owner/repo") for status lookups. */
  projectRepo?: string | null;
}) {
  const now = Date.now();
  const childSnoozeWakeAt = snoozeFor?.(child.id) ?? null;
  const childSnoozed = childSnoozeWakeAt !== null;
  // This row's insertion line (the same-family reorder promise): "before"
  // draws above the row, "after" below — the same affordance card slots get.
  const rowLine =
    rankDrag?.line?.childId === child.id ? (rankDrag.line ? rankDrag.line.zone : undefined) : undefined;
  const row = (
    <a
      href={child.href}
      data-thread-card={child.id}
      data-snoozed={childSnoozeWakeAt !== null ? "" : undefined}
      draggable={!childSnoozed}
      onMouseEnter={onAttentionEnter === undefined ? undefined : () => onAttentionEnter(child.id)}
      onMouseOut={
        onAttentionLeave === undefined
          ? undefined
          : (event) => {
              const from = event.relatedTarget;
              if (from instanceof Node && event.currentTarget.contains(from)) return;
              onAttentionLeave(child.id);
            }
      }
      onDragOver={
        rankDrag === undefined
          ? undefined
          : (event) => rankDrag.onDragOver(child.id, event)
      }
      onDrop={
        rankDrag === undefined ? undefined : (event) => rankDrag.onDrop(child.id, event)
      }
      onDragLeave={(event) => {
        // The line dies only when the pointer truly leaves the row —
        // crossing a span inside it must not flicker the promise away.
        const into = event.relatedTarget;
        if (into instanceof Node && event.currentTarget.contains(into)) return;
        rankDrag?.onDragLeave(event);
      }}
      aria-current={isActive && !isTransportGhost ? "true" : undefined}
      onDragStart={(event) => {
        // A snoozed child refuses drag (`draggable={!childSnoozed}` above);
        // the guard keeps the refusal true even where the attribute is not
        // enforced, so nothing can drag a sleeping card anywhere.
        if (childSnoozed) {
          event.preventDefault();
          return;
        }
        // The un-parent gesture: the child row is a drag source, so dropping
        // it on a column floor detaches it (board.tsx's floor handlers).
        event.dataTransfer.setData(DRAG_ID_KEY, child.id);
        if (rankKey !== undefined) {
          event.dataTransfer.setData(rankDragType(rankKey), "");
          onRankDragStart?.(child.id);
        }
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => onRankDragStart?.(null)}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onOpenThread(child.id);
      }}
      className={cn(
        // Fat row: a compact card-like container — the full title wraps over
        // up to 2 lines (parent cards use line-clamp-2; children match). No
        // branch line, no project line. The whole row is the drag handle:
        // dragging it off a family card and releasing over a column floor
        // un-nests it.
        "relative block rounded-md border border-border/50 bg-muted/40 px-2 py-1.5 text-left",
        "transition-colors hover:bg-accent/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "opacity-70 hover:opacity-100",
        child.isArchived && "saturate-50",
        dimmed && "opacity-50",
        childSnoozeWakeAt !== null && "saturate-50",
        isActive && "ring-2 ring-ring",
        rowLine === "before" &&
          "before:absolute before:inset-x-0 before:-top-0.5 before:h-0.5 before:rounded-full before:bg-ring",
        rowLine === "after" &&
          "after:absolute after:inset-x-0 after:-bottom-0.5 after:h-0.5 after:rounded-full after:bg-ring",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "inline-block size-1.5 shrink-0 rounded-full",
            DOT_CLASS[threadState(child, errorAcks)] ?? "bg-muted-foreground/30",
          )}
          aria-hidden
        />
        {child.isArchived ? (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/70">
            <Icon name="Archive" className="size-3" aria-hidden />
            archived
          </span>
        ) : null}
        {childSnoozeWakeAt !== null ? (
          <span
            data-snooze-chip
            title={`Wakes ${describeWakeAt(childSnoozeWakeAt, now)}`}
            className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground/80"
          >
            <Icon name="Clock" className="size-3" aria-hidden />
            snoozed
          </span>
        ) : null}
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
          {relativeTime(child.updatedAt, now)}
        </span>
      </div>
      <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug">{child.displayTitle}</p>
      {chipRows === undefined || chipRows.length === 0 ? null : (
        // Issue #191: the row's condensed chip rows — one row per provider,
        // left-aligned (no justify-between spread; the row is narrow), each
        // chip the smaller, inert cut of ProviderTicketChip.
        <div data-child-chip-rows="" className="mt-1 flex flex-col gap-0.5">
          {chipRows.map((chipRow) => (
            <div key={chipRow.key} data-provider-row={chipRow.key} className="flex flex-wrap gap-1">
              {chipRow.issues === undefined ? null : (
                <ProviderTicketChip
                  row={chipRow}
                  chip={chipRow.issues}
                  statusFor={statusFor}
                  projectRepo={projectRepo}
                  condensed
                  interactive={false}
                />
              )}
              {chipRow.pulls === undefined ? null : (
                <ProviderTicketChip
                  row={chipRow}
                  chip={chipRow.pulls}
                  statusFor={statusFor}
                  projectRepo={projectRepo}
                  condensed
                  interactive={false}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </a>
  );
  if (menuActions === undefined) return row;
  return (
    <ThreadCardMenu
      anchor={row}
      actions={menuActions}
      href={child.href}
      onOpen={() => onOpenThread(child.id)}
      title={child.displayTitle}
      onOpenChange={(open) =>
        open ? onAttentionEnter?.(child.id) : onAttentionLeave?.(child.id)
      }
    />
  );
}

export function ThreadCardImpl({
  thread,
  stateDot,
  isActive,
  isDone,
  doneIds,
  errorAckIds,
  isSweepHighlighted = false,
  isSweeping = false,
  isSweepSelecting = false,
  isSweepSelectable = false,
  onSweepToggle,
  onMarkDone,
  projectName,
  repoHrefBase,
  statusFor,
  linkedIssues,
  childLinkedIssuesFor,
  validatedHrefs,
  menuActions,
  childThreads,
  grandchildThreadsByParent,
  childCount,
  dimmed,
  rankKey,
  onRankDragStart,
  snoozeFor,
  pulseRateFor,
  onOpen,
  activeThreadId,
  familySolid,
  isTransportGhost = false,
  onOpenThread,
  childMenuActions,
  childRankDrag,
  childDotDrag,
  stripNestDrag,
  stripNestHover,
  isCollapsed,
  onCollapsedChange,
  hideIdleChildren,
  onHideIdleChildrenChange,
  // Ruler+wrap mini cards: tighter padding and type, no ticket chips.
  compact = false,
  onAttentionEnter,
  onAttentionLeave,
}: ThreadCardProps) {
  const now = Date.now();
  // Controlled when `isCollapsed` is supplied (the app persists the set);
  // otherwise local state preserves the pre-persistence toggle behavior.
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const collapsed = isCollapsed ?? localCollapsed;
  const toggleCollapsed = () => {
    if (isCollapsed === undefined) setLocalCollapsed(!collapsed);
    else onCollapsedChange?.(!collapsed);
  };
  // The idle-children filter mirrors the fold's controlled/uncontrolled
  // split exactly: persisted by the app when supplied, local otherwise.
  const [localHideIdle, setLocalHideIdle] = useState(false);
  const hideIdle = hideIdleChildren ?? localHideIdle;
  const toggleHideIdle = () => {
    if (hideIdleChildren === undefined) setLocalHideIdle(!hideIdle);
    else onHideIdleChildrenChange?.(!hideIdle);
  };
  const branch = thread.environment?.branchName ?? thread.host?.name ?? "";
  const repo = repoHrefBase === undefined ? null : resolveRepoSlug(repoHrefBase);
  // The chip rows: text refs after the chip gate + the board's store links
  // (lib/link-metadata's cardTicketRefs), grouped by provider into rows —
  // one row per provider, at most two chips per row (issues left, pulls
  // right), lib/ticket-chips.ts. The toolbar search matches the flat ref
  // set (app.tsx), so a "#38" query still finds every card with a #38 chip.
  const ticketRefs = cardTicketRefs({
    title: thread.displayTitle,
    branch,
    ...(repoHrefBase !== undefined ? { repoHrefBase } : {}),
    linkedIssues,
    ...(validatedHrefs !== undefined ? { validatedHrefs } : {}),
  });
  const chipRows = ticketRefs.length === 0 || compact ? [] : ticketChipRows(ticketRefs);
  // Issue #104's placement contract. The card's chip area is three regions:
  // the issue chips (first row, left, capped at the midpoint when they hold
  // several ids), the PR chips (first row, right), and the tags (bottom-right,
  // right-anchored). Chips gather across providers on purpose: a long external
  // item id and another provider's PR share row one, which is what the
  // contract's mock 4 draws.
  const issueChips: { row: TicketChipRow; chip: TicketChip }[] = [];
  const pullChips: { row: TicketChipRow; chip: TicketChip }[] = [];
  const tagChips: { row: TicketChipRow; ref: TicketRef }[] = [];
  for (const row of chipRows) {
    if (row.issues !== undefined) issueChips.push({ row, chip: row.issues });
    if (row.pulls !== undefined) pullChips.push({ row, chip: row.pulls });
    for (const ref of row.tags ?? []) tagChips.push({ row, ref });
  }
  const issueRefCount = issueChips.reduce((count, entry) => count + entry.chip.refs.length, 0);
  // A lone ticket name may claim the whole first row (the PR chip then bumps
  // to the next row, still right-anchored); several ids stay inside the left
  // half so the PR chip keeps row one's right end.
  const issuesWidthClass = issueRefCount > 1 ? CHIP_MIDPOINT_CAP : CHIP_FULL_ROW;
  const hasChips = issueChips.length + pullChips.length + tagChips.length > 0;
  // Issue #191: nested child rows show the child's own chips — the same
  // `cardTicketRefs` call the child chips with standalone (title + branch
  // scan, the project's repo base, the store links via `childLinkedIssuesFor`,
  // and the same validation gate). The chips render condensed and inert:
  // the row is one anchor, so no chip link nests inside it (#127). Compact
  // minis keep the card's own no-chips rule.
  const childChipRowsFor = (child: PluginSidebarThread): TicketChipRow[] => {
    if (compact) return [];
    const refs = cardTicketRefs({
      title: child.displayTitle,
      branch: child.environment?.branchName ?? child.host?.name ?? "",
      ...(repoHrefBase !== undefined ? { repoHrefBase } : {}),
      linkedIssues: childLinkedIssuesFor?.(child.id),
      ...(validatedHrefs !== undefined ? { validatedHrefs } : {}),
    });
    return refs.length === 0 ? [] : ticketChipRows(refs);
  };
  const children = childThreads ?? [];
  // The fold's count names what folding hides: the rows plus their sub-rows
  // (the toggle's summary and the "N child threads" label both fold the tier
  // the card's rows region carries — a child row's own children hide with
  // it). A child whose members ride the Done space renders none here, so
  // none count.
  const grandchildRowCount = grandchildThreadsByParent === undefined
    ? 0
    : children.reduce(
        (count, child) => count + (grandchildThreadsByParent.get(child.id)?.length ?? 0),
        0,
      );
  // The chip counts every visible child (prop from the raw family index);
  // fall back to the nested rows when the caller does not supply it.
  const chipCount = childCount ?? children.length;
  // The toggle only makes sense when there are rows to hide; the chip still
  // counts children that render standalone (promoted / cross-axis).
  const hasRows = children.length > 0;

  // Issue #174: with the rows folded, the family's open child still lists
  // itself — a single row below the dot strip, so the active thread keeps an
  // anchor in its family card. Null when the rows are unfolded (the rows
  // list the whole family), when nothing in the family is open, or when the
  // open thread is some other thread on the board.
  const activeCollapsedChild =
    collapsed && activeThreadId !== null && activeThreadId !== undefined
      ? children.find((child) => child.id === activeThreadId) ?? null
      : null;

  // The idle-children filter (issue #172): one control on the child section
  // hides every idle child in BOTH views — the expanded rows and the
  // collapsed dot strip. Non-idle states (attention, working, unread) never
  // filter, so the control can never hide a child that wants the operator.
  const isIdleChild = (child: PluginSidebarThread) =>
    threadState(child, errorAckIds) === "idle";
  // A child hides only when it AND its whole subtree are idle. A working or
  // unread grandchild rides its idle parent's row, so hiding the parent would
  // bury the grandchild with it and break the filter's one promise: never
  // hide a thread that wants the operator. The walk is one tier deep in
  // practice: the display depth cap gives a grandchild no sub-rows of its own.
  const isIdleSubtree = (child: PluginSidebarThread): boolean =>
    isIdleChild(child) &&
    (grandchildThreadsByParent?.get(child.id) ?? []).every(isIdleSubtree);
  const visibleChildren = hideIdle
    ? children.filter((child) => !isIdleSubtree(child))
    : children;
  // The sub-tier's one rendering rule, shared by every consumer: the rows
  // list these members, the strip paints them, and the fold's count names
  // them — so count, rows, and dots agree by construction.
  const visibleSubsFor = (parentId: string): readonly PluginSidebarThread[] => {
    const subs = grandchildThreadsByParent?.get(parentId) ?? [];
    return hideIdle ? subs.filter((sub) => !isIdleSubtree(sub)) : subs;
  };
  // A hidden child's sub-rows go with it; a visible child's own idle
  // sub-rows filter out too, so the fold's count names what the section
  // shows, not what the family stores.
  const visibleSubRowCount = hideIdle
    ? visibleChildren.reduce((count, child) => count + visibleSubsFor(child.id).length, 0)
    : grandchildRowCount;
  const visibleRowCount = visibleChildren.length + visibleSubRowCount;

  // The card's own attention: a pending interaction or an unread error. A
  // nested child can no longer be the cause — attention children un-nest
  // (nesting.ts `childPlacement`) and demand attention from their own card.
  const familyNeedsAttention = threadState(thread, errorAckIds) === "attention";

  // Snoozed state: the wake epoch-ms (null when not snoozed) drives the dim,
  // the chip, and the drag refusal all at once — one rule, no drift.
  const snoozeWakeAt = snoozeFor?.(thread.id) ?? null;
  const snoozed = snoozeWakeAt !== null;

  // Surface contrast floor (wallpaper on): muting the WHOLE card with
  // opacity makes its bg-card surface translucent, so a busy wallpaper
  // bleeds through the muted text. With a wallpaper active the card keeps
  // its opaque surface and fades through an under-scrim instead. The one
  // card that beats the scrim is the sweep-picked one: its amber tint
  // overlay paints the wash on a full-opacity card, so the scrim would
  // stack under it. A pane-open faded card keeps the scrim — the scrim dims
  // the content without ever making the surface transparent, so it is not
  // a transparency rule and focus never has to beat it.
  const wallpaperActive = useWallpaperActive();
  // While the compact pane covers the board as an opaque full-window sheet,
  // nothing behind it shows, so the marker below is withheld: arming it
  // restyles and repaints every card for a recede no one can see (issue #310).
  // It is withheld, never set and cleared: a marker that flashes inside the
  // sheet's lifetime is the same bug with extra steps. A squeezed panel's
  // panel-scoped sheet is deliberately not covered here; the numbers behind
  // that call are in components/pane-sheet-coverage.tsx.
  const paneCoversBoard = usePaneCoversBoard();
  // The focus spotlight (see components/card-spotlight.ts): the thread pane holds
  // ONE thread open (`activeThreadId`) — the click-into surface, the same
  // "focused on one thread" state the hover surface serves for the pointer.
  // That thread's card, and the family card whose nested rows contain it (a
  // focused child keeps its family solid as one card), wear
  // `data-focus-solid` so the board recedes the other cards, and keep the
  // opaque darker surface (CARD_SURFACE_SOLID) while their own dim systems
  // stay in charge: done / dimmed / snoozed keep the marker but not a second
  // surface, sweep-highlight keeps its amber read, and a transport ghost
  // never claims either — two copies of one thread would both light up
  // during a dissolve.
  // The marker is withheld entirely while the compact pane covers the board as
  // an opaque sheet (`paneCoversBoard` above): the recede it arms is invisible
  // behind the sheet, and arming it restyles every card on the board. The
  // solid surface below is untouched, so nothing about the held card itself
  // changes.
  const focusHeld =
    activeThreadId !== undefined &&
    activeThreadId !== null &&
    (thread.id === activeThreadId ||
      children.some((child) => child.id === activeThreadId));
  const focusSolid =
    !isTransportGhost && !paneCoversBoard && (focusHeld || familySolid === true);

  // The card statuses in one object (components/card-status.ts); the fade
  // systems consume `status.faded` and `status.spotlightImmune` (the marker
  // below). The focus marker feeds `focusMarker`: a card holding the focus
  // spotlight never recedes, so the hover arm cannot dim the focused family
  // while the pointer sits on another card. Parenting status is not modeled
  // here: it expresses itself structurally (which component renders this
  // thread), and no fade decision branches on it.
  const status = deriveCardStatus({
    isActive,
    isSweepHighlighted,
    needsAttention: familyNeedsAttention,
    isDone,
    dimmed: dimmed ?? false,
    snoozed,
    focusMarker: focusSolid,
  });
  const dimsByScrim = wallpaperActive && status.faded && !isSweepHighlighted;
  const focusSurface =
    !isTransportGhost && focusHeld && !status.faded && !isSweepHighlighted;

  // The two-click Mark Done checkbox, swapped INTO THE STATE DOT'S SLOT: on
  // hover the dot fades and the checkbox centers over its exact pixels —
  // empty on not-done cards, checked on done — so the reveal moves nothing
  // on the card. Arming joins the label ("Mark Done" / "Mark Not Done")
  // inline in the header row, right of the slot. The first click arms, the
  // second fires `onMarkDone`; hovering away disarms, so an armed card
  // never survives a stray pointer into a later accidental settle. Sweeps
  // are modal: while this card's column curates a sweep the dot stays a
  // dot and every click stays with the selection gesture.
  const [armedDone, setArmedDone] = useState(false);

  // The rows list's fold (see foldFamilyRows): false shows the whole-row
  // budget, true shows every row. Local like `localCollapsed`, so an
  // unpersisted peek at the rest of the family never leaks across sessions.
  const [showAllRows, setShowAllRows] = useState(false);
  // The rows the card renders: a whole-row budget, the rest behind the Show
  // all handle. The count and the strip keep reading `visibleRowCount` (the
  // whole family), so the fold never changes what the label claims.
  const foldedRows = foldFamilyRows(visibleChildren, visibleSubsFor, showAllRows);
  const rowsOverflow = foldedRows.totalRows > FAMILY_ROWS_BEFORE_FOLD;

  // The hovered dot's preview bubble (issue #174's overflow follow-up):
  // enter/focus records the dot's viewport position, leave/blur clears it,
  // and the bubble renders as a fixed-position portal to body — placed by
  // previewLeftFor so a screen-edge dot cannot push the bubble off screen.
  // One open bubble per card; the board never has two hovers at once.
  const [previewDot, setPreviewDot] = useState<{
    id: string;
    centerX: number;
    topY: number;
  } | null>(null);
  // While one of the strip's dots is being dragged, its preview bubble is
  // pinned for the whole gesture (goal 4): the tooltip keeps naming the
  // dragged member, hovers over other dots must not steal it, and the
  // gesture's end closes it. Cleared at dragend with the bubble — the strip
  // must never outlive its drag wearing a stale tooltip.
  const [dotDragMemberId, setDotDragMemberId] = useState<string | null>(null);
  /** The open preview's content lookup: the state names the child, the
   * portal below resolves it from the current children list. A sub-dot of
   * the flattened strip resolves from the sub-tier the same way. */
  const previewChild =
    previewDot === null
      ? undefined
      : (children.find((child) => child.id === previewDot.id) ??
        children
          .flatMap((child) => grandchildThreadsByParent?.get(child.id) ?? [])
          .find((sub) => sub.id === previewDot.id));
  // A previewed direct child that carries sub-rows names them: its dot sits
  // beside its sub-dots in the flattened strip (the 2026-10-16 musing). A
  // sub-dot's own id yields no map entry, so the line stays off.
  const previewSubCount =
    previewDot === null || previewChild === undefined
      ? 0
      : visibleSubsFor(previewDot.id).length;
  /** One dot button in the collapsed strip: a direct child (full-size
   * glyph) or a sub-child (one size step down, family-ordered after its
   * parent's dot). The control contract is identical at both depths:
   * hover or focus previews, click opens that thread's pane. */
  const stripDot = (member: PluginSidebarThread, isSub: boolean) => {
    const state = threadState(member, errorAckIds);
    // The rate pulse (issue #279): a working member's dot breathes at a period
    // derived from its token burn. A member the sampler cannot measure yet
    // answers the base period, so it still reads as working — never frozen.
    const pulsePeriod = state === "working" ? pulsePeriodMs(pulseRateFor?.(member.id) ?? null) : null;
    const isMemberActive = member.id === activeThreadId;
    // The dot-drag gesture (issue #249): a snoozed member refuses drag —
    // the same one rule as the cards and the rows — and the preview bubble
    // is pinned from dragstart so the tooltip names the dragged member for
    // the whole gesture.
    const memberSnoozed = (snoozeFor?.(member.id) ?? null) !== null;
    const dotDragWired = childDotDrag !== undefined;
    // The escape kills any line first: after the boundary handoff the
    // gesture is a card drag, and no dot promise survives it.
    const dotLine =
      childDotDrag?.escaped === true
        ? undefined
        : childDotDrag?.line?.memberId === member.id
          ? childDotDrag.line?.zone
          : undefined;
    return (
      <button
        key={member.id}
        type="button"
        data-child-dot={member.id}
        data-child-dot-active={isMemberActive ? "" : undefined}
        aria-label={`${isSub ? "Open sub-thread" : "Open child thread"}: ${member.displayTitle}`}
        aria-current={isMemberActive ? "true" : undefined}
        draggable={dotDragWired && !memberSnoozed}
        onDragStart={(event) => {
          if (memberSnoozed) {
            event.preventDefault();
            return;
          }
          if (childDotDrag === undefined) return;
          // Dot drags never leave the hierarchy: the payload carries the
          // member id plus the DOT mark, and no surface outside this strip
          // authorises the drop — the drag-out morph gesture of a later cut
          // will be the one thing that does (goal 5). The preview bubble
          // opens here, from the dot's own viewport rect.
          event.dataTransfer.setData(DRAG_ID_KEY, member.id);
          event.dataTransfer.setData(DOT_DRAG_TYPE, "");
          event.dataTransfer.effectAllowed = "move";
          const rect = event.currentTarget.getBoundingClientRect();
          setPreviewDot({
            id: member.id,
            centerX: rect.left + rect.width / 2,
            topY: rect.top,
          });
          setDotDragMemberId(member.id);
          childDotDrag.onDragStart(member.id, event);
        }}
        onDragEnd={() => {
          setPreviewDot(null);
          setDotDragMemberId(null);
          childDotDrag?.onDragEnd();
        }}
        onDragOver={
          childDotDrag === undefined
            ? undefined
            : (event) => childDotDrag.onDragOver(member.id, event)
        }
        onDrop={
          childDotDrag === undefined
            ? undefined
            : (event) => childDotDrag.onDrop(member.id, event)
        }
        onMouseEnter={(event) => {
          // A hover behind an active dot drag cannot steal the pinned
          // tooltip: it stays naming the dragged member (goal 4).
          if (dotDragMemberId !== null) return;
          const rect = event.currentTarget.getBoundingClientRect();
          setPreviewDot({
            id: member.id,
            centerX: rect.left + rect.width / 2,
            topY: rect.top,
          });
        }}
        onFocus={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setPreviewDot({
            id: member.id,
            centerX: rect.left + rect.width / 2,
            topY: rect.top,
          });
        }}
        onMouseLeave={() => {
          // The pinned dragged-dot tooltip ignores leave — it dies at
          // dragend, not on a hover boundary the drag's pointer crossed.
          if (dotDragMemberId === null) setPreviewDot(null);
        }}
        onBlur={() => setPreviewDot(null)}
        onClick={(event) => {
          // The dot's click belongs to the dot alone: it opens its
          // thread and never reaches the strip's expand surface
          // beneath it.
          event.preventDefault();
          event.stopPropagation();
          if (onOpenThread === undefined) {
            toggleCollapsed();
            return;
          }
          onOpenThread(member.id);
        }}
        className={cn(
          "group/dot relative flex size-4 items-center justify-center rounded-full",
          // The hovered (or keyboard-focused) dot lights an
          // amber wash behind its glyph — the preview pair and
          // the attention signals read one language, and the
          // grey accent wash was too subtle at this size
          // (operator). Plain hover/focus variants: the
          // group-hover form cannot style a button from its own
          // group marker (:is(.group:hover *) matches only
          // descendants, and the halo's target IS the group
          // element).
          "hover:bg-amber-500/20 focus-visible:bg-amber-500/20",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isMemberActive && "bg-accent/70 ring-2 ring-ring",
          // The strip's vertical insertion line (the dot-drag promise): a
          // full-height half-dot-wide bar on the hovered dot's outer half —
          // the rows' horizontal pair turned on its side, since the strip
          // flows left to right.
          dotLine === "before" &&
            "before:absolute before:inset-y-0 before:-left-0.5 before:w-0.5 before:rounded-full before:bg-ring",
          dotLine === "after" &&
            "after:absolute after:inset-y-0 after:-right-0.5 after:w-0.5 after:rounded-full after:bg-ring",
        )}
      >
        <span
          ref={state === "attention" || pulsePeriod !== null ? attentionPulseRef : undefined}
          aria-hidden
          data-child-dot-glyph=""
          data-dot-pulse={pulsePeriod === null ? undefined : String(pulsePeriod)}
          style={pulsePeriod === null ? undefined : dotPulseStyle(pulsePeriod)}
          className={cn(
            // The generation cue: a sub-dot draws one size step down
            // from its parent's dot (the musing's size rule).
            isSub ? "size-1" : "size-1.5",
            "rounded-full",
            DOT_CLASS[state] ?? "bg-muted-foreground/30",
            state === "attention" && "motion-safe:animate-pulse",
          )}
        />
      </button>
    );
  };
  const showDoneCheckbox = onMarkDone !== undefined && !isSweepSelecting;
  const doneLabel = isDone ? "Mark Not Done" : "Mark Done";
  const doneDotSlot = showDoneCheckbox ? (
    <span className="relative flex size-1.5 shrink-0 items-center justify-center">
      <span
        className={cn(
          "flex items-center transition-opacity",
          armedDone
            ? "opacity-0"
            : "opacity-100 group-hover:opacity-0 group-focus-within:opacity-0",
        )}
      >
        {stateDot}
      </span>
      <button
        type="button"
        data-done-checkbox=""
        data-done-armed={armedDone ? "" : undefined}
        aria-label={armedDone ? doneLabel : `Arm ${doneLabel}`}
        title={armedDone ? "Click again to confirm" : "Click to arm"}
        onClick={(event) => {
          // The stop keeps the anchor's own activation (open the pane, the
          // sweep toggle, the native href) from firing under the checkbox's
          // click.
          event.preventDefault();
          event.stopPropagation();
          if (armedDone) {
            setArmedDone(false);
            onMarkDone();
          } else {
            setArmedDone(true);
          }
        }}
        className={cn(
          "absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center rounded-sm p-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          armedDone
            ? "text-amber-600 opacity-100"
            : "text-muted-foreground/50 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        )}
      >
        <Icon
          name={armedDone || isDone ? "CheckboxChecked" : "Checkbox"}
          className="size-3.5 shrink-0"
          aria-hidden
        />
      </button>
    </span>
  ) : stateDot;

  // The card is a container; the anchor (title/body), the chip rows, and the
  // collapse toggle stay out of each other's interactive scope — a button or
  // an <a> inside an anchor would be invalid HTML (issue #171 for the chips).
  const card = (
    <div
      data-thread-card={thread.id}
      data-sweep-highlighted={isSweepHighlighted ? "" : undefined}
      data-sweep-active={isSweeping ? "" : undefined}
      data-snoozed={snoozed ? "" : undefined}
      // The dot-drag morph's in-place marker (issue #249, goal 5): while a
      // dot of this family is dragged past its strip's boundary, the family
      // card is the dragged member's in-place "real card" — light it.
      data-dot-escape={childDotDrag?.escaped === true ? "" : undefined}
      // The spotlight's exemption marker (see components/card-status.ts): a
      // card with user focus (pane open, sweep-highlighted, needs-attention)
      // or a life of its own that already fades it (done / dimmed / snoozed,
      // by whole-card opacity or the under-scrim) is marked, so the spotlight
      // recede never stacks a second dim on top and never fades what the
      // operator is focused on.
      data-spotlight-immune={status.spotlightImmune ? "" : undefined}
      // The focus spotlight's marker (see components/card-spotlight.ts): the
      // card the thread pane holds open — or the family card whose rows
      // contain it, or a parent-lane cell the board forces it on — so the
      // board arms the recede on FOCUS, not just on hover, and that card
      // (with its family) keeps the solid surface throughout.
      data-focus-solid={focusSolid ? "" : undefined}
      // `group` drives the hover-revealed done checkbox below.
      onPointerLeave={armedDone ? () => setArmedDone(false) : undefined}
      onMouseEnter={
        onAttentionEnter === undefined ? undefined : () => onAttentionEnter(thread.id)
      }
      onMouseOut={
        onAttentionLeave === undefined
          ? undefined
          : (event) => {
              // Only a TRUE exit (the pointer passing above/outside the
              // card) releases the pin: entering a nested child row — a
              // descendant of this div — must not, or the card could move
              // while the pointer is still inside it.
              const from = event.relatedTarget;
              const current = event.currentTarget;
              if (from instanceof Node && current.contains(from)) return;
              onAttentionLeave(thread.id);
            }
      }
      className={cn(
        "group relative overflow-hidden rounded-md bg-card",
        // Colors AND opacity both ease: the spotlight rule
        // (components/card-spotlight.ts) dims and un-dims sibling cards from a
        // board-root rule, so the
        // opacity transition must live on the card itself — `transition-colors`
        // alone has no opacity to animate, and an armed-rule transition would
        // vanish in the same recalc as the dim it eases. The dim's onset
        // overrides this ease with its own armed rest (300ms) and sweep (300ms);
        // the un-dim always rides this base 150ms.
        "transition-[color,background-color,border-color,outline-color,text-decoration-color,opacity,fill,stroke]",
        // Hover = MORE prominence, never less (issue #123): an OPAQUE surface,
        // never a translucent background-color on the card itself — card-level
        // transparency lets the lane background / wallpaper bleed through (the
        // lesson the wallpaper-contrast under-scrim already teaches). The
        // scheme direction rides HOVER_SURFACE (#195): the dark canvas
        // darkens the hovered card; the light canvas keeps the card surface
        // and the ring below carries the emphasis instead.
        HOVER_SURFACE,
        // The pane-open surface (the click-into twin of the hover surface):
        // the same opaque mix persists while the board's focus spotlight
        // recedes the other cards. The card's own dim systems stay in charge
        // (a faded card never gets a second surface) and
        // sweep-highlight keeps its amber read — see focusSurface above.
        focusSurface && CARD_SURFACE_SOLID,
        // A card with a child section needs bottom padding beyond the body's
        // own 8px: the rows (or the folded strip) would otherwise sit flush
        // against the card's bottom edge.
        hasRows && (collapsed || onOpenThread !== undefined) && "pb-3",
        isActive
          ? "ring-2 ring-ring"
          : "ring-1 ring-transparent hover:ring-border",
        isDone && (dimsByScrim ? "saturate-50" : "opacity-50 saturate-50"),
        dimmed && !dimsByScrim && "opacity-50",
        snoozed && !dimsByScrim && "opacity-50",
        // The amber wash is NOT a card background: a translucent bg here
        // loses tailwind-merge's conflict against `bg-card` and REPLACES the
        // opaque surface, so a selected card went transparent (the lane /
        // wallpaper bled through — exactly the failure the HOVER_SURFACE
        // note below forbids). The wash lives on the [data-sweep-tint]
        // overlay further down; the card keeps its own opaque surface.
        isSweepHighlighted && "ring-2 ring-amber-500 saturate-100 opacity-100",
        isSweepSelectable && "ring-1 ring-amber-500/40",
        // The morph ring + dim ride LAST: the escaped drag's tail is a card
        // drag, and this card is its landing-light while the ghost follows
        // the pointer. Appended last so tailwind-merge lets it win any ring
        // or opacity conflicts the statuses above set.
        childDotDrag?.escaped === true && "opacity-75 ring-2 ring-amber-500/40",
      )}
    >
      <span
        className={cn(
          "absolute inset-y-0 left-0 w-0.5",
          ACCENT_CLASS[threadState(thread, errorAckIds)] ?? "bg-transparent",
        )}
        aria-hidden
      />
      {familyNeedsAttention ? (
        // A border, not a ring: the ring paints outside the box and this
        // overlay sits inside the card's overflow-hidden — only the border
        // lands on visible pixels. The pulse moves the overlay's opacity, not
        // the card's, so the title never blinks with it. The ref is the
        // visible-only gate (components/attention-pulse-gate): off screen the
        // overlay keeps its amber border and holds still.
        <span
          ref={attentionPulseRef}
          data-attention-pulse=""
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-md border-2 border-amber-500 bg-amber-500/5 motion-safe:animate-pulse"
        />
      ) : null}
      {dimsByScrim ? (
        // The wallpaper-on contrast floor: a wash of the card's own surface
        // color over the content, so the faded look never drops the card's
        // opacity (the wallpaper would bleed through the muted surface).
        // Plain background paint — no backdrop-filter, mobile-safe, and
        // pointer-events pass straight through to the content.
        <span
          data-card-dim-scrim=""
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 rounded-md bg-card/50"
        />
      ) : null}
      {isSweepHighlighted ? (
        // The selection's amber wash sits ON the card as an overlay, the dim
        // scrim's pattern: the card's own surface stays opaque, only the
        // wash moves. See the highlight class note above for why this is
        // not `bg-amber-500/10` on the card itself.
        <span
          data-sweep-tint=""
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 rounded-md bg-amber-500/10"
        />
      ) : null}
      <div className="flex items-stretch">
        {/* The chip rows live OUTSIDE the card's anchor: the chips carry
            anchors of their own (the mark's list page, each id's item), and
            HTML forbids an <a> inside an <a> (issue #171). The column keeps
            the anchor and the rows stacked while the family-size strip stays
            a sibling of the column. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <a
            href={thread.href}
            aria-current={isActive && !isTransportGhost ? "true" : undefined}
            draggable={!snoozed}
            onDragStart={(event) => {
              // A snoozed card refuses drag (`draggable={!snoozed}` above);
              // this guard keeps the refusal true even where the attribute
              // is not enforced, so nothing can drag a sleeping card into a
              // lane move its sleep is meant to skip.
              if (snoozed) {
                event.preventDefault();
                return;
              }
              event.dataTransfer.setData("text/focus-board-id", thread.id);
              if (rankKey !== undefined) {
                // The lane rides in the drag TYPE, not a payload value: the
                // payload is unreadable until the drop, and dragover is
                // exactly when the drop has to be authorised.
                event.dataTransfer.setData(rankDragType(rankKey), "");
                onRankDragStart?.(thread.id);
              }
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => onRankDragStart?.(null)}
            onClick={(event) => {
              // Sweep mode is modal: the click curates the selection, it never
              // navigates — not even modifier-clicks, which would otherwise
              // open a browser tab from the href. The board reads the gesture:
              // shift extends the range from the anchor, cmd/ctrl and plain
              // clicks toggle this one card.
              if (isSweepSelecting) {
                event.preventDefault();
                onSweepToggle?.(thread.id, { shiftKey: event.shiftKey });
                return;
              }
              // Let modified clicks (middle-click handled natively, cmd/ctrl new
              // window) pass through; the host also routes plain clicks on href.
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              onOpen();
            }}
            className={cn(
              "relative focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              compact ? "px-2 py-1" : hasChips ? "px-3 pt-2" : "px-3 py-2",
            )}
          >
            <div className="flex items-center gap-1.5 pl-1.5">
              {doneDotSlot}
              {showDoneCheckbox && armedDone ? (
                <span
                  data-done-armed-tag=""
                  aria-hidden
                  className="whitespace-nowrap text-[10px] font-medium leading-none text-amber-600"
                >
                  {doneLabel}
                </span>
              ) : null}
              {thread.isPinned ? (
                <Icon name="Pin" className="size-3 text-muted-foreground/70" aria-hidden />
              ) : null}
              {thread.hasPendingInteraction || familyNeedsAttention ? (
                <Icon
                  name="MessageQuestion"
                  className="size-3 text-amber-500"
                  aria-label={
                    thread.hasPendingInteraction
                      ? (thread.indicatorLabel ?? "Needs your input")
                      : "A subthread needs your input"
                  }
                />
              ) : null}
              {isSweeping ? (
                <span
                  data-sweep-spinner
                  title="Archiving…"
                  aria-label="Archiving"
                  className="inline-flex shrink-0"
                >
                  <Icon
                    name="Spinner"
                    className="size-3 animate-spin text-amber-600"
                    aria-hidden
                  />
                </span>
              ) : null}
              {snoozed ? (
                <span
                  data-snooze-chip
                  title={`Wakes ${describeWakeAt(snoozeWakeAt, now)}`}
                  className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-[10px] text-muted-foreground"
                >
                  <Icon name="Clock" className="size-3" aria-hidden />
                  {compact ? "" : `Snoozed · wakes ${describeWakeAt(snoozeWakeAt, now)}`}
                </span>
              ) : null}
              <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
                {relativeTime(thread.updatedAt, now)}
              </span>
            </div>
            <p data-title="" className={cn("mt-0.5 line-clamp-2 pl-1.5 leading-snug", compact ? "text-[11px]" : "text-[13px]")}>{thread.displayTitle}</p>
            <p className="mt-0.5 truncate pl-1.5 text-[11px] text-muted-foreground/70">
              {projectName}
              {branch === "" ? null : <span className="text-muted-foreground/40"> · {branch}</span>}
            </p>
          </a>
          {compact ? null : <JiraCardSlot threadId={thread.id} />}
          {hasChips ? (
            // Issue #104's chip area: three regions on a wrapping flex line.
            // The issues region keeps a lone row-anchor per provider; the
            // pulls and tags regions are right-anchored by `ml-auto`, which
            // also holds a wrapped block at its line's right end. The tag
            // block forces its own line when a PR shares the card, and may
            // ride row one when none does.
            <div
              className="mt-1 flex flex-wrap items-start gap-1 px-3 pb-2 pl-1.5"
              data-ticket-chip-area=""
            >
              {issueChips.length === 0 ? null : (
                // Issues: first row, left. Several ids never cross the
                // midpoint + gutter cap; surplus ids start fresh lines inside
                // the chip instead. A lone ticket name may take the whole
                // row, which pushes the PR chip down.
                <div
                  className={cn("flex min-w-0 flex-wrap items-start gap-1", issuesWidthClass)}
                  data-ticket-chip-region="issues"
                >
                  {issueChips.map((entry) => (
                    <ProviderTicketChip
                      key={`issue:${entry.row.key}`}
                      row={entry.row}
                      chip={entry.chip}
                      statusFor={statusFor}
                      projectRepo={repo}
                    />
                  ))}
                </div>
              )}
              {pullChips.length === 0 ? null : (
                // PRs: the first row's right end, bumped to the next row's
                // right end only when the issues region claims the room.
                <div
                  className="ml-auto flex min-w-0 flex-wrap items-start justify-end gap-1"
                  data-ticket-chip-region="pulls"
                >
                  {pullChips.map((entry) => (
                    <ProviderTicketChip
                      key={`pull:${entry.row.key}`}
                      row={entry.row}
                      chip={entry.chip}
                      statusFor={statusFor}
                      projectRepo={repo}
                    />
                  ))}
                </div>
              )}
              {tagChips.length === 0 ? null : (
                // Tags: bottom-right, right-anchored, under the PR block when
                // there is one. The block stops at 75% of the row and a long
                // tag wraps at its hyphens there rather than shrinking.
                <div
                  className={cn(
                    "ml-auto flex min-w-0 flex-col items-end gap-1",
                    CHIP_TAG_MAX_WIDTH,
                    pullChips.length > 0 ? "basis-full" : undefined,
                  )}
                  data-ticket-chip-region="tags"
                >
                  {tagChips.map((entry) => (
                    <TagChip
                      key={`tag:${entry.row.key}:${entry.ref.raw}`}
                      row={entry.row}
                      tagRef={entry.ref}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>
        {chipCount > 0 ? (
          // Family-size metadata only: the collapsed rows' dot strip lives in
          // the child section below, directly under the "N child threads"
          // label it describes.
          <div className="flex shrink-0 items-start py-2 pr-1.5">
            <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
              {chipCount}
            </span>
          </div>
        ) : null}
      </div>
      {hasRows && (collapsed || onOpenThread !== undefined) ? (
        <div
          className="ml-3 mr-3 mt-1"
          data-child-thread-section=""
        >
          {/* The right margin mirrors the left: without it every row tier
              ran flush against the card's right edge (0px inset) while the
              left kept its 12px indent — the lane's right gutter read as
              consumed (issue #192). */}
          {/* The section's header row: the fold toggle, plus the
              idle-children filter (issue #172) beside it. One control in one
              place, on the boundary of the content it controls — directly
              above the rows when expanded, and the header of the collapsed
              dot strip when folded. Clicking them never reaches the card's
              anchor, the pane, or the background closer. */}
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              data-child-threads-toggle=""
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand subthreads" : "Collapse subthreads"}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleCollapsed();
              }}
              className={cn(
                "flex items-center gap-1.5 rounded-sm py-0.5 pr-1.5 text-[11px] text-muted-foreground/70",
                "transition-colors hover:bg-accent/60 hover:text-foreground",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <Icon
                name={collapsed ? "ChevronRight" : "ChevronDown"}
                className="size-3 shrink-0"
                aria-hidden
              />
              {/* The idle filter enumerates what it hides ("2 active, 3 idle
                  child threads", issue #172); with the filter off, or hiding
                  nothing, the plain count returns. */}
              {hideIdle && children.length > visibleChildren.length
                ? `${visibleRowCount} active, ${children.length - visibleChildren.length} idle child threads`
                : `${visibleRowCount} ${visibleRowCount === 1 ? "child thread" : "child threads"}`}
            </button>
            <button
              type="button"
              data-idle-children-toggle=""
              aria-pressed={hideIdle}
              aria-label={hideIdle ? "Show idle child threads" : "Hide idle child threads"}
              title={hideIdle ? "Show the idle child threads" : "Hide the idle child threads"}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleHideIdle();
              }}
              className={cn(
                "rounded-sm p-0.5 text-muted-foreground/70",
                "transition-colors hover:bg-accent/60 hover:text-foreground",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <Icon
                name={hideIdle ? "View" : "ViewOff"}
                className="size-3 shrink-0"
                aria-hidden
              />
            </button>
          </div>
          {collapsed && visibleChildren.length > 0 ? (
            // The collapsed rows, immediately below their label: one dot per
            // rendered family member, family-ordered (the 2026-10-16 musing,
            // extending issue #174's per-child strip). A child's dot leads
            // its own smaller sub-dots, so the strip's dots agree with the
            // count above (rows plus sub-rows) member for member; the old
            // "19 child threads over nine dots" reading cannot recur. The
            // idle-children filter (issue #172) hides an idle member's dot
            // with its row, at either depth. Hovering a dot previews that
            // thread (its title plus what the SDK exposes: state label,
            // last-activity age, indicator label; the SDK does not expose a
            // thread's messages; a parent dot's preview names its
            // sub-threads). Clicking a dot opens that thread's pane and
            // leaves the rows folded. The strip's background keeps the
            // strip's expand role, and the section toggle above stays the
            // keyboard path.
            <div
              data-child-thread-dots=""
              title="Show the nested child threads"
              data-strip-nest-target={stripNestHover !== undefined && stripNestHover !== null ? "" : undefined}
              onDragOver={stripNestDrag?.onDragOver}
              onDrop={stripNestDrag?.onDrop}
              onDragLeave={
                stripNestDrag === undefined
                  ? undefined
                  : (event) => {
                      // The line of dots is littered with inter-dot gaps:
                      // leaving one dot for the next must not flicker the
                      // affordance; only a TRUE exit out of the strip clears.
                      const into = event.relatedTarget;
                      if (into instanceof Node && event.currentTarget.contains(into)) return;
                      stripNestDrag.onDragLeave();
                    }
              }
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleCollapsed();
              }}
              className={cn(
                // The strip's first dot sits in the rows' dot column: the
                // 12px indent plus the glyph's centered position inside its
                // 16px button land the 6px dot's left edge at 17px, the
                // same x the expanded and active rows' dots start at (1px
                // border + 8px padding + the row anchor's 8px). The strip,
                // the grid it wraps into, and the rows read one grid. The
                // wide gap sets the between-family spacing; a group's
                // inside gap is tighter, so a family reads as one cluster.
                "ml-3 flex max-w-full flex-wrap items-center gap-2.5 rounded-sm py-0.5 pr-1",
                "transition-colors hover:bg-accent/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                // The nest-target light (goal 6): a CARD hovers the dot
                // field, the strip reads as the landing spot — the soft
                // amber family ring, the same systems the floors use.
                stripNestHover !== undefined &&
                  stripNestHover !== null &&
                  "ring-2 ring-amber-500/40 bg-accent/60",
              )}
            >
              {visibleChildren.map((child) => (
                <span
                  key={child.id}
                  data-child-dot-group={child.id}
                  className="flex flex-nowrap items-center gap-1"
                >
                  {stripDot(child, false)}
                  {visibleSubsFor(child.id).map((sub) => stripDot(sub, true))}
                </span>
              ))}
              {stripNestHover !== undefined && stripNestHover !== null ? (
                // The collapsed CARD, painted as the member it is about to
                // become: one trailing ghost dot, the glyph size of a child
                // dot, outside every group span until the write lands.
                <span
                  data-strip-nest-ghost=""
                  aria-hidden
                  className="ml-0.5 inline-block size-1.5 shrink-0 rounded-full bg-amber-500/60 motion-safe:animate-pulse"
                />
              ) : null}
            </div>
          ) : null}
          {activeCollapsedChild !== null && onOpenThread !== undefined ? (
            // Issue #174: the family's open child keeps a single row below
            // the strip while everything else stays a dot. No sub-rows and
            // no reorder line: a one-row list has nothing to rank.
            <div data-child-active-row="" className="mt-1 border-l border-border/70 pl-2">
              <ul className="flex flex-col gap-1">
                <li>
                  <ChildRow
                    child={activeCollapsedChild}
                    dimmed={isDone}
                    errorAcks={errorAckIds}
                    isActive
                    isTransportGhost={isTransportGhost}
                    onOpenThread={onOpenThread}
                    menuActions={childMenuActions?.(activeCollapsedChild)}
                    snoozeFor={snoozeFor}
                    onAttentionEnter={onAttentionEnter}
                    onAttentionLeave={onAttentionLeave}
                    chipRows={childChipRowsFor(activeCollapsedChild)}
                    statusFor={statusFor}
                    projectRepo={repo}
                  />
                </li>
              </ul>
            </div>
          ) : null}
          {!collapsed && onOpenThread !== undefined && visibleChildren.length > 0 ? (
            <div data-nested-rows="" className="mt-1 border-l border-border/70 pl-2">
              <ul className="flex flex-col gap-1">
                {foldedRows.rows.map(({ child, subRows }) => {
                  const childDone = doneIds?.has(child.id) ?? false;
                  // The sub-row tier (issue #120): a child row nests its own
                  // children, indenting one tier under its indented list.
                  // Rows' rows render childless themselves — the display
                  // index caps every display chain at two row levels, so no
                  // deeper tier ever arrives here. The idle filter treats
                  // the sub-row tier like the row tier: a visible child's
                  // own idle sub-rows hide too (the shared visibleSubsFor
                  // rule the count and the strip read as well). The fold
                  // gives each child the sub-rows that fit its budget, so a
                  // folded row never loses a sub-row it had room for.
                  const subRankKey = childRankKey(child.id);
                  return (
                    <li key={child.id}>
                      <ChildRow
                        child={child}
                        dimmed={isDone || childDone}
                        errorAcks={errorAckIds}
                        isActive={child.id === activeThreadId}
                        isTransportGhost={isTransportGhost}
                        onOpenThread={onOpenThread}
                        menuActions={childMenuActions?.(child)}
                        snoozeFor={snoozeFor}
                        rankKey={rankKey}
                        onRankDragStart={onRankDragStart}
                        rankDrag={childRankDrag}
                        onAttentionEnter={onAttentionEnter}
                        onAttentionLeave={onAttentionLeave}
                        chipRows={childChipRowsFor(child)}
                        statusFor={statusFor}
                        projectRepo={repo}
                      />
                      {subRows.length > 0 ? (
                        <ul
                          data-child-sub-rows=""
                          // One narrower indent step than the card's own rows
                          // list, so the tier reads as depth.
                          className="mt-1 flex flex-col gap-1 border-l border-border/50 pl-2 ml-1"
                        >
                          {subRows.map((sub) => (
                            <li key={sub.id}>
                              <ChildRow
                                child={sub}
                                dimmed={isDone || childDone || doneIds?.has(sub.id) === true}
                                errorAcks={errorAckIds}
                                isActive={sub.id === activeThreadId}
                                onOpenThread={onOpenThread}
                                menuActions={childMenuActions?.(sub)}
                                snoozeFor={snoozeFor}
                                rankKey={subRankKey}
                                onRankDragStart={onRankDragStart}
                                onAttentionEnter={onAttentionEnter}
                                onAttentionLeave={onAttentionLeave}
                                chipRows={childChipRowsFor(sub)}
                                statusFor={statusFor}
                                projectRepo={repo}
                              />
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {rowsOverflow ? (
                // The fold's handle: the withheld rows stay one click away,
                // and its label names the whole family, so the count above
                // never disagrees with what the control reveals. The rows
                // list carries no height cap and no scroll, so every
                // rendered row stays whole (the old `max-h-64` scroll sliced
                // its last row and hid the rest behind an invisible
                // scrollbar with no affordance).
                <button
                  type="button"
                  data-show-all-rows=""
                  aria-expanded={showAllRows}
                  aria-label={
                    showAllRows
                      ? "Show fewer child threads"
                      : `Show all ${foldedRows.totalRows} child threads`
                  }
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setShowAllRows((value) => !value);
                  }}
                  className={cn(
                    "mt-1 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border/60",
                    "py-1 text-[11px] text-muted-foreground/80",
                    "transition-colors hover:bg-accent/60 hover:text-foreground",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  {showAllRows ? "Show fewer" : `Show all ${foldedRows.totalRows}`}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {previewDot !== null && previewChild !== undefined ? (
        // The hover preview (issue #174): one component owns the shape.
        <DotPreviewBubble
          member={previewChild}
          projectName={projectName}
          centerX={previewDot.centerX}
          topY={previewDot.topY}
          variety={childDotDrag?.escaped === true && dotDragMemberId !== null ? "drag" : "dot"}
          subCount={previewSubCount}
        />
      ) : stripNestHover !== undefined && stripNestHover !== null ? (
        // The strip-nest collapse (goal 6): the hovered CARD's surface read
        // at the pointer, tooltip plus dot, while it is inside the field.
        <DotPreviewBubble
          member={stripNestHover.member}
          projectName={projectName}
          centerX={stripNestHover.x}
          topY={stripNestHover.y}
          variety="strip"
        />
      ) : null}
    </div>
  );
  if (menuActions === undefined) return card;
  return (
    <ThreadCardMenu
      anchor={card}
      actions={menuActions}
      href={thread.href}
      onOpen={onOpen}
      title={thread.displayTitle}
      onOpenChange={(open) =>
        open ? onAttentionEnter?.(thread.id) : onAttentionLeave?.(thread.id)
      }
    />
  );
}

/**
 * The ids whose membership in a set-state this card consumes directly: its
 * own row(s) — the dot, the accent, the dim — plus every nested child row
 * and sub-row it renders (their dots and done-dimming read the same sets).
 * A state-set's content changing without any of these memberships changing
 * is invisible to this card; the memo comparator treats the props equal
 * (issue #186).
 */
function cardSetIds(props: ThreadCardProps): string[] {
  const ids = [props.thread.id];
  const children = props.childThreads;
  if (children !== undefined) {
    for (const child of children) {
      ids.push(child.id);
      for (const sub of props.grandchildThreadsByParent?.get(child.id) ?? []) {
        ids.push(sub.id);
      }
    }
  }
  return ids;
}

/** Membership equality for the ids a card renders: identity-equal sets
 * short-circuit; otherwise every relevant id's membership must match. */
function sameSetMembership(
  prev: ReadonlySet<string> | undefined,
  next: ReadonlySet<string> | undefined,
  ids: readonly string[],
): boolean {
  if (prev === next) return true;
  // The acks may carry Jira's Needs-you ids (grouping.ts StateAcks): compare those too.
  const a = (prev as StateAcks | undefined)?.needsYou;
  const b = (next as StateAcks | undefined)?.needsYou;
  for (const id of ids) {
    if ((prev?.has(id) ?? false) !== (next?.has(id) ?? false)) return false;
    if ((a?.has(id) ?? false) !== (b?.has(id) ?? false)) return false;
  }
  return true;
}

/**
 * The done checkbox's run and each menu entry's run are closure-built per
 * board render, so their identity churns with the board's render loop;
 * only the card's OWN observable state (its flags, baked into the array at
 * build time) can make a stale run act on wrong state — and when that
 * state changes, a compared primitive or the menu's id/label content
 * changes with it (a card whose flags changed re-renders and gets a fresh
 * menu; a card whose menu content matches the fresh build acts correctly).
 * The comparator therefore compares ACTIONS BY CONTENT — id, label, icon,
 * danger, divider — never by closure identity.
 */
/**
 * Content equality of a list of threads a card renders: the nested rows and
 * the sub-row lists. The board rebuilds the collection wrappers on every
 * render, but the THREAD objects inside are stable (the assembly reuses
 * them), so comparing element identity in order is the right bar — a row
 * whose thread object changed, moved, or disappeared must re-render the card.
 */
function sameThreadList(
  prev: readonly PluginSidebarThread[] | undefined,
  next: readonly PluginSidebarThread[] | undefined,
): boolean {
  if (prev === next) return true;
  if (prev === undefined || next === undefined) return false;
  if (prev.length !== next.length) return false;
  for (let index = 0; index < prev.length; index++) {
    if (prev[index] !== next[index]) return false;
  }
  return true;
}

function sameMenuActions(
  prev: readonly CardMenuAction[] | undefined,
  next: readonly CardMenuAction[] | undefined,
): boolean {
  if (prev === next) return true;
  if (prev === undefined || next === undefined) return false;
  if (prev.length !== next.length) return false;
  return prev.every((action, index) => {
    const other = next[index];
    if (other === undefined) return false;
    return (
      action.id === other.id &&
      action.label === other.label &&
      action.icon === other.icon &&
      action.danger === other.danger &&
      action.dividerAbove === other.dividerAbove
    );
  });
}

/**
 * The board's StateDot is a pure function of (thread, errorAcks), but it
 * arrives as a freshly-built element each render (identity churn). The
 * comparator sees through it when it is the known shape — a StateDot-like
 * element whose props are exactly { thread } and/or { errorAcks }:
 * otherwise it must not guess, and re-renders.
 */
function sameStateDot(
  prev: ReactNode,
  next: ReactNode,
  ids: readonly string[],
): boolean {
  if (prev === next) return true;
  if (!isValidElement(prev) || !isValidElement(next)) return false;
  if (prev.type !== next.type) return false;
  const prevDotProps = prev.props as Record<string, unknown>;
  const nextDotProps = next.props as Record<string, unknown>;
  const keys = Object.keys(nextDotProps);
  if (keys.length === 0) return Object.keys(prevDotProps).length === 0;
  if (!keys.every((key) => key === "thread" || key === "errorAcks")) return false;
  if (keys.length !== Object.keys(prevDotProps).length) return false;
  if (prevDotProps.thread !== nextDotProps.thread) return false;
  if (nextDotProps.errorAcks === undefined && prevDotProps.errorAcks === undefined) return true;
  return sameSetMembership(
    prevDotProps.errorAcks as ReadonlySet<string> | undefined,
    nextDotProps.errorAcks as ReadonlySet<string> | undefined,
    ids,
  );
}

/** The card's ticket refs, re-derived straight from the props (the same
 * inputs the card body uses; `gated` off skips the validation filter —
 * the RAW refs the membership probes need). */
function cardRefsOf(
  props: ThreadCardProps,
  gated: boolean,
): readonly TicketRef[] {
  const branch = props.thread.environment?.branchName ?? props.thread.host?.name ?? "";
  return cardTicketRefs({
    title: props.thread.displayTitle,
    branch,
    ...(props.repoHrefBase !== undefined ? { repoHrefBase: props.repoHrefBase } : {}),
    linkedIssues: props.linkedIssues,
    ...(gated && props.validatedHrefs !== undefined ? { validatedHrefs: props.validatedHrefs } : {}),
  });
}

/**
 * issue #186's memo: the board renders ~500 cards through this one
 * component; a state change (an echo's refetch, an optimistic write) used
 * to re-render every mounted card because the call site rebuilds every
 * prop per render. The comparator is SEMANTIC, not identity-based:
 *
 * - the thread and every primitive flag compare by identity/value;
 * - the state-set props (done, acks) compare by the memberships THIS card
 *   renders (own ids + nested rows), not by set identity;
 * - the dot element and the menu arrays compare by content;
 * - the per-item lookups (snooze, ticket status) compare by their results;
 * - the closures (drag gestures, open handlers, attention reports) compare
 *   never — their captured per-card state cannot go stale without a
 *   compared prop changing with it, and the board-scoped closures they
 *   reach into (sweep anchor, pins) read refs.
 */
export function sameCardProps(prev: ThreadCardProps, next: ThreadCardProps): boolean {
  if (prev.thread !== next.thread) return false;
  if (prev.stateDot !== next.stateDot) {
    if (!sameStateDot(prev.stateDot, next.stateDot, cardSetIds(next))) return false;
  }
  // Primitive surface: every flag the card's render branches on.
  for (const key of [
    "isActive",
    "isDone",
    "isSweepHighlighted",
    "isSweeping",
    "isSweepSelecting",
    "isSweepSelectable",
    "projectName",
    "repoHrefBase",
    "childCount",
    "dimmed",
    "rankKey",
    "isTransportGhost",
    "compact",
    "isCollapsed",
    // The parent-lane board's forced focus marker (a render branch like the
    // flags above): a flip must repaint the cell.
    "familySolid",
    // The idle-children filter (issue #172) joined the card after this
    // comparator was written; like `isCollapsed` it is a render branch, so a
    // flip must re-render the card.
    "hideIdleChildren",
  ] as const) {
    if (prev[key] !== next[key]) return false;
  }
  // `activeThreadId` is a board-WIDE value: opening any thread's pane sets it
  // on every card at once. Inside this card it is only consulted for the
  // FAMILY — the collapsed strip's listed active child, each dot's
  // `isMemberActive`, each nested row's `isActive`, and the focus marker
  // (`focusHeld` reads the same own-or-child membership). The card's OWN
  // active state rides the `isActive` prop, compared above. So a change of
  // `activeThreadId` is invisible here unless the old or new id is a member
  // this card renders; without this, every pane open re-rendered every card
  // (the exact tap issue #265 measured at 1005 card renders).
  if (prev.activeThreadId !== next.activeThreadId) {
    const members = cardSetIds(next);
    const touches = (id: string | null | undefined): boolean =>
      id !== null && id !== undefined && members.includes(id);
    if (touches(prev.activeThreadId) || touches(next.activeThreadId)) return false;
  }
  const ids = cardSetIds(next);
  if (!sameSetMembership(prev.doneIds, next.doneIds, ids)) return false;
  if (!sameSetMembership(prev.errorAckIds, next.errorAckIds, ids)) return false;
  // Whole-card content that is not a flag: the chip inputs and the maps.
  const prevLinks = prev.linkedIssues;
  const nextLinks = next.linkedIssues;
  if (prevLinks !== nextLinks) {
    if (prevLinks === undefined || nextLinks === undefined) return false;
    if (prevLinks.length !== nextLinks.length) return false;
    for (let index = 0; index < prevLinks.length; index++) {
      if (!sameThreadLink(prevLinks[index], nextLinks[index])) return false;
    }
  }
  if (prev.validatedHrefs !== next.validatedHrefs) {
    // The raw (ungated) ref urls: identical whenever this comparison has
    // reached here — the thread and the link list are already content-equal.
    const hrefs = cardRefsOf(next, false).map((ref) => ref.href ?? "").filter(Boolean);
    if (!sameSetMembership(prev.validatedHrefs, next.validatedHrefs, hrefs)) return false;
  }
  if (prev.statusFor !== next.statusFor) {
    const repo = next.repoHrefBase === undefined ? null : resolveRepoSlug(next.repoHrefBase);
    for (const ref of cardRefsOf(next, true)) {
      if (ref.tracker !== "github" || ref.number === undefined) continue;
      const statusRepo = ticketStatusRepo(ref, repo);
      const before = prev.statusFor?.(statusRepo, ref.number);
      const after = next.statusFor?.(statusRepo, ref.number);
      if (before?.kind !== after?.kind || before?.state !== after?.state) return false;
    }
  }
  if (!sameThreadList(prev.childThreads, next.childThreads)) return false;
  if (prev.grandchildThreadsByParent !== next.grandchildThreadsByParent) {
    // The map is board-wide and rebuilt whenever the assembly is (a pane
    // capture joins its deps), but a card only paints the sub-rows of ITS
    // OWN children — so only those lists must match, exactly like the
    // membership probes above.
    const prevMap = prev.grandchildThreadsByParent;
    const nextMap = next.grandchildThreadsByParent;
    for (const child of next.childThreads ?? []) {
      if (!sameThreadList(prevMap?.get(child.id), nextMap?.get(child.id))) return false;
    }
  }
  if (prev.childRankDrag?.line?.childId !== next.childRankDrag?.line?.childId) return false;
  if (prev.childRankDrag?.line?.zone !== next.childRankDrag?.line?.zone) return false;
  // The dot strip's own gesture state (issues #249/#172), which the board
  // rebuilds every render: the insertion line, the boundary-escape flag, and
  // the strip's nest-target hover (the dragged card's identity plus the
  // pointer position the bubble tracks). Every field is compared by value;
  // the closures churn by design, like the other gesture objects.
  if (prev.childDotDrag?.line?.memberId !== next.childDotDrag?.line?.memberId) return false;
  if (prev.childDotDrag?.line?.zone !== next.childDotDrag?.line?.zone) return false;
  if (prev.childDotDrag?.escaped !== next.childDotDrag?.escaped) return false;
  if (prev.stripNestHover?.member !== next.stripNestHover?.member) return false;
  if (prev.stripNestHover?.x !== next.stripNestHover?.x) return false;
  if (prev.stripNestHover?.y !== next.stripNestHover?.y) return false;
  // The strip's card-drag nest affordance: non-null exactly while a card
  // drag hovers this family's strip, so its presence must re-render.
  if ((prev.stripNestDrag === undefined) !== (next.stripNestDrag === undefined)) return false;
  // Menus: content-equal is the bar (closures churn by design).
  if (!sameMenuActions(prev.menuActions, next.menuActions)) return false;
  const prevChildMenus = prev.childMenuActions;
  const nextChildMenus = next.childMenuActions;
  if (prevChildMenus !== nextChildMenus) {
    if (prevChildMenus === undefined || nextChildMenus === undefined) return false;
    for (const child of next.childThreads ?? []) {
      if (!sameMenuActions(prevChildMenus(child), nextChildMenus(child))) return false;
    }
  }
  // Per-id lookups the card consumes as results: compare results, not
  // lookup identity.
  if (prev.snoozeFor !== next.snoozeFor) {
    if (prev.snoozeFor === undefined || next.snoozeFor === undefined) return false;
    for (const id of ids) {
      if (prev.snoozeFor(id) !== next.snoozeFor(id)) return false;
    }
  }
  // The rate lookup (issue #279) is the same kind of per-id prop as the snooze
  // lookup above: a poll that moves one thread's rate must repaint the cards
  // that paint THAT thread (its own family strip, or a card that lists it as a
  // child), and nothing else.
  if (prev.pulseRateFor !== next.pulseRateFor) {
    if (prev.pulseRateFor === undefined || next.pulseRateFor === undefined) return false;
    for (const id of ids) {
      if (prev.pulseRateFor(id) !== next.pulseRateFor(id)) return false;
    }
  }
  return true;
}

export const ThreadCard = memo(ThreadCardImpl, sameCardProps);

/** Content equality of one stored link (lib/link-metadata's discriminated
 * union): the fields the chip row renders, never the object identity the
 * per-refetch parsing rebuilds. */
function sameThreadLink(a: ThreadLink | undefined, b: ThreadLink | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.tracker !== b.tracker) return false;
  if (a.createdAt !== b.createdAt || a.source !== b.source) return false;
  if (a.tracker === "github" && b.tracker === "github") {
    return a.repo === b.repo && a.issue === b.issue && a.kind === b.kind && a.href === b.href;
  }
  if (a.tracker === "external" && b.tracker === "external") {
    return a.url === b.url && a.hostname === b.hostname && (a.label ?? null) === (b.label ?? null);
  }
  return false;
}