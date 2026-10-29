import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { BoardColumn, GroupBy, LaneHideOutcome } from "./grouping";
import { JIRA_COLUMN_ID, THREAD_STATE_LABELS, threadState } from "./grouping";
import { JiraColumnSlot } from "./jira-column";
import {
  sweepColumnKind,
  sweepDestination,
  sweepRangeIds,
  sweepRemovesThreads,
  type ArmedSweep,
  type SweepDestination,
  type SweepNotice,
  type SweepRunView,
} from "../lib/sweep";
import { SweepButton, SweepCancelButton } from "./sweep-button";
import { SweepNoticeBanner, SweepRefusalBanner } from "./sweep-banners";
import { ThreadCard } from "./thread-card";
import { useCardSpotlightStyles } from "./card-spotlight";
import { attentionPulseRef, useAttentionPulseGate } from "./attention-pulse-gate";
import { DOT_PULSE_ATTR, dotPulseStyle, useDotPulseStyles } from "./dot-pulse";
import { pulsePeriodMs } from "../lib/pulse-rate";
import { MenuPopover } from "./menu-popover";
import type { ThreadLink } from "../lib/link-metadata";
import { groupBoxMenuActions } from "../lib/group-metadata";
import { containerSlideY, containerSlideX, dropZoneForPoint, listScrollX, listScrollY } from "./board-scroll";
import type { CardMenuAction } from "./thread-card-menu";
import type { BrowserRevealNotice } from "@/lib/browser-reveal";
import { Icon } from "@/components/ui/icon";
import { usePrefersReducedMotion } from "@/components/ui/hooks/use-media-query";
import { cn } from "@/lib/utils";
import {
  childRankKey,
  columnIsRanked,
  columnRankKey,
  displayAfterMove,
  DRAG_ID_KEY,
  isLaneDrag,
  isDotDrag,
  moveTargetFor,
  rankDragType,
  type RankStore,
} from "../lib/rank";
import { reparentRefusalFromParents } from "../lib/reparent";
import { flatNestReason } from "./nesting";
import {
  canJoinGroup,
  columnRunInfo,
  flattenRuns,
  inBoxMoveTarget,
  runsFromColumns,
  unitMoveTarget,
  type ColumnRunInfo,
  type GroupBox,
  type GroupBoxMap,
  type GroupRunItem,
} from "../components/group-boxes";
import { displayAfterUnitMove } from "../lib/rank-unit-move";
import {
  arrivalGrowKeyframes,
  cardRowGapPx,
  computedMarginPx,
  firstRealCard,
  ghostCollapseKeyframes,
  insertGhostSlots,
  laneSignature,
  planLaneTransports,
  collapseRunTransports,
  runUnits,
  TRANSPORT_BATCH_CAP,
  TRANSPORT_COLLAPSE_MS,
  TRANSPORT_EASE,
  TRANSPORT_GROW_EASE,
  TRANSPORT_GROW_MS,
  TRANSPORT_ROW_GAP_PX,
  TRANSPORT_SPARK_COUNT,
  TRANSPORT_VARIANT,
  TRANSPORT_WIPE_IN_MS,
  TRANSPORT_WIPE_OUT_MS,
  TRANSPORT_ZOOM_IN_EASE,
  TRANSPORT_ZOOM_IN_MS,
  TRANSPORT_ZOOM_OUT_EASE,
  TRANSPORT_ZOOM_OUT_MS,
  transportPhasePlan,
  pacedTransportMs,
  wipeInKeyframes,
  wipeOutKeyframes,
  zoomInKeyframes,
  zoomOutKeyframes,
  shimmerSparks,
  sparkKeyframes,
  type LaneTransport,
  type RunUnit,
  type TransportArrivalPhase,
  type TransportAxis,
  type TransportOutPhase,
  type TransportPlay,
  type TransportSpark,
  type TransportVariantId,
} from "./card-transport";
import type { MotionPacing } from "./preferences";

/**
 * The shimmer's static half: a field of glints laid over one transport slot
 * (the dissolving ghost or the materializing arrival), one span per
 * `shimmerSparks` entry. Invisible at rest — the start effect's WAAPI
 * twinkle brings each glint up, and a no-WAAPI environment (jsdom's phase
 * machine) holds them at 0, so the dissolve never leaves glitter behind in
 * an environment that cannot animate it away. The travel grammar differs
 * per sweep direction: departing glints rise silver from the bottom, and
 * arriving glints descend in amber from the top (operator: "departing is
 * up, and arriving is down").
 */

/** A sweep's beam palette: the kept silver beam leaves, amber arrives. */
const SPARK_TONES = {
  out: {
    gradient: "linear-gradient(to top, rgba(186,230,253,0), #bae6fd 30%, #f0f9ff 85%)",
    glow: "0 0 5px 1px rgba(125, 211, 252, 0.85)",
    direction: "up" as const,
  },
  in: {
    gradient: "linear-gradient(to bottom, rgba(253,230,138,0), #fde68a 30%, #fef9c3 85%)",
    glow: "0 0 5px 1px rgba(252, 211, 77, 0.85)",
    direction: "down" as const,
  },
} as const;

function TransportSparkLayer({
  phaseMs,
  tone,
}: {
  phaseMs: number;
  tone: keyof typeof SPARK_TONES;
}) {
  const palette = SPARK_TONES[tone];
  const sparks = shimmerSparks(phaseMs, TRANSPORT_SPARK_COUNT, undefined, palette.direction);
  return (
    <span
      aria-hidden
      data-transport-sparks=""
      data-transport-spark-tone={tone}
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
    >
      {sparks.map((spark, index) => (
        <span
          key={index}
          data-transport-spark=""
          // The glint's WHOLE life rides the DOM: the start effect animates
          // exactly this state, so the rendered field and the animated field
          // are the same by construction (a once-recomputed default gave
          // every glint an upward drift, even on the downward arrival).
          data-spark-state={JSON.stringify(spark)}
          style={{
            position: "absolute",
            left: `${spark.leftPct.toFixed(1)}%`,
            top: `${spark.topPct.toFixed(1)}%`,
            width: `${spark.widthPx.toFixed(2)}px`,
            height: `${spark.heightPx.toFixed(1)}px`,
            borderRadius: "9999px",
            background: palette.gradient,
            boxShadow: palette.glow,
            filter: "blur(0.3px)",
            opacity: 0,
          }}
        />
      ))}
    </span>
  );
}

/** The group plan absents itself when the caller has no group data. */
const EMPTY_GROUP_BOXES: GroupBoxMap = new Map();

/**
 * The fold key a Done projection card reads and reports: a root's two cards
 * fold separately (the derived ruleset's Defect 8 — one shared fold folded
 * both), so a projection's stored fold is prefixed to keep both entries in
 * the one collapsed list.
 */
function foldKeyForSpace(threadId: string): string {
  return `done:${threadId}`;
}

/** The parent map absents itself when the caller has no nesting data. */
const EMPTY_PARENT_OF: ReadonlyMap<string, string> = new Map();

/**
 * The lane the drag came from is carried in the MIME **type name**, not in a
 * payload value. A real browser holds the drag payload write-only until the
 * drop: `getData` returns "" during `dragover`, so any handler that decides
 * from `getData` mid-drag silently sees nothing, never calls
 * `preventDefault`, and the browser then refuses the drop outright. `types`
 * stays readable for the whole drag, so the lane is discoverable exactly when
 * the drop has to be authorised. Reading the lane from the type name is the
 * difference between a reorder that works and one that does nothing.
 * (`DRAG_ID_KEY` comes from lib/rank, shared with the nested child rows,
 * which are drag sources too — dropping one on a floor detaches it.)
 */

/** How long a refusal banner stays on screen before auto-dismissing. */
const RANK_ERROR_AUTO_DISMISS_MS = 10_000;

/** Where an insertion line would land: before or after the hovered card. */
type Half = "before" | "after";
/**
 * Where a drop on a card lands. The before/after edges are the insertion
 * line the board always had; `onto` is the card's middle third — dropping
 * there nests the dragged card UNDER the hovered card instead of beside it.
 * The nest zone is offered only when the caller wired a re-parent write and
 * the guard allows the edge (never onto itself, never closing a family loop).
 */
type DropZone = Half | "onto";

/**
 * The dragged card, for a DROP.
 *
 * Read from the payload first: `drop` is one of the two moments the browser
 * lets a handler read it, so this is the authoritative source. The ref is the
 * fallback for the rare case where a payload is unavailable, and it must never
 * be the only source — losing it silently turns every reorder into a no-op,
 * because an empty id makes `applyMove` return the order unchanged and the
 * RPC reject it, with nothing on screen to say why.
 */
function draggedIdFor(
  event: React.DragEvent,
  fallback: string | null,
): string {
  return event.dataTransfer.getData(DRAG_ID_KEY) || fallback || "";
}

/**
 * The Done projection card's child-count chip: every member the projection's
 * Done card carries — its done rows, plus the members nesting under each row
 * (a done child of a done member nests via the nested map, issue #120), the
 * sub-row tier included. `doneRowsByParent` holds the projection's own rows;
 * `nestedRowsByParent` holds the members nested under any of them.
 */
function countDoneRows(
  doneRowsByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>,
  nestedRowsByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>,
  parentId: string,
): number {
  let count = 0;
  for (const row of doneRowsByParent.get(parentId) ?? []) {
    count += 1;
    for (const sub of nestedRowsByParent.get(row.id) ?? []) {
      count += 1 + nestedRowCount(nestedRowsByParent, sub.id);
    }
  }
  return count;
}

function nestedRowCount(
  nestedRowsByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>,
  parentId: string,
): number {
  let count = 0;
  for (const row of nestedRowsByParent.get(parentId) ?? []) {
    count += 1 + nestedRowCount(nestedRowsByParent, row.id);
  }
  return count;
}

interface BoardProps {
  columns: readonly BoardColumn[];
  /** The active grouping — a column's rank key is namespaced by it. */
  groupBy: GroupBy;
  activeThreadId: string | null;  doneIds: ReadonlySet<string>;
  /** Clear-error acknowledgment ids (issue #157): acked error dots sit quiet. */
  errorAckIds?: ReadonlySet<string>;
  /** Parent id → children that render as nested rows under the parent card. */
  nestedChildrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  /**
   * Parent id → ALL its visible children (raw family index); drives the
   * child-count chip, which counts children that render standalone too.
   */
  childCountByParent: ReadonlyMap<string, number>;
  /**
   * Parent id → done children that render nested under the family's
   * projection card in the Done column. A live parent's card in the Done
   * column IS that projection: it shows the done portion of the family while
   * the active card keeps the live portion.
   */
  doneChildrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  /**
   * Thread id → its feature-group family box ({ groupId, name }) — the
   * dashed outline wrapper for sibling threads sharing a named group.
   * Holds ONLY threads that render inside a box (pinned and done members
   * are absent — a group of one KEEPS its box, its lone member included);
   * undefined/empty when the caller has no group data and every card
   * renders standalone. The box is decoration and the group's drop target:
   * no dot, no pill, no color — the name is secondary text.
   */
  groupBoxOf?: GroupBoxMap;
  /**
   * The lane-transport animation this board plays: the transporter dissolve
   * (default) or the zoom (shrink out / grow in). The selection seam the
   * upcoming transition settings dispatch on — the module default stands in
   * until a caller passes the operator's choice.
   */
  transportVariant?: TransportVariantId;
  /**
   * Join a dragged card to a registry group by dropping it on the group's
   * box container (the dashed outline's own surface: label, padding, and
   * the gaps between member cards — a member card's surface keeps its own
   * edge/nest gestures). The caller runs the group write; the board only
   * decides eligibility (see canJoinGroup). Unwired → boxes refuse drops.
   */
  onJoinGroup?: (droppedId: string, groupId: string) => void;
  /**
   * The feature group the operator last group-clicked (issue #86): every
   * lane's frame of this group renders amber. Null clears. The board's
   * click surface drives it — a member card's click marks the card's group,
   * a frame's own surface toggles, and a click on anything that is not a
   * group frame clears.
   */
  highlightedGroupId?: string | null;
  /** Sets the amber group highlight (null clears). Unwired → frames never highlight. */
  onHighlightGroup?: (groupId: string | null) => void;
  /**
   * Rename a registry group from the box label: clicking the label turns it
   * into an inline text input, Enter (or blur) commits the trimmed name,
   * Escape cancels. The caller settles the shared record — every member
   * card re-labels through the registry (names live in one place).
   */
  onRenameGroup?: (groupId: string, name: string) => void;
  /**
   * Delete a registry group from the label editor's trashcan: the editor
   * arms on the first click (like the picker's two-step delete) and this
   * callback fires on the confirm click. Server-side, the record AND every
   * member's assignment go together.
   */
  onDeleteGroup?: (groupId: string) => void;
  /**
   * Start a new thread for a registry group (the box context menu's "New
   * thread in group…"): the caller seeds the composer from the members'
   * majority settings and tags the spawned thread into the group. Unwired →
   * the menu offers no spawn entry.
   */
  onNewThreadInGroup?: (groupId: string) => void;
  /**
   * Zoom the board to a registry group (the box context menu's "Zoom to
   * group"): the caller lands the board on the Group view (the view the
   * group boxes belong to) and writes the existing group filter restricted
   * to exactly that group, so the board shows the group's threads only and
   * the toolbar chip clears it back. Unwired → the menu offers no zoom
   * entry.
   */
  onZoomToGroup?: (groupId: string) => void;
  /** Family members that did not match the active filters; rendered dimmed. */
  dimmedIds: ReadonlySet<string>;
  /**
   * Parent ids whose nested rows are collapsed, persisted by the caller.
   * Absent → each card holds its own unpersisted collapse state.
   */
  collapsedFamilyIds?: ReadonlySet<string>;
  /** Reports a family card's collapse/expand gesture (parent id, new state). */
  onFamilyCollapsedChange?: (parentId: string, collapsed: boolean) => void;
  /**
   * Parent ids (Done projections use the fold key `done:<parent id>`, same as
   * the collapse fold) whose child sections hide their idle children,
   * persisted by the caller. Absent → each card holds its own unpersisted
   * filter state.
   */
  hideIdleFamilyIds?: ReadonlySet<string>;
  /** Reports a family card's idle-filter gesture (fold key, hidden state). */
  onFamilyHideIdleChange?: (parentId: string, hide: boolean) => void;
  /**
   * Group ids whose dashed family boxes fold into ONE normal-size card (the
   * box's member cards hide). Persisted by the caller; absent → boxes always
   * render expanded and no fold affordance appears (a board that cannot
   * expand a folded box must never fold one).
   */
  collapsedGroupIds?: ReadonlySet<string>;
  /** Reports a group box's collapse/expand gesture (group id, new state). */
  onGroupCollapsedChange?: (groupId: string, collapsed: boolean) => void;
  /**
   * Attention reporting (components/attention-freeze): the card a pointer
   * enters, and the card it leaves. The caller captures each entered card's
   * rendered placement and pins it for the attention's duration — every card
   * under attention holds its lane and slot while live data churns.
   */
  onAttentionEnter?: (threadId: string) => void;
  onAttentionLeave?: (threadId: string) => void;
  projectNameFor: (projectId: string) => string;
  /** GitHub repo base per project ("https://github.com/owner/repo"), when known. */
  repoBaseFor: (projectId: string) => string | null;
  /** GitHub cache status for a repo slug + number, when known. */
  statusFor?: (repo: string | null, number: number | undefined) =>
    | { kind: string; state: string }
    | undefined;
  /** The board's own GitHub links per thread id (metadata "linkedIssues"). */
  linkedIssuesFor?: (threadId: string) => ThreadLink[] | undefined;
  /** Hrefs tracker_validate confirmed; text refs chip only for these. */
  validatedHrefs?: ReadonlySet<string>;
  onOpenThread: (threadId: string) => void;
  /** Close the open thread pane when the operator clicks empty board area. */
  onClosePane?: () => void;
  onNewTask: () => void;
  /**
   * Per-column manual orders. A column is reorderable only when it has a
   * stored order, so the board never shows a drag affordance for a
   * rearrange it would silently discard.
   */
  rankStore?: RankStore;
  /**
   * Move `threadId` within `columnKey`. `beforeId` names the card to land in
   * front of (null = top); `toEnd` drops below the last ranked card instead,
   * which is a different intent that would otherwise share the null.
   * `visibleIds` is the column's displayed order, so the writer can rank
   * every card above the drop point — without it, a first drop into an
   * unranked column would rank one card and reorder nothing.
   */
  onRankMove?: (
    columnKey: string,
    threadId: string,
    beforeId: string | null,
    toEnd: boolean,
    visibleIds: readonly string[],
    /**
     * The dragged card's family-box unit (its members in display order) —
     * present ONLY when the dragged card is boxed, so card-level callers
     * keep the card-shaped five-argument contract. The box lands
     * contiguously and ranks together.
     */
    unitIds?: readonly string[],
  ) => void;
  /**
   * Drop a card ONTO a card: make the dropped thread a child of the target.
   * The write goes to the caller (the RPC lives app-side); the board has
   * already refused the illegal edges — a drop onto itself or onto the
   * dropped card's own descendant. Optional: without it the card's middle
   * third is just another insertion edge, exactly as before nesting existed.
   */
  onReparent?: (childId: string, parentThreadId: string | null) => Promise<void>;
  /**
   * The RAW parent edges (child id → parent id), not the display index's
   * two-level flattened map: the nest guard must see real chains, so a
   * grandchild dropped onto its grandparent still counts as a change.
   * Absent → every nest-in-flight edge reads as allowed, because the board
   * cannot know; the caller (and the RPC handler) still re-check.
   */
  rawParentOf?: ReadonlyMap<string, string>;
  /** Drop a card onto the Done column. */
  onDropDone: (threadId: string) => void;
  /** Drop a card onto the Unread column (Attention grouping only). */
  onDropUnread: (threadId: string) => void;
  /**
   * Drop a card onto the Pinned column. Optional because pinning is a state
   * change the caller may not wire: the column then stays a no-drop target,
   * exactly as before this prop existed.
   */
  onDropPinned?: (threadId: string) => void;
  /**
   * The Project view's hide-a-lane write: the caller turns the lane's
   * project out of the Project filter and the Board renders the report the
   * outcome carries (or the refused "why"). Absent, no lane offers the
   * affordance — there is nothing the gesture could write.
   */
  onHideLane?: (columnId: string) => LaneHideOutcome;
  /**
   * One-shot lane-reveal request from a menu action that relocates a card
   * (see the reveal effect inside `Board`). Seq-numbered so the board can
   * consume each request exactly once; optional because only app.tsx issues
   * them today.
   */
  reveal?: { threadId: string; seq: number } | null;
  /** Right-click menu actions for one thread, sidebar-menu style. */
  menuActionsFor: (thread: PluginSidebarThread) => readonly CardMenuAction[];
  /**
   * Snooze wake lookup (lib/snooze): the wake epoch-ms for a snoozed thread,
   * null otherwise. Wired through to cards — dim in place, the wake chip,
   * and the card-level drag refusal.
   */
  snoozeFor?: (threadId: string) => number | null;
  /**
   * Token burn rate lookup in tokens per second (issue #279), from
   * `usePulseRates`. It paces the pulse of a folded family box's `working`
   * member dots, and rides through to the cards' collapsed strips. An id the
   * sampler cannot measure yet is absent, which is the honest unmeasured state
   * and holds the base period rather than freezing the dot.
   */
  pulseRateFor?: (threadId: string) => number | undefined;
  /**
   * Sweep wiring: eligibility per column (empty when nothing is eligible),
   * and the armed lifecycle. Arming pre-selects the past-threshold
   * candidates; from there `armedSweep`'s list is LIVE — card clicks toggle
   * membership, and the list is what displays, gathers, and confirms.
   */
  sweepCandidatesFor?: (columnId: string) => readonly string[];
  armedSweep?: ArmedSweep | null;
  /**
   * A confirmed sweep in progress (null when idle). While it runs for a
   * column, that column's remaining candidates keep the armed highlight, the
   * active card carries the throbber, and the sweep button shows progress
   * and refuses clicks.
   */
  sweepRun?: SweepRunView | null;
  /** A finished sweep's failure summary; null hides the banner. */
  sweepNotice?: SweepNotice | null;
  onDismissSweepNotice?: () => void;
  /**
   * A rank write the host rejected (issue #232: the failure path refetched
   * the stored order silently, so the operator watched a landing fall back
   * with no word); null hides the banner. The caller owns the state — the
   * board's own rankError covers refusals it refuses itself, and a rejected
   * write happens beyond it, on the rpc the caller runs.
   */
  rankSaveError?: string | null;
  onDismissRankSaveError?: () => void;
  /**
   * A family-state write the host rejected (a fold or idle-hide toggle that
   * did not save): the toggle rolled back to the server's truth and this names
   * the failure; null hides the banner.
   */
  familyStateSaveError?: string | null;
  onDismissFamilyStateSaveError?: () => void;
  /**
   * The browser-reveal gesture's honest outcome on the operator's board
   * surface (a thread with no controlled tab, a stuck-hidden tab, or a
   * listing failure); null hides the banner.
   */
  browserNotice?: BrowserRevealNotice | null;
  onDismissBrowserNotice?: () => void;
  /** Reverses a cancelled run's settled ids per their arm's destination. */
  onSweepUndo?: (
    threadIds: readonly string[],
    destination: SweepDestination,
  ) => void;
  /**
   * Flips a card's sweep-selection membership. Called only for cards in the
   * armed column; the board refuses ids in `sweepBlockedIds` itself.
   */
  onSweepToggle?: (threadId: string) => void;
  /**
   * Adds a shift-click's range to the live selection (union, never
   * subtractive). The board computes the ids — anchor through the clicked
   * card in display order, cards that may not join dropped — and reports
   * them; the caller applies them to `armedSweep`.
   */
  onSweepRangeSelect?: (threadIds: readonly string[]) => void;
  /**
   * Threads that may never join a sweep (live-child parents, the
   * sweep-family contract). Arm-scoped: only the arms whose action removes
   * the thread from the live board (Done → Archive, idle → Done) apply it;
   * Pinned and Unread sweeps leave threads live, so parents join there. In
   * a blocked arm their cards neither select nor carry the selectable ring,
   * and clicking one refuses on screen.
   */
  sweepBlockedIds?: ReadonlySet<string>;
  onSweepArm?: (columnId: string) => void;
  onSweepDisarm?: () => void;
  onSweepConfirm?: (columnId: string) => void;
  /**
   * The Appearance tab's card-transport choice: `teleport` (default) runs
   * the transporter dissolve, `none` relocates cards instantly (the planner
   * never runs), `zoom` is a future read — the settings tab keeps it
   * disabled so it never reaches the board.
   */
  cardTransport?: "none" | "teleport" | "zoom";
  /**
   * The Appearance tab's motion preference: `manual` reads the pacing
   * slider instead (a `reduce` notch quiets the board, a number stretches
   * the transport clock); `system` (default) defers to the OS media query
   * and plays stock.
   */
  motionPref?: "system" | "manual";
  /**
   * The Appearance tab's transports' pacing (components/preferences.ts):
   * the notched slider's value. "reduce" quiets the board (with a manual
   * motion preference); 1 is stock; 2, 4, and 8 stretch the transport
   * clocks log-scale. Ignored while the board follows the system (stock).
   */
  motionPacing?: MotionPacing;
  /**
   * The Appearance tab's lane direction (issue #153): `vertical` (default)
   * is the shipped column board (lanes as columns, cards stacking downward);
   * `horizontal` reads every lane as a row, its cards flowing left-to-right,
   * with the board scrolling vertically between lanes. It is a REAL LAYOUT
   * read, not just styling: every flow-aware piece follows it — the
   * drop-zone thirds split on the flow axis, the insertion line renders on
   * the flow edge, the reorder keys become Left/Right, the keep-in-view
   * corrections slide the new axes, and the transport's ghost collapse and
   * arrival grow measure the flow axis.
   */
  laneDirection?: "vertical" | "horizontal";
  /**
   * The sweep's way out, whatever state it is in: an armed mode exits
   * (disarm), a running sweep stops before its next archive. The board
   * renders the button and labels it per state; the caller dispatches.
   */
  onSweepCancel?: () => void;
}

const DOT_CLASS: Record<string, string> = {
  working: "bg-blue-500",
  attention: "bg-amber-500",
  unread: "bg-emerald-500",
  idle: "bg-muted-foreground/30",
};

function StateDot({
  thread,
  errorAcks = new Set<string>(),
}: {
  thread: PluginSidebarThread;
  /** Clear-error acknowledgment ids (issue #157): an acked error dot sits quiet. */
  errorAcks?: ReadonlySet<string>;
}) {
  return (
    <span
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        DOT_CLASS[threadState(thread, errorAcks)] ?? "bg-muted-foreground/30",
      )}
      aria-hidden
    />
  );
}

export function Board({
  columns,
  groupBy,
  activeThreadId,
  doneIds,
  errorAckIds,
  nestedChildrenByParent,
  childCountByParent,
  doneChildrenByParent,
  groupBoxOf,
  highlightedGroupId = null,
  onHighlightGroup,
  transportVariant = TRANSPORT_VARIANT,
  onRenameGroup,
  onDeleteGroup,
  onNewThreadInGroup,
  onZoomToGroup,
  onJoinGroup,
  dimmedIds,
  collapsedFamilyIds,
  onFamilyCollapsedChange,
  hideIdleFamilyIds,
  onFamilyHideIdleChange,
  collapsedGroupIds,
  onGroupCollapsedChange,
  projectNameFor,
  repoBaseFor,
  statusFor,
  linkedIssuesFor,
  validatedHrefs,
  onOpenThread,
  onNewTask,
  onClosePane,
  rankStore,
  onRankMove,
  onAttentionEnter,
  onAttentionLeave,
  onReparent,
  rawParentOf,
  onDropDone,
  onDropUnread,
  onDropPinned,
  onHideLane,
  reveal = null,
  menuActionsFor,
  snoozeFor,
  pulseRateFor,
  sweepCandidatesFor,
  armedSweep = null,
  sweepRun = null,
  sweepNotice = null,
  onDismissSweepNotice,
  rankSaveError = null,
  onDismissRankSaveError,
  familyStateSaveError = null,
  onDismissFamilyStateSaveError,
  browserNotice = null,
  onDismissBrowserNotice,
  onSweepUndo,
  onSweepToggle,
  onSweepRangeSelect,
  sweepBlockedIds,
  onSweepArm,
  onSweepDisarm,
  onSweepConfirm,
  cardTransport,
  motionPref = "system",
  motionPacing = 1,
  // The lane direction: a Board called without it renders the shipped
  // vertical column board exactly as before.
  laneDirection = "vertical",
  onSweepCancel,
}: BoardProps) {
  // The spotlight rule (components/card-spotlight.ts) is document-global CSS;
  // each board mounts it idempotently, so whichever board renders first wins.
  useCardSpotlightStyles();
  useAttentionPulseGate();
  // The working dot's rate pulse (issue #279): the keyframes rule the collapsed
  // dots animate through, mounted once per document like the gate above.
  useDotPulseStyles();
  // One flow read for every axis-aware site: which way the board scrolls,
  // which rect axis the drop thirds split on, which keys reorder, and which
  // dimension the transport's ghost collapse and arrival grow measure.
  const flowAxis: TransportAxis = laneDirection;
  const horizontalLanes = flowAxis === "horizontal";
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  // The column floor an UNNEST hover lights up (amber). Kept separate from
  // dragOverColumn so the two affordances cannot argue over ring color: the
  // family write wins wherever both apply, because the drop's family effect
  // is the surprising half.
  const [familyFloorColumn, setFamilyFloorColumn] = useState<string | null>(null);
  // The column HEADER a family hover lights up (amber), next to the floor:
  // the header sits inside the section so a drop on it bubbles to the
  // section's handlers for free — this state is the hover affordance only.
  const [familyHeaderColumn, setFamilyHeaderColumn] = useState<string | null>(null);
  // True while any card or child-row drag is in flight: headers grow a few
  // pixels so the small title strip is easier to hit as a detach target.
  const [dragInFlight, setDragInFlight] = useState(false);
  // { columnId, threadId, zone } for the drop the cursor is over while a
  // ranked card is dragged over a ranked column. `zone` is an insertion edge
  // ("before"/"after") or the nest zone ("onto") — a drop in the hovered
  // card's middle third that nests the dragged card under it. Null when no
  // drop is in flight.
  const [rankDrop, setRankDrop] = useState<{
    columnId: string;
    threadId: string;
    zone: DropZone;
  } | null>(null);
  /**
   * The nested row showing an insertion line for a same-family reorder: the
   * drop writes the family's own child rank order (`child:<parentId>`), never
   * the parent card's column order — those are two different orders and only
   * one of them means "row order under this parent". Cleared with every
   * other drag promise on dragend, dragleave, and after a commit.
   */
  const [childDrop, setChildDrop] = useState<{
    parentId: string;
    childId: string;
    zone: Half;
  } | null>(null);

  function clearChildDrop(): void {
    setChildDrop(null);
  }

  /**
   * The collapsed strip's dot carrying the vertical insertion line of a
   * dot-drag reorder (issue #249): `familyId` is the strip's own parent
   * thread (the card the strip belongs to), so two strips never show each
   * other's promise; `memberId` is the hovered dot, `zone` its outer half.
   * Cleared at dragstart, dragleave, after a commit, and at dragend — the
   * same promises-are-promises lifecycle as `childDrop`.
   */
  const [childDotLine, setChildDotLine] = useState<{
    familyId: string;
    memberId: string;
    zone: Half;
  } | null>(null);

  /**
   * The strip-nest hover (issue #249, goal 6): the CARD a collapsed family's
   * dot field is about to child, with the pointer position for the pinned
   * bubble. Board-owned, like every other dot-surface decision: the strip
   * handlers only report; the targeting, the refusal, and the write live
   * with the board through the existing reparent path.
   */
  const [stripNestHover, setStripNestHover] = useState<{
    familyId: string;
    member: PluginSidebarThread;
    x: number;
    y: number;
  } | null>(null);

  // The shift-click anchor: the last card clicked without Shift in the armed
  // column. Shift extends the selection from it (it stays put — standard
  // list semantics); plain and cmd/ctrl clicks move it. Reset whenever the
  // armed column changes or sweep mode ends, so a re-arm never inherits an
  // old anchor from a previous session.
  const sweepAnchorRef = useRef<{ columnId: string; threadId: string } | null>(null);
  const armedColumnId = armedSweep?.columnId ?? null;
  useEffect(() => {
    sweepAnchorRef.current = null;
  }, [armedColumnId]);

  // When the thread pane opens (or is resized) the board container shrinks;
  // keep the open thread's card in view by scrolling it into the visible
  // horizontal range instead of letting the pane cover it.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The lane the active card currently sits in (a stable id string, not the
  // columns array identity). The effect re-fits when this changes — pin/
  // unpin, done, archive, and grouping changes all relocate the card to a
  // lane that can be offscreen — while mere data refreshes (same lane) never
  // yank the user's scroll.
  const activeCardLaneId = useMemo(() => {
    if (activeThreadId === null) return null;
    for (const column of columns) {
      if (column.threads.some((thread) => thread.id === activeThreadId)) {
        return column.id;
      }
    }
    return null;
  }, [columns, activeThreadId]);
  useEffect(() => {
    const container = scrollRef.current;
    if (container === null || activeThreadId === null) return;
    const keepActiveCardInView = () => {
      const card = firstRealCard(container, activeThreadId);
      if (!(card instanceof HTMLElement)) return;
      // The container slides along ITS OWN scroll axis: horizontal, the
      // pane opening (or a drag resize) narrows the visible range; vertical
      // (horizontal lane rows), a lane row beyond the board's visible range
      // slides that scroll. The lane's own list always corrects its card
      // along the card flow inside it — a vertical lane's list scrolls its
      // stack, a horizontal lane's row scrolls its flow — and a card that
      // history just restored (deep link, back/forward — no click preceded
      // it) can sit beyond the fold; the list is adjusted directly — never
      // scrollIntoView, which would scroll every ancestor including the
      // host page.
      const cardRect = card.getBoundingClientRect();
      if (horizontalLanes) {
        container.scrollTop += containerSlideY(container.getBoundingClientRect(), cardRect);
      } else {
        container.scrollLeft += containerSlideX(container.getBoundingClientRect(), cardRect);
      }
      const list = card.closest("[data-card-list]");
      if (list instanceof HTMLElement) {
        if (horizontalLanes) {
          list.scrollLeft += listScrollX(list.getBoundingClientRect(), cardRect);
        } else {
          list.scrollTop += listScrollY(list.getBoundingClientRect(), cardRect);
        }
      }
    };
    keepActiveCardInView();
    // Pane opening and drag-resizing both change the container's width; the
    // observer re-runs the adjustment for each size change. The re-fit gates
    // on WIDTH: mobile browser chrome (URL bar hide/show, keyboard), banners,
    // and composer animations all resize the container's height without
    // touching its width — refitting on those yanked the board horizontally
    // back to the active card's lane (often the far-right end) on every
    // ambient resize, fighting the operator's own scroll. Height-only
    // changes never move a card horizontally, so they can skip the fit.
    let lastObservedWidth = container.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const width = container.getBoundingClientRect().width;
      if (width === lastObservedWidth) return;
      lastObservedWidth = width;
      keepActiveCardInView();
    });
    observer.observe(container);
    return () => observer.disconnect();
    // activeCardLaneId re-fits when the active card relocates (pin, done,
    // archive, grouping change) without firing on same-lane data refreshes;
    // a direction flip re-lays the board, so it refits the same way.
  }, [activeThreadId, activeCardLaneId, laneDirection]);

  // One-shot, intent-scoped bring-into-view (`revealRequest` from app.tsx):
  // every menu action that relocates a card — Pin/Unpin into or out of the
  // far-left Pinned lane, Mark Done/Not Done into or out of the far-right
  // Done lane, Mark Read/Unread out of the Unread column — moves a card the
  // pane never opened, so the keep-in-view effect above (which follows the
  // ACTIVE card) has no key on it, and in a scrolled board the destination
  // lane can be offscreen: the menu action reads as the card silently
  // vanishing from where it was.
  //
  // The request is a CLAIM, not a scroll order. The relocation of an async
  // action (Pin/Unpin/Read go through the host bridge) lands in a LATER
  // render than the click, so a reveal fired at click time would scroll to
  // the card's OLD lane — or, worse, race the data. So the claim survives
  // renders until this effect first sees the card and can bring it into
  // view; app.tsx only issues the claim at the commit the relocation rides
  // (or when the host-applied state it was waiting on lands). Consumed
  // exactly once (seq-gated, key = last-seen seq), so data refreshes and
  // passive state changes never yank the user's scroll.
  //
  // The claim is never re-armed for the same seq after it has scrolled: the
  // stale `reveal` prop stays set in app state (it is replaced, not cleared,
  // by the next action), so a null-and-re-arm here made the SAME reveal
  // re-arm on every later `columns` commit and kept yanking the board back
  // to the revealed card's lane (issue #119). The consumed claim stays in
  // the ref with its seq, so the re-arm gate (`reveal.seq !== claimed seq`)
  // only fires for a genuinely new request; an armed-but-not-yet-found
  // claim keeps `consumed: false` and is honoured on a later commit.
  const revealClaimRef = useRef<{
    seq: number;
    threadId: string;
    consumed: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    if (reveal !== null && reveal.seq !== revealClaimRef.current?.seq) {
      revealClaimRef.current = {
        seq: reveal.seq,
        threadId: reveal.threadId,
        consumed: false,
      };
    }
    const claim = revealClaimRef.current;
    const container = scrollRef.current;
    if (claim === null || claim.consumed || container === null) return;
    const card = firstRealCard(container, claim.threadId);
    if (!(card instanceof HTMLElement)) {
      // Not on the board in this commit (a filter may hide the card, or the
      // host state has not landed yet): keep the claim and re-check on the
      // next board change, so the intent is honoured late rather than lost.
      return;
    }
    const cardRect = card.getBoundingClientRect();
    if (horizontalLanes) {
      container.scrollTop += containerSlideY(container.getBoundingClientRect(), cardRect);
    } else {
      container.scrollLeft += containerSlideX(container.getBoundingClientRect(), cardRect);
    }
    const list = card.closest("[data-card-list]");
    if (list instanceof HTMLElement) {
      if (horizontalLanes) {
        list.scrollLeft += listScrollX(list.getBoundingClientRect(), cardRect);
      } else {
        list.scrollTop += listScrollY(list.getBoundingClientRect(), cardRect);
      }
    }
    claim.consumed = true;
  }, [reveal, columns, laneDirection]);

  // ── The lane transport dissolve ─────────────────────────────────────────
  // A card relocating between lanes in one commit does not teleport: its old
  // lane keeps a GHOST card in the exact old slot while the wipe-out runs,
  // then the ghost's reserved space collapses; at the destination the card
  // sits in the flow from wipe-in's first frame (neighbors reflow as the
  // sweep starts) and dissolves in. Both wipes ease in slightly. Detection
  // diffs each commit's lane map against the previous one (below); the
  // planner's rules — vanish, brand-new, multiplicity, the batch cap — live
  // in components/card-transport.ts.
  const [transports, setTransports] = useState<readonly TransportPlay[]>([]);
  // Reduced motion: the phases still run (the layout choreography — ghost
  // collapse, slot handoff — stays correct for the user reading the board),
  // but no wipe keyframes start and the arriving card never hides behind
  // static styles. The Appearance tab's motion override replaces the media
  // query when the user forces a side.
  const systemReducedMotion = usePrefersReducedMotion();
  // The Motion settings' gate: following the system defers to the OS media
  // query (the checkbox's branch); manual motion reads the slider, whose
  // leftmost notch is reduce and whose numbers stretch every transport clock.
  const prefersReducedMotion =
    motionPref === "manual" && motionPacing === "reduce"
      ? true
      : motionPref === "system"
        ? systemReducedMotion
        : false;
  const paceFactor = motionPacing === "reduce" ? 1 : motionPacing;
  // The transports' pace: every transport clock (the phase timers, the WAAPI
  // durations, the glint field's phase) passes through this one seam, so the
  // stock read above and the stretched read below can never drift apart.
  // Stock pacing is the identity (1 -> the stock milliseconds).
  const paceMs = (ms: number) => pacedTransportMs(ms, paceFactor);
  // The Appearance choice is the operator's voice at the board's own seam:
  // zoom and teleport map onto the transport variants, none never reaches
  // the planner. UNSET, `transportVariant` keeps its own voice — the
  // harness seam for direct Board callers (tests, screenshot runs) stays
  // exactly what the transport threads pinned. The shipped zoom default
  // lives at the settings layer (parseCardTransportStored, which always
  // sends an explicit choice through app.tsx).
  const effectiveTransportVariant =
    cardTransport === "zoom"
      ? "zoom"
      : cardTransport === "teleport"
        ? "dissolve"
        : transportVariant;
  // The shimmer is the dissolve's beam decoration — a field of glints riding
  // the sweeps. The zoom recedes into a portal instead and plays no glint
  // field, so all four shimmer render sites share one read.
  const transportSparksOn = !prefersReducedMotion && effectiveTransportVariant === "dissolve";
  const prevGroupByRef = useRef<GroupBy | null>(null);
  const prevLaneByThreadRef = useRef<ReadonlyMap<string, string> | null>(null);
  // The run-unit map (a box run is ONE unit): diffed per commit so a whole
  // dashed box relocating plans a single dissolve, not one per member.
  const prevRunUnitsRef = useRef<ReadonlyMap<string, RunUnit> | null>(null);
  // The PREVIOUS columns: the moved card has already left its old lane in
  // the next columns, so the true old slot (the ghost's weave position) is
  // only readable from the previous commit's column order.
  const prevColumnsRef = useRef<
    readonly { id: string; threads: readonly PluginSidebarThread[] }[] | null
  >(null);
  const prevThreadsRef = useRef<ReadonlyMap<string, PluginSidebarThread>>(new Map());
  // The PREVIOUS plan's groupBoxOf: the previous commit's displayed order
  // (what ghost slots weave against) comes from re-running the gather walk
  // over the previous columns with the group map that rendered them.
  const prevGroupBoxOfRef = useRef<GroupBoxMap | null>(null);
  const transportGenRef = useRef(0);
  const transportTimersRef = useRef(new Map<string, number[]>());
  // The WAAPI handles per phase key: the phase timers cancel the arrival
  // wipe at settle and the ghost wipes at removal, so finished animations
  // never persist on live cards.
  const transportAnimsRef = useRef(new Map<string, Animation>());
  // The shimmer's glint handles, per phase key (a group of WAAPI animations
  // per slot): the phase transitions cancel them the same way the wipes die,
  // so no spark ever holds compositor work after its phase ends.
  const transportSparkAnimsRef = useRef(new Map<string, Animation[]>());
  // Elements for the WAAPI wipes, keyed per phase generation (a re-located
  // card mid-flight restarts, so a bare id would swallow the second wipe).
  const transportElsRef = useRef(new Map<string, HTMLElement | null>());
  const startedWipesRef = useRef(new Set<string>());
  // Pre-clip geometry, captured the commit the ghost first rendered: the
  // collapsing phase's static max-size-0 styles are already ON the ghost
  // when the collapse animation starts, so a getBoundingClientRect() there
  // measures 0 and the smooth close would collapse from nothing (an instant
  // jump). The wipe-start commit's unclipped slot is the only honest place
  // to read the ghost's flow size and margins (the height in a vertical
  // lane, the width in a horizontal one).
  const transportMetricsRef = useRef(
    new Map<string, { sizePx: number; marginStartPx: string; marginEndPx: string }>(),
  );

  // Diff the lane map. A grouping change re-derives EVERY lane at once and
  // reads as a view switch — never a wall of wipes — so it re-seeds the
  // snapshot without planning. The batch cap catches the other whole-board
  // re-derivations (a large multi-move commit) the same way.
  useLayoutEffect(() => {
    const groupByChanged = prevGroupByRef.current !== groupBy;
    prevGroupByRef.current = groupBy;
    const laneByThread = laneSignature(columns);
    const threadsById = new Map<string, PluginSidebarThread>();
    for (const column of columns) {
      for (const card of column.threads) threadsById.set(card.id, card);
    }
    const runUnitsNext = runUnits(columns, groupBoxOf ?? EMPTY_GROUP_BOXES);
    const prev = prevLaneByThreadRef.current;
    const prevRunUnits = prevRunUnitsRef.current;
    const prevColumns = prevColumnsRef.current;
    const prevThreads = prevThreadsRef.current;
    const prevGroupBoxOf = prevGroupBoxOfRef.current;
    prevGroupBoxOfRef.current = groupBoxOf ?? null;
    // The PREVIOUS commit's displayed order per lane (the gather walk's
    // output): the ghost slots weave against the order the lane actually
    // rendered, so a transported card's slot reads off it, not the raw
    // column order the gather can diverge from.
    const prevDisplayIds = new Map<string, readonly string[]>();
    if (prevColumns !== null) {
      for (const prevColumn of prevColumns) {
        const prevRuns = runsFromColumns([prevColumn], prevGroupBoxOf ?? EMPTY_GROUP_BOXES);
        prevDisplayIds.set(
          prevColumn.id,
          (prevRuns.get(prevColumn.id) ?? []).map((item) =>
            item.kind === "box" ? item.box.members.map((member) => member.id) : [item.thread.id],
          ).flat(),
        );
      }
    }
    prevLaneByThreadRef.current = laneByThread;
    prevRunUnitsRef.current = runUnitsNext;
    prevColumnsRef.current = columns;
    prevThreadsRef.current = threadsById;
    if (groupByChanged || prev === null) return;
    if (cardTransport === "none") {
      // Instant relocation: the planner never runs. The snapshots re-seed so
      // re-enabling the transporter starts a fresh baseline instead of
      // diffing against one collected while the planner was off.
      prevLaneByThreadRef.current = null;
      prevRunUnitsRef.current = null;
      prevColumnsRef.current = null;
      prevThreadsRef.current = new Map();
      prevGroupBoxOfRef.current = null;
      return;
    }
    const rawMoves = planLaneTransports(prev, prevThreads, columns, prevColumns ?? columns, prevDisplayIds.size === 0 ? undefined : prevDisplayIds);
    const moves = collapseRunTransports(
      rawMoves,
      prevRunUnits ?? new Map<string, RunUnit>(),
      runUnitsNext,
      prevThreads,
    );
    if (moves.length === 0 || moves.length > TRANSPORT_BATCH_CAP) return;
    // A card already mid-transport re-targets: drop its old play (and its
    // timers) and start fresh from its CURRENT lane — the old ghost's slot
    // state is stale the moment the card moves again. A unit play (a box)
    // whose member re-targets individually dies too: the unit's own play
    // was planned for the WHOLE box, and its member snapshot set is stale.
    const replacements = new Set(moves.map((move) => move.threadId));
    setTransports((current) => [
      ...current.filter(
        (play) =>
          !replacements.has(play.threadId) &&
          !(play.members?.some((member) => replacements.has(member.id)) ?? false),
      ),
      ...moves.map((move) => {
        const gen = transportGenRef.current + 1;
        transportGenRef.current = gen;
        const play: TransportPlay = {
          ...move,
          gen,
          phase: "wiping-out",
          arrival: "wiping-in",
        };
        scheduleTransportTimers(play);
        return play;
      }),
    ]);
    // The transports state update re-renders BEFORE paint; the wipes below
    // start in the same commit's effect so nothing flashes half-drawn.
  }, [columns, groupBoxOf]);

  /** Cancel one transport's phase timers (a re-target or unmounting). */
  const cancelTransportTimers = (threadId: string) => {
    for (const timer of transportTimersRef.current.get(threadId) ?? []) {
      clearTimeout(timer);
    }
    transportTimersRef.current.delete(threadId);
    // Its wipes die with the transport — an orphaned WAAPI handle on a
    // slot the state machine dropped would keep animating to nobody.
    for (const [key, animation] of transportAnimsRef.current) {
      if (key.includes(`:${threadId}@`)) {
        animation.cancel();
        transportAnimsRef.current.delete(key);
      }
    }
    // The glints die with the transport too (a re-target or removal): their
    // keys carry the same `:id@gen` stamp the wipes do.
    for (const [key, animations] of transportSparkAnimsRef.current) {
      if (key.includes(`:${threadId}@`)) {
        for (const animation of animations) animation.cancel();
        transportSparkAnimsRef.current.delete(key);
      }
    }
    // The captured pre-clip geometry goes with the transport as well.
    for (const key of transportMetricsRef.current.keys()) {
      if (key.includes(`:${threadId}@`)) transportMetricsRef.current.delete(key);
    }
  };

  const scheduleTransportTimers = (transport: TransportPlay) => {
    cancelTransportTimers(transport.threadId);
    // The variant owns the clocks: the dissolve holds the ghost slot open
    // through its wipe-out before the collapse starts; the zoom starts the
    // slot's close at clock zero, in time with the shrink.
    const plan = transportPhasePlan(effectiveTransportVariant);
    const timers: number[] = [];
    const settle = window.setTimeout(() => {
      // Wipe-in done: the arriving slot loses its hiding styles and the
      // transport decoration (an ordinary card again), and the wipe's
      // animation handle is cancelled — its final frame equals the slot's
      // resting style, so cancelling changes no pixel.
      transportAnimsRef.current
        .get(`arrival:${transport.threadId}@${transport.gen}`)
        ?.cancel();
      transportAnimsRef.current.delete(
        `arrival:${transport.threadId}@${transport.gen}`,
      );
      // The grow goes with the dissolve: its final frame IS the slot's
      // natural layout, so cancelling it changes no pixel, and the re-render
      // below drops the clip/hide styles with the attribute.
      transportAnimsRef.current
        .get(`grow:${transport.threadId}@${transport.gen}`)
        ?.cancel();
      transportAnimsRef.current.delete(
        `grow:${transport.threadId}@${transport.gen}`,
      );
      // The arrival's glints go with it: their handles cancel, and the
      // re-render below unmounts the layer with the Wiping-in attribute.
      const arrivalSparkKey = `spark:arrival:${transport.threadId}@${transport.gen}`;
      for (const animation of transportSparkAnimsRef.current.get(arrivalSparkKey) ?? []) {
        animation.cancel();
      }
      transportSparkAnimsRef.current.delete(arrivalSparkKey);
      setTransports((current) =>
        current.map((play) =>
          play.threadId === transport.threadId ? { ...play, arrival: "settled" } : play,
        ),
      );
      }, paceMs(plan.settleMs));
    const collapse = window.setTimeout(() => {
      setTransports((current) =>
        current.map((play) =>
          play.threadId === transport.threadId ? { ...play, phase: "collapsing" } : play,
        ),
      );
    }, paceMs(plan.collapseStartMs));
    const remove = window.setTimeout(() => {
      cancelTransportTimers(transport.threadId);
      setTransports((current) => current.filter((play) => play.threadId !== transport.threadId));
    }, paceMs(plan.removeMs));
    timers.push(settle, collapse, remove);
    transportTimersRef.current.set(transport.threadId, timers);
  };

  // Timer cleanup on unmount: a board swap mid-transport must not setState
  // on an unmounted component.
  useEffect(() => {
    return () => {
      for (const timer of transportTimersRef.current.values()) {
        for (const id of timer) clearTimeout(id);
      }
      transportTimersRef.current.clear();
      for (const animation of transportAnimsRef.current.values()) animation.cancel();
      transportAnimsRef.current.clear();
      for (const animations of transportSparkAnimsRef.current.values()) {
        for (const animation of animations) animation.cancel();
      }
      transportSparkAnimsRef.current.clear();
      transportMetricsRef.current.clear();
    };
  }, []);

  // Start the wipes in the commit that rendered each slot. jsdom (tests)
  // has no WAAPI; the phase timers carry the state machine there and the
  // animation start is skipped — the machine, not the visuals, is what the
  // unit environment pins.
  useLayoutEffect(() => {
    if (transports.length === 0 || prefersReducedMotion) return;
    // `fill: both` keeps the animation's frames winning over the static
    // styles through its whole window; its handle rides animationsRef so
    // the phase timers can cancel the wipe the moment its phase ends
    // (a persisted finished animation on a live card would hold compositor
    // work for the session's life).
    const startWipe = (
      key: string,
      element: HTMLElement | null | undefined,
      frames: Keyframe[],
      durationMs: number,
      easing: string = TRANSPORT_EASE,
    ) => {
      if (element === null || element === undefined) return;
      if (startedWipesRef.current.has(key)) return;
      startedWipesRef.current.add(key);
      if (typeof element.animate !== "function") return;
      transportAnimsRef.current.set(
        key,
        element.animate(frames, { duration: durationMs, easing, fill: "both" }),
      );
    };
    // The shimmer: twinkle the slot's glint field over its phase. Each
    // glint's delay + duration fit inside the phase (the planner's
    // envelope), so every sparkle has faded before the machine moves on;
    // the handles still ride sparkAnimsRef so a re-target or removal kills
    // them mid-twinkle.
    const startSparks = (key: string, host: HTMLElement | null | undefined) => {
      if (host === null || host === undefined) return;
      if (startedWipesRef.current.has(key)) return;
      startedWipesRef.current.add(key);
      if (typeof host.animate !== "function") return;
      const glints = host.querySelectorAll<HTMLElement>("[data-transport-spark]");
      const handles: Animation[] = [];
      for (let index = 0; index < glints.length; index += 1) {
        // The glint's life comes from its own DOM state — the field the
        // layer actually rendered (direction included). No recomputation,
        // so the animation can never diverge from what the eye sees.
        const spark = JSON.parse(
          glints[index]!.getAttribute("data-spark-state") ?? "null",
        ) as TransportSpark | null;
        if (spark === null) continue;
        handles.push(
          glints[index]!.animate(sparkKeyframes(spark), {
            duration: spark.durationMs,
            delay: spark.delayMs,
            easing: TRANSPORT_EASE,
            fill: "both",
          }),
        );
      }
      transportSparkAnimsRef.current.set(key, handles);
    };
    for (const transport of transports) {
      const outKey = `out:${transport.threadId}@${transport.gen}`;
      // Capture the ghost's unclipped geometry the one commit it is fully
      // laid out (wiping-out), BEFORE the collapsing phase's static
      // max-height-0 styles clamp every later measurement to zero. The
      // collapse below replays this captured shape.
      const metricKey = `metric:${transport.threadId}@${transport.gen}`;
      if (!transportMetricsRef.current.has(metricKey)) {
        const outEl = transportElsRef.current.get(outKey);
        if (outEl !== null && outEl !== undefined) {
          // The flow axis the lane renders: the ghost's slot collapses along
          // it (the width in a horizontal lane, the height in a vertical
          // one), so the measured metrics read the same axis.
          transportMetricsRef.current.set(metricKey, {
            sizePx: horizontalLanes
              ? outEl.getBoundingClientRect().width
              : outEl.getBoundingClientRect().height,
            marginStartPx: computedMarginPx(outEl, horizontalLanes ? "Left" : "Top"),
            marginEndPx: computedMarginPx(outEl, horizontalLanes ? "Right" : "Bottom"),
          });
        }
      }
      startWipe(
        outKey,
        transportElsRef.current.get(outKey),
        // The dissolve fades in place with a bloom; the zoom recedes toward
        // the portal scale, accelerating away.
        effectiveTransportVariant === "zoom" ? zoomOutKeyframes() : wipeOutKeyframes(),
        effectiveTransportVariant === "zoom" ? pacedTransportMs(TRANSPORT_ZOOM_OUT_MS, paceFactor) : pacedTransportMs(TRANSPORT_WIPE_OUT_MS, paceFactor),
        effectiveTransportVariant === "zoom" ? TRANSPORT_ZOOM_OUT_EASE : TRANSPORT_EASE,
      );
      if (effectiveTransportVariant === "dissolve") {
        startSparks(
          `spark:out:${transport.threadId}@${transport.gen}`,
          transportElsRef.current.get(outKey),
        );
      }
      const arrivalKey = `arrival:${transport.threadId}@${transport.gen}`;
      // The fade (or the zoom's scale-in) claims the card wrapper; the slot
      // li drives the grow and hosts the glint layer, so the shimmer never
      // inherits the card's fade.
      const arrivalEl = transportElsRef.current.get(arrivalKey);
      const arrivalSlotEl = transportElsRef.current.get(
        `slot:${transport.threadId}@${transport.gen}`,
      );
      startWipe(
        arrivalKey,
        arrivalEl,
        // The dissolve materializes out of the beam's bloom; the zoom grows
        // from the portal scale, landing opaque as its space opens.
        effectiveTransportVariant === "zoom" ? zoomInKeyframes() : wipeInKeyframes(),
        effectiveTransportVariant === "zoom" ? pacedTransportMs(TRANSPORT_ZOOM_IN_MS, paceFactor) : pacedTransportMs(TRANSPORT_WIPE_IN_MS, paceFactor),
        effectiveTransportVariant === "zoom" ? TRANSPORT_ZOOM_IN_EASE : TRANSPORT_EASE,
      );
      // The dissolve rides the space growing: the new slot opens from zero
      // size to its measured size on the FLOW axis (height in a vertical
      // lane, width in a horizontal one) so the lane's neighbors slide as
      // the card materializes (the scroll* read goes through the slot's
      // static max-size-0 clip). The grow is its own quick clock — it opens
      // well before the dissolve-in ends, so the shimmer plays over an open
      // space instead of trailing it. Skipped with no measurable size
      // (jsdom, or a slot the layout has not sized yet).
      const arrivalSlotSize =
        arrivalSlotEl === null || arrivalSlotEl === undefined
          ? 0
          : horizontalLanes
            ? arrivalSlotEl.scrollWidth
            : arrivalSlotEl.scrollHeight;
      if (
        arrivalSlotEl !== null &&
        arrivalSlotEl !== undefined &&
        typeof arrivalSlotEl.animate === "function" &&
        arrivalSlotSize > 0
      ) {
        startWipe(
          `grow:${transport.threadId}@${transport.gen}`,
          arrivalSlotEl,
          arrivalGrowKeyframes(arrivalSlotSize, flowAxis),
          // The dissolve's space opens early under its materialize; the
          // zoom's space expands on the SAME clock as the card's growth, so
          // the space and the card land together.
          effectiveTransportVariant === "zoom" ? pacedTransportMs(TRANSPORT_ZOOM_IN_MS, paceFactor) : pacedTransportMs(TRANSPORT_GROW_MS, paceFactor),
          effectiveTransportVariant === "zoom" ? TRANSPORT_ZOOM_IN_EASE : TRANSPORT_GROW_EASE,
        );
      }
      if (effectiveTransportVariant === "dissolve") {
        startSparks(
          `spark:arrival:${transport.threadId}@${transport.gen}`,
          arrivalSlotEl,
        );
      }
      if (
        transport.phase === "collapsing" ||
        // The zoom's slot close is concurrent with the shrink: the collapse
        // starts in this same commit (clock zero in the phase plan), so the
        // old slot's space never waits for the recede to finish. The
        // started-wipes guard keeps the flip to "collapsing" from restarting
        // it; the static end state is only the no-WAAPI fallback there.
        (effectiveTransportVariant === "zoom" && transport.phase === "wiping-out")
      ) {
        const collapseKey = `collapse:${transport.threadId}@${transport.gen}`;
        const ghost = transportElsRef.current.get(outKey);
        if (ghost !== null && ghost !== undefined) {
          // Shape and margins come from the wipe-start capture (the ghost's
          // LAST unclipped commit): replays here measure a static
          // max-height-0 ghost — height 0 — which would make the close an
          // instant jump. The captured margins are the live pre-collapse
          // ones (a box container's own 6px top margin included), so the
          // close eats them smoothly down to the gap-borrowed end frame.
          const metrics = transportMetricsRef.current.get(metricKey);
          startWipe(
            collapseKey,
            ghost,
            ghostCollapseKeyframes(
              metrics !== undefined
                ? metrics.sizePx
                : horizontalLanes
                  ? ghost.scrollWidth
                  : ghost.scrollHeight,
              cardRowGapPx(ghost.parentElement, flowAxis),
              metrics !== undefined
                ? metrics.marginStartPx
                : computedMarginPx(ghost, horizontalLanes ? "Left" : "Top"),
              metrics !== undefined
                ? metrics.marginEndPx
                : computedMarginPx(ghost, horizontalLanes ? "Right" : "Bottom"),
              flowAxis,
            ),
            // The zoom's slot close rides the shrink's clock and ease (the
            // space recedes with the card); the dissolve keeps its own
            // quicker close after the wipe.
            effectiveTransportVariant === "zoom" ? pacedTransportMs(TRANSPORT_ZOOM_OUT_MS, paceFactor) : pacedTransportMs(TRANSPORT_COLLAPSE_MS, paceFactor),
            effectiveTransportVariant === "zoom" ? TRANSPORT_ZOOM_OUT_EASE : TRANSPORT_EASE,
          );
        }
      }
    }
  }, [transports, prefersReducedMotion, effectiveTransportVariant]);

  const sweepActive = sweepCandidatesFor !== undefined && onSweepArm !== undefined;
  // Clicking empty board area (anything that is not a card, control, or link)
  // while a thread is open closes the pane. The same surface clears the amber
  // group highlight — any click outside a group frame does — so the
  // highlight never needs its own Escape or dismiss control.
  const handleBackgroundClick = (event: MouseEvent) => {
    const target = event.target;
    if (onHighlightGroup !== undefined && target instanceof Element) {
      // A click inside a group frame already ran the frame's own handler
      // (set or toggle); anything else — a plain card, a control, the
      // empty board — clears.
      if (target.closest("[data-group-box]") === null) onHighlightGroup(null);
    }
    if (activeThreadId === null || onClosePane === undefined) return;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-thread-card], button, a, input, textarea, select, [role='menu'], [role='menuitem']") !== null) return;
    onClosePane();
  };
  const ranking = rankStore !== undefined && onRankMove !== undefined;
  // Which boxed threads drag as a multi-member run: the thread's LANE SLICE
  // (its group's run in the column rendering it) holds ≥ 2 members. The
  // join decision reads this — a lone slice member (its group's only member
  // in the lane) drags plain and may join another group, while a gathered
  // run (members gathered into the lane's one frame) moves as a unit and
  // never dissolves into a group. Same walk as the render: roles read the
  // DISPLAYED order (flattenRuns), not the raw column order, so a box
  // gathered through an interposed card reports its roles honestly.
  const boxedUnitIds = useMemo(() => {
    const ids = new Set<string>();
    if (groupBoxOf === undefined) return ids;
    for (const column of columns) {
      const runs =
        runsFromColumns([column], groupBoxOf).get(column.id) ?? [];
      for (const [threadId, info] of columnRunInfo(flattenRuns(runs), groupBoxOf)) {
        if (info.role !== "solo") ids.add(threadId);
      }
    }
    return ids;
  }, [columns, groupBoxOf]);

  // Announce a completed move so a reorder is legible without sight of the
  // insertion line, which is the only feedback a screen reader would miss.
  const [announcement, setAnnouncement] = useState("");
  // A reorder that cannot complete says so ON SCREEN. A live region alone
  // leaves the sighted operator with a drag that silently does nothing, which
  // is exactly how the last version of this shipped.
  const [rankError, setRankError] = useState<string | null>(null);

  // The hide-a-lane gesture's report (Project view): a lane the Project
  // filter wrote out says so on the board — a silent write reads the way
  // every other silent action here reads, as being ignored. Refusals
  // report too (the sole-lane corner, or a lane the filter already shows
  // without). One lane armed at a time: the first click arms Hide, the
  // second confirms.
  const [hideLaneReport, setHideLaneReport] = useState<{ message: string } | null>(null);
  // The nest's receipt for a write the placement rules cannot show: a
  // pinned child (or an attention one, or a cross-space child) keeps its own
  // card in its own slot after nesting, so the board says what landed and
  // names the way back — the write must never read as the board eating the
  // gesture (reported 2026-10-15/16: re-parents and refusals both looked
  // like silent no-ops).
  const [nestNotice, setNestNotice] = useState<{ message: string } | null>(null);
  const [hideArmColumn, setHideArmColumn] = useState<string | null>(null);
  // Bumped on every refusal so the auto-dismiss timer restarts even when the
  // new message is identical to the old one — React would otherwise bail out
  // on the same string and let the stale clock cut the repeat refusal short.
  const [rankErrorSeq, setRankErrorSeq] = useState(0);

  // A refusal leaves the screen on its own after a while: the operator has
  // read it (or dismissed it), and a banner that outlives its drag reads as
  // a board that is still broken. Generous, because "fail loud" loses to
  // "vanish before it was read". The dismiss button clears the same state.
  useEffect(() => {
    if (rankError === null) return;
    const timer = setTimeout(() => setRankError(null), RANK_ERROR_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [rankError, rankErrorSeq]);

  // A sweep that partially failed says so on screen, the same way a refused
  // reorder does: the failed candidates stay highlighted (re-armed), but the
  // highlight alone does not say why the sweep stopped short.
  useEffect(() => {
    if (sweepNotice === null) return;
    const timer = setTimeout(
      () => onDismissSweepNotice?.(),
      RANK_ERROR_AUTO_DISMISS_MS,
    );
    return () => clearTimeout(timer);
  }, [sweepNotice, onDismissSweepNotice]);

  // The browser reveal's report expires the same way: a dead notice that
  // squats on the board would be the same "ignoring the operator" look.
  useEffect(() => {
    if (browserNotice === null || browserNotice === undefined) return;
    const timer = setTimeout(
      () => onDismissBrowserNotice?.(),
      RANK_ERROR_AUTO_DISMISS_MS,
    );
    return () => clearTimeout(timer);
  }, [browserNotice, onDismissBrowserNotice]);

  // The lane-hide's report expires the same way: a dead banner would squat
  // on the board pretending to matter.
  useEffect(() => {
    if (hideLaneReport === null) return;
    const timer = setTimeout(() => setHideLaneReport(null), RANK_ERROR_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [hideLaneReport]);

  // The nest's receipt expires the same way: a dead banner would squat on
  // the board pretending to matter.
  useEffect(() => {
    if (nestNotice === null) return;
    const timer = setTimeout(() => setNestNotice(null), RANK_ERROR_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [nestNotice]);

  // While a lane's hide is armed, the arm must not outlive its context:
  // Escape, or a pointer press outside the armed button, disarms. The
  // honest listeners are document-level — a clicked button only holds
  // focus in some browsers (Chromium; Safari leaves it unfocused), so the
  // armed button's own onKeyDown can never promise an Escape disarm. The
  // armed button itself is exempt from the press disarm (that press is
  // the confirm's pointer half); every other surface — cards, other
  // lanes' icons, the toolbar — drops the arm before its own handling.
  useEffect(() => {
    if (hideArmColumn === null) return;
    const disarm = (): void => setHideArmColumn(null);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") disarm();
    };
    const onPointerDown = (event: PointerEvent): void => {
      const armed = document.querySelector("[data-hide-lane-armed]");
      if (armed !== null && event.target instanceof Node && armed.contains(event.target)) return;
      disarm();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [hideArmColumn]);

  // A sweep-mode click on a thread that may not join a sweep (live-child
  // parent) refuses on screen: a click that silently does nothing reads as
  // a board ignoring the operator, the exact failure this board shipped
  // twice in the drag path.
  const [sweepRefusal, setSweepRefusal] = useState<string | null>(null);
  // The box-label rename editor: one box re-labels at a time; the input is
  // uncontrolled (defaultValue seeds the current name) so Enter/Escape/blur
  // read the settled text straight off the field. The editor also hosts the
  // box's delete: first click arms, second deletes (the picker's confirmed
  // delete pattern, miniaturized).
  const [renamingBoxId, setRenamingBoxId] = useState<string | null>(null);
  const [labelDeleteArmed, setLabelDeleteArmed] = useState(false);
  // The group box's own right-click menu: where the pointer landed and
  // which box it names; the ungroup entry arms in place (the label
  // editor's two-click pattern, carried into the menu).
  const [groupMenu, setGroupMenu] = useState<{
    groupId: string;
    name: string;
    x: number;
    y: number;
  } | null>(null);
  const [groupMenuUngroupArmed, setGroupMenuUngroupArmed] = useState(false);
  const closeGroupMenu = () => {
    setGroupMenu(null);
    setGroupMenuUngroupArmed(false);
  };
  /** The group box whose own surface (not a member card) a drag hovers: the drop-to-join promise. */
  const [joinHoverId, setJoinHoverId] = useState<string | null>(null);
  const renameCommittedRef = useRef(false);
  const startLabelRename = (groupId: string) => {
    renameCommittedRef.current = false;
    setLabelDeleteArmed(false);
    setRenamingBoxId(groupId);
  };
  /** Fold the editor back to the label — no commit, no armed delete. */
  const closeLabelEditor = () => {
    renameCommittedRef.current = true;
    setLabelDeleteArmed(false);
    setRenamingBoxId(null);
  };
  /** Enter: commit only a valid NEW name; a blank keeps the editor open (fix-up possible, nothing lost). */
  const commitLabelRename = (groupId: string, raw: string, previousName: string) => {
    if (renameCommittedRef.current) return;
    const name = raw.trim();
    if (name === "" || name.length > 80 || name === previousName) return;
    renameCommittedRef.current = true;
    setLabelDeleteArmed(false);
    setRenamingBoxId(null);
    onRenameGroup?.(groupId, name);
  };
  /** Blur: the editor leaves focus — commit the valid name, otherwise fold back to the label. */
  const blurLabelRename = (groupId: string, raw: string, previousName: string) => {
    if (renameCommittedRef.current) return;
    const name = raw.trim();
    if (name !== "" && name.length <= 80 && name !== previousName) {
      renameCommittedRef.current = true;
      setLabelDeleteArmed(false);
      setRenamingBoxId(null);
      onRenameGroup?.(groupId, name);
      return;
    }
    closeLabelEditor();
  };
  useEffect(() => {
    if (sweepRefusal === null) return;
    const timer = setTimeout(() => setSweepRefusal(null), RANK_ERROR_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [sweepRefusal]);

  // The card being dragged, captured at dragstart. Held here rather than read
  // from the payload because the payload is unreadable until the drop, and
  // dragover needs to know this to avoid drawing an insertion line on the
  // card under the cursor.
  const draggingIdRef = useRef<string | null>(null);

  // ── The dot-drag lifecycle (issue #249, goals 3 and 4) ─────────────────
  // The collapsed strip's dot being dragged. A dot drag is deliberately NOT
  // a card drag: it never enters `draggingIdRef`, because every floor,
  // header, and card drop path reads that ref, and a dot drag must be inert
  // on all of them — a member's drag-out is the explicit morph gesture of a
  // later cut, never a release side effect. Only the home strip's own
  // dot handlers read this ref.
  const dotDraggingRef = useRef<string | null>(null);
  // Whether the in-flight dot gesture resolved (a family write, a named
  // refusal, or a claimed out-of-strip refusal). Dragend reports the
  // strip-honesty refusal only for a gesture that never resolved anywhere,
  // so one release raises exactly one banner, never two.
  const dotDragResolvedRef = useRef(true);
  // The home strip's box, captured at dragstart. The morph's boundary
  // (issue #249, goal 5) is geometric: the dragged dot's reported pointer
  // coordinates leaving this box is the escape.
  const dotStripRectRef = useRef<{
    left: number;
    right: number;
    top: number;
    bottom: number;
  } | null>(null);
  // The one-way escape flag, set exactly once per gesture at the boundary
  // handoff and cleared at the next dragstart and at dragend. While true,
  // the gesture's tail is an ordinary card drag: every code path outside
  // the strip treats it through draggingIdRef, every dot rule is closed.
  const dotEscapedRef = useRef(false);
  // The escaped member, painted by its home card's morph ring through
  // ThreadCard's `childDotDrag.escaped` wire.
  const [dotDragEscapedMember, setDotDragEscapedMember] = useState<string | null>(null);

  function clearRankDrop(): void {
    setRankDrop(null);
  }

  /**
   * The lane-level drop affordances: the white "drop lands here" ring on a
   * column (`dragOverColumn`) and the amber family rings on the floor and
   * header (`familyFloorColumn`, `familyHeaderColumn`). A drag ends in more
   * ways than the dropped column's `onDrop` runs — Escape, a drop a card
   * claims before the column sees it, a source element the drop's relocation
   * unmounts before its dragend fires — so the cleanup lives here, callable
   * from the dragend lifecycle AND the drop paths that claim their event.
   */
  function releaseDropAffordances(): void {
    setDragOverColumn(null);
    setFamilyFloorColumn(null);
    setFamilyHeaderColumn(null);
  }

  /**
   * The shared rank-drag lifecycle, moved out of the card's `onRankDragStart`
   * so the group-box labels start (and end) the same drag state: the dragged
   * card id, the column headers' in-flight growth, and the promise cleanup a
   * drag that ends anywhere but a successful drop owes the board.
   */
  const rankDragLifecycle = (id: string | null): void => {
    draggingIdRef.current = id;
    // Any drag in flight is the board's signal to grow the column headers (they
    // are detach targets the whole time a family drag lives).
    setDragInFlight(id !== null);
    // A drag that ends anywhere but a successful drop (Escape, a refused
    // target) must not leave its insertion line — or its join-hover promise —
    // on screen.
    if (id === null) {
      clearRankDrop();
      setJoinHoverId(null);
      clearChildDrop();
      setStripNestHover(null);
      releaseDropAffordances();
    }
  };

  // ── The drag-out-of-DOM safety ──────────────────────────────────────────
  // A drag whose source element stops existing mid-flight owns no event to
  // clean up after itself: a card that relocates while it is dragged (a live
  // update reassembled the board out from under the gesture) unmounts the
  // element the browser was tracking, and no dragend or drop can ever fire.
  // Its drag state would idle forever — the grown headers, the last lane's
  // white drop ring. Every commit checks: a drag still marked in flight with
  // no draggable card for its id on the board is a dead drag — end the
  // lifecycle exactly as dragend would have.
  useLayoutEffect(() => {
    const id = draggingIdRef.current;
    if (id === null) return;
    // An attribute selector value is a string literal: escape the two
    // characters that would break out of it (thread ids never carry them,
    // but the guard is for the selector's sake, not the id's format).
    const safe = id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    // A top-level card wraps its draggable anchor; a nested row carries
    // data-thread-card on the anchor itself. Either form proves the drag's
    // source still on the board.
    const alive =
      document.querySelector(`[data-thread-card="${safe}"] a[draggable]`) ??
      document.querySelector(`a[data-thread-card="${safe}"]`);
    if (alive !== null) return;
    rankDragLifecycle(null);
  });

  // The dot drag in flight with no live source has the same safety: a live
  // refetch can reassemble the strip out from under a dragged dot, and then
  // no dragend or drop ever fires — its tooltip pin and line would idle
  // forever. A dot still marked in flight with no matching dot button on the
  // board is a dead drag: end it exactly as dragend would have (quietly —
  // the gesture never resolved, and an unmounted source is chaos, not an
  // operator release).
  useLayoutEffect(() => {
    const id = dotDraggingRef.current;
    if (id === null) return;
    const safe = id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const alive = document.querySelector(`button[data-child-dot="${safe}"]`);
    if (alive !== null) return;
    dotDraggingRef.current = null;
    dotDragResolvedRef.current = true;
    setChildDotLine(null);
  });

  /**
   * The dot-drag lifecycle, mirroring `rankDragLifecycle`'s shape: the
   * dragged member id and the resolution flag reset at start, and dragend
   * clears the promise — reporting the strip-honesty refusal only when the
   * gesture never resolved somewhere else (a release that lands anywhere but
   * the home strip refuses loudly and writes nothing, #231's law made
   * honest by naming where the dot has to land).
   */
  const childDotDragStart = (memberId: string, event: React.DragEvent): void => {
    dotDraggingRef.current = memberId;
    dotDragResolvedRef.current = false;
    dotEscapedRef.current = false;
    // The strip's box, stamped from the source dot's own chain: the escape
    // reads this box, so the dragover stream needs no re-lookups.
    const strip = (event.currentTarget as Element).closest("[data-child-thread-dots]");
    const rect = strip?.getBoundingClientRect();
    dotStripRectRef.current =
      rect === undefined || rect === null
        ? null
        : { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  };

  /**
   * The morph's boundary (issue #249, goal 5) — the board root watches every
   * dragover a dot-marked drag raises. Coordinates inside the home strip's
   * box (or missing — jsdom) keep the gesture a dot gesture; coordinates
   * outside it hand the whole gesture to the card lifecycle at that
   * instant: `draggingIdRef` adopts the member (so every floor, header, and
   * card path downstream decides exactly as they do for card drags), the
   * dot refs clear, and the home card lights its morph ring. One-way: a dot
   * never re-becomes a dot mid-gesture, and its dragend unwinds the card
   * lifecycle exactly once.
   */
  const dotDragEscapeObserver = (event: React.DragEvent): void => {
    if (!isDotDrag(event.dataTransfer.types)) return;
    if (dotDraggingRef.current === null || dotEscapedRef.current) return;
    const box = dotStripRectRef.current;
    const x = event.clientX;
    const y = event.clientY;
    // Missing coordinates are UNKNOWN, never outside: a simulated event
    // without clientX/clientY (every jsdom dragover) keeps the gesture a
    // dot gesture rather than escaping it.
    if (box === null || typeof x !== "number" || typeof y !== "number") return;
    if (Number.isNaN(x) || Number.isNaN(y)) return;
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return;
    const member = dotDraggingRef.current;
    dotDraggingRef.current = null;
    dotStripRectRef.current = null;
    dotEscapedRef.current = true;
    dotDragResolvedRef.current = true;
    setDotDragEscapedMember(member);
    rankDragLifecycle(member);
  };

  const childDotDragEnd = (): void => {
    if (dotEscapedRef.current) {
      // The escaped gesture's tail was a card drag; its source dot's
      // dragend unwinds the card lifecycle (the promise cleanup and the
      // grown headers), never the dot dragend refusal — the escape already
      // resolved the dot gesture.
      dotEscapedRef.current = false;
      dotStripRectRef.current = null;
      setDotDragEscapedMember(null);
      rankDragLifecycle(null);
      return;
    }
    const draggedId = dotDraggingRef.current;
    const resolved = dotDragResolvedRef.current;
    dotDraggingRef.current = null;
    dotDragResolvedRef.current = true;
    dotStripRectRef.current = null;
    setChildDotLine(null);
    if (draggedId === null || draggedId === "" || resolved) return;
    reportRefusal("the dot release never landed on its family's strip, so nothing moved.");
  };

  /**
   * Report a reorder that cannot complete, naming the reason.
   *
   * A drop that quietly does nothing is indistinguishable from a board
   * ignoring the operator, which is precisely how this shipped twice: once
   * because dragover read a protected payload, and once because the drop could
   * not identify the card. Every early return names itself so one reproduction
   * says which one fired.
   */
  function reportRefusal(reason: string): void {
    setAnnouncement(`Reorder refused: ${reason}`);
    setRankError(`Reorder refused: ${reason}`);
    setRankErrorSeq((seq) => seq + 1);
  }

  function commitMove(
    column: BoardColumn,
    threadId: string,
    beforeId: string | null,
    toEnd: boolean,
    visibleIds: readonly string[],
    unitIds?: readonly string[],
  ): void {
    if (!ranking) {
      reportRefusal("card ordering is not available on this board.");
      return;
    }
    // Fail loud, on screen. An empty id means the drop could not identify the
    // dragged card; the move would otherwise be a silent no-op that looks
    // exactly like the board ignoring the operator.
    if (threadId === "") {
      reportRefusal(`could not identify the dragged card in ${column.label}.`);
      return;
    }
    setRankError(null);
    // The RPC's signature stays card-shaped when there is no unit: old
    // callers and tests must not hear an argument that was never there.
    if (unitIds === undefined) {
      onRankMove?.(columnRankKey(groupBy, column.id), threadId, beforeId, toEnd, visibleIds);
    } else {
      onRankMove?.(
        columnRankKey(groupBy, column.id),
        threadId,
        beforeId,
        toEnd,
        visibleIds,
        unitIds,
      );
    }
    // Report the resulting position from the order the move produces, not
    // from the anchor's old index: dropping onto a card's top half lands one
    // above where that card was, and the message must match the new board.
    // The DISPLAYED order, not the sparse stored one — a card that keeps its
    // rank below the drop point is still a card on the board. A unit move
    // reads the unit's arrangement (the box lands contiguous).
    const after = unitIds
      ? displayAfterUnitMove(visibleIds, unitIds, beforeId, toEnd)
      : displayAfterMove(visibleIds, threadId, beforeId, toEnd);
    setAnnouncement(
      `Moved to position ${after.indexOf(threadId) + 1} of ${after.length} in ${column.label}.`,
      );
  }

  /**
   * Id → thread for the nest-zone visibility guard. The dragged card or the
   * hovered target may be a column card or a nested/done row; every set
   * feeds one lookup.
   */
  const nestThreadById = useMemo(() => {
    const map = new Map<string, PluginSidebarThread>();
    for (const column of columns) {
      for (const card of column.threads) map.set(card.id, card);
    }
    for (const rows of [nestedChildrenByParent, doneChildrenByParent]) {
      for (const rowList of rows.values()) {
        for (const row of rowList) if (!map.has(row.id)) map.set(row.id, row);
      }
    }
    return map;
  }, [columns, nestedChildrenByParent, doneChildrenByParent]);

  /**
   * Where does a hover or drop over this card land? The before/after halves
   * are the insertion edges the board always had; the middle third nests the
   * dragged card UNDER this card — offered only when a re-parent write is
   * wired and the guard permits this pair (never onto itself, never closing
   * a family loop — the loop and already-child refusals fall back to the
   * edge split instead of advertising a drop that would refuse). The thirds
   * measure the whole slot on purpose: a family card's nested rows are part
   * of its surface, so the nest zone (the ring) stays reachable on a tall
   * expanded card, and the slot's lower third still reads "below this card".
   *
   * When a legal nest's placement result would render invisibly (the
   * placement rules keep the child's card standing alone — a pinned child,
   * an attention child, a live child of a Done root, a cross-space child;
   * `flatNestReason` answers), the drop still nests but the success path
   * says so in a visible notice (`nestNotice`), not just the sr-only live
   * region — an invisible write reads as the board eating the gesture
   * (reported 2026-10-15/16).
   *
   * `childId` is the dragged card: the live ref mid-drag (the payload is
   * write-only until the drop), the payload at drop time.
   */
  function dropZoneFor(
    event: React.DragEvent,
    childId: string | null,
    targetId: string,
    /**
     * Rects read off currentTarget by default; the group-box handlers pass
     * the hovered member's element instead so the zone math runs against
     * the card the pointer is actually over.
     */
    element?: Element,
  ): DropZone {
    const rect = (element ?? event.currentTarget).getBoundingClientRect();
    // The thirds split on the lane flow's axis: top/bottom in a vertical
    // lane, left/right in a horizontal one (the point's other coordinate is
    // ignored — a horizontal lane's drop never splits on its y).
    const zone = dropZoneForPoint(
      flowAxis,
      rect,
      event.clientX,
      event.clientY,
      true,
    );
    if (
      onReparent === undefined ||
      childId === null ||
      childId === "" ||
      childId === targetId ||
      reparentRefusalFromParents(rawParentOf ?? EMPTY_PARENT_OF, childId, targetId) !== null
    ) {
      // A refused nest edge falls back to the plain insertion halves: the
      // middle third never advertises a drop the guard would refuse.
      return zone === "onto"
        ? dropZoneForPoint(flowAxis, rect, event.clientX, event.clientY, false)
        : zone;
    }
    return zone;
  }

  /**
   * The edge-zone join deferral, shared by a box member's dragover and drop:
   * a drag landing on a member card's surface defers to the enclosing box's
   * drop-to-join when the dragged thread can join that member's group and
   * the member's own gesture is not claimed first. Scope, on purpose:
   * lane drags only — a cross-lane drag keeps the member card's own
   * state-change-at-an-edge gesture; the middle third stays the nest zone
   * (nesting under a boxed card has no other surface); the same-group case
   * refuses via canJoinGroup and keeps the insertion line and reorder.
   * Without this, a tall member (a parent family's card, its child rows
   * included) covers nearly the whole dashed outline and none of "drop a
   * card on this box to join" is reachable on it (observed 2026-10-10).
   */
  function memberEdgeDefersToJoin(
    droppedId: string,
    memberBoxId: string | undefined,
    zone: DropZone,
    lane: boolean,
  ): boolean {
    return (
      onJoinGroup !== undefined &&
      memberBoxId !== undefined &&
      lane &&
      zone !== "onto" &&
      droppedId !== "" &&
      canJoinGroup(
        droppedId,
        memberBoxId,
        groupBoxOf ?? EMPTY_GROUP_BOXES,
        boxedUnitIds.has(droppedId),
      )
    );
  }

  /**
   * The nest drop: hand the pair to the caller's write. The guard ran twice
   * already (at dragover, and again in the RPC handler against its own fresh
   * rows); a rejected write still reports on screen — the board must not
   * silently eat a gesture, the same failure mode the drag path shipped
   * twice before this.
   */
  function commitNest(childId: string, target: PluginSidebarThread, afterWrite?: () => void): void {
    const write = onReparent;
    if (write === undefined) return;
    void write(childId, target.id).then(
      () => {
        // Side effects the caller wants only after the parentage truly
        // landed (the strip-nest's land-last rank append, issue #249
        // goal 6): a range move whose placement the write itself decides.
        if (afterWrite !== undefined) afterWrite();
        const child = nestThreadById.get(childId);
        const reason =
          child === undefined
            ? null
            : flatNestReason(child, target, groupBy, doneIds, errorAckIds);
        setAnnouncement(
          `Nested as a child of "${target.displayTitle}".` +
            (reason === null
              ? ""
              : ` Its card keeps its own slot (${reason}); Make Top-Level in its card menu undoes this.`),
        );
        if (reason !== null) {
          setNestNotice({
            message: `Nested as a child of "${target.displayTitle}"; the card's own placement does not change (${reason}). Undo: "Make Top-Level" in the card menu.`,
          });
        }
      },
      (error: unknown) =>
        reportRefusal(
          error instanceof Error ? error.message : "the re-parent write failed.",
        ),
    );
  }

  /**
   * The detach drop: releasing a nested child on a column floor un-nests it.
   * The inverse gesture exists by construction — dragging the card back onto
   * its former parent re-nests — and the announcement says so, because an
   * undo nobody can find is not an undo.
   */
  function commitUnnest(childId: string): void {
    const write = onReparent;
    if (write === undefined) return;
    void write(childId, null).then(
      () =>
        setAnnouncement(
          "Top-level again — it is no longer nested as a child. Drag it onto a card to nest it back.",
        ),
      (error: unknown) =>
        reportRefusal(
          error instanceof Error ? error.message : "the re-parent write failed.",
        ),
    );
  }

  /** The live parent of `threadId`, or null for a top-level card. */
  const liveParentOf = (threadId: string): string | null =>
    rawParentOf?.get(threadId) ?? null;

  // Every thread by id, for the strip-nest hover's bubble membership: the
  // dragged card may live in any lane or nest under any family.
  const threadById = new Map<string, PluginSidebarThread>();
  for (const lane of columns) {
    for (const candidate of lane.threads) threadById.set(candidate.id, candidate);
  }
  for (const list of nestedChildrenByParent.values()) {
    for (const candidate of list) {
      if (!threadById.has(candidate.id)) threadById.set(candidate.id, candidate);
    }
  }

  /** The strip-nest target's refusal, or null when the childing is legal:
   * self, the reparent guard's edges (cycle, tier cap, invalid parent), and
   * the already-member no-op each name themselves — the same ledger #231's
   * refusal law runs on, off the strip now too. */
  const stripNestRefusalFor = (
    parent: PluginSidebarThread,
    draggedId: string,
  ): string | null => {
    if (draggedId === parent.id) return "a card cannot nest under itself.";
    const guard = reparentRefusalFromParents(rawParentOf ?? EMPTY_PARENT_OF, draggedId, parent.id);
    if (guard !== null) return `${guard}`;
    if (liveParentOf(draggedId) === parent.id) {
      return `already a member of ${parent.displayTitle}; nothing to add.`;
    }
    return null;
  };

  /**
   * The dot field as a nest target (issue #249, goal 6): the strip claims
   * the card dragover — stopPropagation keeps the card's own edge and nest
   * promises off the dots — and reports the hover for the collapse visual.
   * Dot-marked drags keep their home rules: they never read as a nest
   * target here.
   */
  const stripNestOver = (parent: PluginSidebarThread, event: React.DragEvent): void => {
    if (isDotDrag(event.dataTransfer.types)) return;
    if (onReparent === undefined) return;
    const draggedId = draggingIdRef.current;
    if (draggedId === null || draggedId === "") return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    if (stripNestRefusalFor(parent, draggedId) !== null) {
      // Claimed but confessed: the drop refuses loudly; no affordance
      // promises it first.
      setStripNestHover(null);
      return;
    }
    const member = threadById.get(draggedId);
    if (member === undefined) {
      setStripNestHover(null);
      return;
    }
    setStripNestHover((current) =>
      current !== null &&
      current.familyId === parent.id &&
      current.member.id === draggedId
        ? current
        : { familyId: parent.id, member, x: event.clientX, y: event.clientY },
    );
  };

  /** The strip-nest drop: the write is the existing nest path, guard and
   * receipt included, and the affordance clears with the gesture. */
  const stripNestDrop = (parent: PluginSidebarThread, event: React.DragEvent): void => {
    if (isDotDrag(event.dataTransfer.types)) return;
    if (onReparent === undefined) return;
    const droppedId = draggedIdFor(event, draggingIdRef.current);
    event.preventDefault();
    event.stopPropagation();
    setStripNestHover(null);
    if (droppedId === "") {
      reportRefusal("the drop could not identify the dragged card.");
      return;
    }
    // The payload can name a card the board does not hold (a stale or ghost
    // id): the nest write would fabricate a member out of nothing.
    if (!threadById.has(droppedId)) {
      reportRefusal("the dragged card is not on the board.");
      return;
    }
    // The payload can name a card the hover's ref never saw: guards re-run.
    const refusal = stripNestRefusalFor(parent, droppedId);
    if (refusal !== null) {
      reportRefusal(refusal);
      return;
    }
    clearRankDrop();
    releaseDropAffordances();
    setRankError(null);
    // The plan's land-last rule: the newly childed member reads as APPENDED
    // to its tier (tooltip plus dot at the strip's end), placement then
    // coming from a second dot drag — the two gestures stay orthogonal.
    // The append rides the write's own resolution, and it uses the same
    // child-rank key and onRankMove every dot reorder writes.
    commitNest(droppedId, parent, () => {
      const memberIds = [
        ...(nestedChildrenByParent.get(parent.id)?.map((row) => row.id) ?? []).filter(
          (id) => id !== droppedId,
        ),
        droppedId,
      ];
      onRankMove?.(childRankKey(parent.id), droppedId, null, true, memberIds);
    });
  };

  const stripNestLeave = (): void => {
    setStripNestHover(null);
  };
  // Done, Unread, and Pinned lanes accept state-change drops; Unread exists
  // as a column only in the Attention grouping, and Pinned only once a card
  // is in it. Pinned without a handler stays a plain no-drop lane: dropping
  // anywhere else then reads as the browser's no-drop cursor, not as the
  // board eating the gesture silently.
  const dropHandlerFor = (columnId: string): ((threadId: string) => void) | null => {
    if (columnId === "done") return onDropDone;
    if (columnId === "unread") return onDropUnread;
    if (columnId === "pinned") return onDropPinned ?? null;
    return null;
  };
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      // The morph's boundary watcher (issue #249, goal 5): the ROOT is the
      // one surface every non-claiming dragover bubbles to, so an escaped
      // dot's coordinates are always seen here. The strip's own claimed
      // dragovers stop below, the strip's unclaimed background bubbling
      // reads in-strip by coordinates, and once the handoff ran this
      // watcher ignores the remainder of the card-typed gesture.
      onDragOver={dotDragEscapeObserver}
    >
      {/* The banner row lives above the horizontal scroll surface: a banner
          inside the overflow-x-auto container rides the same scrollable
          coordinate space as the columns, so once the column row overflows
          and the operator scrolls, the banner — its message and dismiss
          control included — is carried off the viewport's left edge (observed
          2026-10-10). */}
      <div data-banner-row className="shrink-0">
        {/* Every banner here paints a full-strength surface, never a
            translucent tint: the banner row sits over the board's wallpaper
            when one is active, and a 10%-alpha tint under the banner's text
            turns the message illegible on a photographic wallpaper (issue
            #233) — the same lesson the context menu's popover learned (the
            menu moved to a full-strength surface, PR #221). Text carries its
            contrast; the tinted border keeps the surface's tone. */}
        {rankError !== null ? (
          <div
            role="status"
            data-testid="rank-error-banner"
            className="mx-3 mb-1 flex items-center justify-between gap-2 rounded border border-destructive/40 bg-red-50 dark:bg-red-950 px-2 py-1 text-[11px] text-destructive dark:text-red-400"
          >
            <p className="min-w-0">{rankError}</p>
            <button
              type="button"
              onClick={() => setRankError(null)}
              aria-label="Dismiss error"
              title="Dismiss"
              className="shrink-0 rounded p-0.5 text-destructive/70 dark:text-red-400/70 transition-colors hover:bg-destructive/10 hover:text-destructive dark:hover:text-red-400 focus-visible:outline focus-visible:outline-1 focus-visible:outline-destructive"
            >
              <Icon name="X" className="size-3" aria-hidden />
            </button>
          </div>
        ) : null}
        {rankSaveError !== null ? (
          <div
            role="status"
            data-testid="rank-save-error"
            className="mx-3 mb-1 flex items-center justify-between gap-2 rounded border border-destructive/40 bg-red-50 dark:bg-red-950 px-2 py-1 text-[11px] text-destructive dark:text-red-400"
          >
            {/* A write the host rejected: the board keeps the stored order —
                this banner is the only word about it. */}
            <p className="min-w-0">The reorder didn't save: {rankSaveError}</p>
            <button
              type="button"
              onClick={() => onDismissRankSaveError?.()}
              aria-label="Dismiss save error"
              title="Dismiss"
              className="shrink-0 rounded p-0.5 text-destructive/70 dark:text-red-400/70 transition-colors hover:bg-destructive/10 hover:text-destructive dark:hover:text-red-400 focus-visible:outline focus-visible:outline-1 focus-visible:outline-destructive"
            >
              <Icon name="X" className="size-3" aria-hidden />
            </button>
          </div>
        ) : null}
        {familyStateSaveError !== null ? (
          <div
            role="status"
            data-testid="family-state-save-error"
            className="mx-3 mb-1 flex items-center justify-between gap-2 rounded border border-destructive/40 bg-red-50 dark:bg-red-950 px-2 py-1 text-[11px] text-destructive dark:text-red-400"
          >
            {/* A fold/idle write the host rejected: the toggle rolled back to
                the server's truth — this banner is the only word about it. */}
            <p className="min-w-0">The fold didn't save: {familyStateSaveError}</p>
            <button
              type="button"
              onClick={() => onDismissFamilyStateSaveError?.()}
              aria-label="Dismiss fold save error"
              title="Dismiss"
              className="shrink-0 rounded p-0.5 text-destructive/70 dark:text-red-400/70 transition-colors hover:bg-destructive/10 hover:text-destructive dark:hover:text-red-400 focus-visible:outline focus-visible:outline-1 focus-visible:outline-destructive"
            >
              <Icon name="X" className="size-3" aria-hidden />
            </button>
          </div>
        ) : null}
        {sweepNotice !== null ? (
          <SweepNoticeBanner
            notice={sweepNotice}
            onUndo={onSweepUndo}
            onDismiss={onDismissSweepNotice}
          />
        ) : null}
        {browserNotice !== null ? (
          <div
            role="status"
            data-testid="browser-reveal-notice"
            className="mx-3 mb-1 flex items-center justify-between gap-2 rounded border border-amber-500/40 bg-amber-50 dark:bg-amber-950 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400"
          >
            <p className="min-w-0">{browserNotice.message}</p>
            <button
              type="button"
              onClick={() => onDismissBrowserNotice?.()}
              aria-label="Dismiss browser notice"
              title="Dismiss"
              className="rounded p-0.5 text-amber-700/70 transition-colors hover:bg-amber-500/10 hover:text-amber-700 focus-visible:outline focus-visible:outline-1 focus-visible:outline-amber-600 dark:text-amber-400/70 dark:hover:text-amber-400"
            >
              <Icon name="X" className="size-3" aria-hidden />
            </button>
          </div>
        ) : null}
        {hideLaneReport !== null ? (
          <div
            role="status"
            data-testid="lane-hide-notice"
            className="mx-3 mb-1 flex items-center justify-between gap-2 rounded border border-amber-500/40 bg-amber-50 dark:bg-amber-950 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400"
          >
            <p className="min-w-0">{hideLaneReport.message}</p>
            <button
              type="button"
              onClick={() => setHideLaneReport(null)}
              aria-label="Dismiss lane notice"
              title="Dismiss"
              className="rounded p-0.5 text-amber-700/70 transition-colors hover:bg-amber-500/10 hover:text-amber-700 focus-visible:outline focus-visible:outline-1 focus-visible:outline-amber-600 dark:text-amber-400/70 dark:hover:text-amber-400"
            >
              <Icon name="X" className="size-3" aria-hidden />
            </button>
          </div>
        ) : null}
        {nestNotice !== null ? (
          <div
            role="status"
            data-testid="nest-notice"
            className="mx-3 mb-1 flex items-center justify-between gap-2 rounded border border-amber-500/40 bg-amber-50 dark:bg-amber-950 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400"
          >
            {/* A nested child's card keeps its own slot, so the family's
                single render says little about the write: the receipt names
                the new parent and the undo. */}
            <p className="min-w-0">{nestNotice.message}</p>
            <button
              type="button"
              onClick={() => setNestNotice(null)}
              aria-label="Dismiss nest notice"
              title="Dismiss"
              className="rounded p-0.5 text-amber-700/70 transition-colors hover:bg-amber-500/10 hover:text-amber-700 focus-visible:outline focus-visible:outline-1 focus-visible:outline-amber-600 dark:text-amber-400/70 dark:hover:text-amber-400"
            >
              <Icon name="X" className="size-3" aria-hidden />
            </button>
          </div>
        ) : null}
        {sweepRefusal !== null ? (
          <SweepRefusalBanner
            message={sweepRefusal}
            onDismiss={() => setSweepRefusal(null)}
          />
        ) : null}
      </div>
      <div
        ref={scrollRef}
        onClick={handleBackgroundClick}
        data-columns-board
        data-lane-direction={laneDirection}
        className={cn(
          "min-h-0 flex-1 px-3 pb-3 pt-2",
          // The scroll follows the lane direction: vertical lanes sit in one
          // horizontally scrolling row (today's board); horizontal lanes
          // stack as rows the board scrolls vertically.
          horizontalLanes
            ? "overflow-y-auto overflow-x-hidden"
            : "overflow-x-auto overflow-y-hidden",
        )}
      >
        {/* The insertion line is the only visual feedback a reorder gives, so
            a screen reader gets the same information in words. */}
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
        <div
          className={cn(
            "flex h-full min-h-0 items-stretch gap-4",
            horizontalLanes && "flex-col",
          )}
        >
        {columns.map((column) => {
          // Not a thread lane: no drop, rank, sweep or cards (withJiraColumn).
          if (column.id === JIRA_COLUMN_ID) return <JiraColumnSlot key={column.id} />;
          const dropHandler = dropHandlerFor(column.id);
          const isDropTarget = dropHandler !== null;
          const sweepKind = sweepColumnKind(column.id);
          // The hide-a-lane affordance on the two bucket-grouped views:
          // the Project view shows it on real project lanes (no machine-less
          // "none" lane — the Project filter's menu cannot restore an
          // unlisted id; the Group view DOES list the "No group" bucket in
          // its menu, so that lane hides and restores like any other). No
          // fixed Pinned/Done lanes either side — they are board furniture,
          // not a project's or group's slice. Neither view's sweep kind
          // applies, so the header's sweep slot is free here.
          const hideLaneHere =
            (groupBy === "project" || groupBy === "group") &&
            onHideLane !== undefined &&
            (groupBy === "group" || column.id !== "none") &&
            column.id !== "pinned" &&
            column.id !== "done";
          // The sweep-family contract is arm-scoped: only the arms whose
          // action removes the thread from the live board (archive, Done)
          // refuse live-child parents. Unpinning and marking read leave the
          // thread live, so Pinned and Unread sweeps take parents too.
          const blockedIds = sweepRemovesThreads(column.id) ? sweepBlockedIds : undefined;
          const isArmed = armedSweep !== null && armedSweep.columnId === column.id;
          // A run is bound to its column: only that column's button shows
          // progress, and only its cards can carry the throbber.
          const runHere = sweepRun !== null && sweepRun.columnId === column.id ? sweepRun : null;
          // While armed, the LIVE selection drives count, gather, and
          // highlight — card clicks toggle it via onSweepToggle. Before
          // arming, the past-threshold set is what the button proposes.
          const eligible = isArmed
            ? (armedSweep?.threadIds ?? [])
            : sweepActive && sweepKind !== null
              ? (sweepCandidatesFor?.(column.id) ?? [])
              : [];
          // Selection never reorders the column: highlighted cards stay
          // where they are and the operator scrolls to see the blast
          // radius. Reordering on every toggle made deselecting feel like
          // the board was shuffling a deck (observed 2026-10-01).
          const columnRuns =
            runsFromColumns([column], groupBoxOf ?? EMPTY_GROUP_BOXES).get(column.id) ?? [];
          // The lane's DISPLAYED order, not the raw column order: the run
          // walk gathers each group's members into the lane's ONE frame at
          // the first member's slot, so a member's raw slot and its rendered
          // slot differ whenever the raw order interleaves a non-member — a
          // teleported card joining the frame, an unpin landing between two
          // members. Every interaction order input below (run roles, rank
          // reps, step math, rank writes, sweep ranges) reads this displayed
          // order, so what the operator sees and what a move computes agree.
          // Boxes off (or the Parent view, which never boxes) → the runs are
          // all singles and the flatten is identity.
          const shownThreads = flattenRuns(columnRuns);
          const armedSet = isArmed ? new Set(eligible) : null;
          // May this card join the armed selection? Blocked ids never join
          // in a removing arm, and a Done column's family projection card
          // is not a done thread. A direct click on a refused card refuses
          // loudly (below); inside a shift-range they are skipped silently.
          const cardMayJoinSweep = (threadId: string): boolean =>
            !(blockedIds?.has(threadId) ?? false) &&
            !(column.id === "done" && !doneIds.has(threadId));
          const rankKey = columnRankKey(groupBy, column.id);
          // This lane's transport plays: ghosts ride OUT of `fromColumnId`,
          // arrivals wipe in under `toColumnId` (the card is in the lane's
          // own data — arrival needs no slot param).
          const transportByThread = new Map(
            transports
              .filter((play) => play.fromColumnId === column.id || play.toColumnId === column.id)
              .map((play) => [play.threadId, play]),
          );
          // Seed on first intent: every card is a reorder target for its OWN
          // lane, whether or not that lane has a stored order yet. The drag
          // itself is the intent, and the first drop writes the order — so a
          // fresh install can reach the feature. The stored-order flag below
          // is for display only ("this lane is hand-ordered"), not a gate.
          const isOrdered = ranking && columnIsRanked(rankStore ?? {}, rankKey);
          // Family-box run info for this column (the decided group design):
          // who is boxed, at which edge — and which flat ids move as one
          // unit. Empty plan → plain cards everywhere, zero overhead.
          const runInfo = columnRunInfo(shownThreads, groupBoxOf ?? EMPTY_GROUP_BOXES);
          const unitOf = (threadId: string): readonly string[] | undefined => {
            const run = runInfo.get(threadId);
            return run !== undefined && run.role !== "solo" && run.memberIds.length > 1
              ? run.memberIds
              : undefined;
          };
          // The insertion line must sit on the BOX edge, not mid-box on a
          // hovered member: a before-edge maps to the run's first member,
          // an after-edge to the card after the run (or the run's last card
          // when the run ends the column).
          const rankRepFor = (hoverId: string, zone: DropZone): { threadId: string; zone: DropZone } => {
            const run = runInfo.get(hoverId);
            if (run === undefined || run.role === "solo" || zone === "onto") {
              return { threadId: hoverId, zone };
            }
            if (zone === "before") {
              return { threadId: run.memberIds[0], zone: "before" };
            }
            const at = shownThreads.findIndex((candidate) => candidate.id === run.memberIds[run.memberIds.length - 1]);
            const below = shownThreads[at + 1];
            return below !== undefined
              ? { threadId: below.id, zone: "before" }
              : { threadId: run.memberIds[run.memberIds.length - 1], zone: "after" };
          };
          /**
           * The nested-row reorder gesture, shared by a child row's dragover
           * and drop. Scope, on purpose: only a SAME-family sibling row is a
           * target — a row of another family (or an unrelated card dragged
           * over one) falls through untouched, keeping every gesture the
           * rows already participate in (nest-under-this-parent through the
           * card's surface, the detach floor). The write goes to the
           * family's own child rank order (`child:<parentId>`): the column
           * order the parent card shares with other cards must never decide
           * where the rows sit under their own parent.
           *
           * Only the row list the parent currently renders can be reordered
           * (attention and pinned children stand alone; a Done family's rows
           * keep their recency order), which `childRowsOf` already reflects.
           */
          const childRowsOf = (parentId: string): readonly PluginSidebarThread[] =>
            nestedChildrenByParent.get(parentId) ?? [];
          const childRowTarget = (
            parent: PluginSidebarThread,
            hoverChildId: string,
            draggedId: string,
            event: React.DragEvent,
          ): { beforeId: string | null; toEnd: boolean } | null => {
            if (!isLaneDrag(event.dataTransfer.types, rankKey)) return null;
            if (liveParentOf(draggedId) !== parent.id || draggedId === hoverChildId) return null;
            const rowIds = childRowsOf(parent.id).map((child) => child.id);
            const rect = event.currentTarget.getBoundingClientRect();
            const edge: Half = event.clientY - rect.top < rect.height / 2 ? "before" : "after";
            return moveTargetFor(rowIds, hoverChildId, edge, draggedId);
          };
          const childRankDragOver = (
            parent: PluginSidebarThread,
            hoverChildId: string,
            event: React.DragEvent,
          ): void => {
            if (!ranking) return;
            const draggedId = draggingIdRef.current;
            if (draggedId === null || draggedId === "" || draggedId === hoverChildId) return;
            // Only a same-family lane drag reorders; anything else leaves the
            // row's handlers unclaimed so the parent card's gestures run.
            const target = childRowTarget(parent, hoverChildId, draggedId, event);
            if (target === null) {
              // A same-family release that resolves to no move (the row's own
              // slot: the adjacency refusals moveTargetFor and unitMoveTarget
              // hold) claims the row surface and promises no line — unclaimed,
              // the gesture would fall through to the parent card and rank the
              // ROW in the lane's column order, a card the lane never holds. A
              // foreign row (another family's, or an unrelated card's) keeps
              // falling through untouched: those carry the parent card's own
              // gestures (nest, edges).
              if (liveParentOf(draggedId) === parent.id) {
                event.preventDefault();
                event.stopPropagation();
                clearChildDrop();
              }
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "move";
            const rect = event.currentTarget.getBoundingClientRect();
            const zone: Half = event.clientY - rect.top < rect.height / 2 ? "before" : "after";
            setChildDrop((current) =>
              current?.parentId === parent.id &&
              current?.childId === hoverChildId &&
              current?.zone === zone
                ? current
                : { parentId: parent.id, childId: hoverChildId, zone },
            );
          };
          const childRankDrop = (
            parent: PluginSidebarThread,
            hoverChildId: string,
            event: React.DragEvent,
          ): void => {
            if (!ranking) return;
            const droppedId = draggedIdFor(event, draggingIdRef.current);
            if (droppedId === "") return;
            // Guards re-run on the payload's id: the dragover's ref can name
            // a card the drop contradicts.
            const target = childRowTarget(parent, hoverChildId, droppedId, event);
            if (target === null) {
              // The same-family no-move: the event is claimed and refused
              // loudly, exactly like a card drop that lands in the dragged
              // card's own slot — nothing to reorder, but the operator hears
              // why. A foreign row stays unclaimed (the card's gestures ride
              // it).
              if (liveParentOf(droppedId) === parent.id) {
                event.preventDefault();
                event.stopPropagation();
                setChildDrop(null);
                reportRefusal(
                  `the drop position within ${parent.displayTitle} resolved to no move.`,
                );
              }
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            setChildDrop(null);
            setRankError(null);
            const rowIds = childRowsOf(parent.id).map((child) => child.id);
            onRankMove?.(childRankKey(parent.id), droppedId, target.beforeId, target.toEnd, rowIds);
            const after = displayAfterMove(rowIds, droppedId, target.beforeId, target.toEnd);
            setAnnouncement(
              `Moved to position ${after.indexOf(droppedId) + 1} of ${after.length} within ${parent.displayTitle}.`,
            );
          };
          /**
           * The dot-strip reorder gesture (issue #249, goals 3 and 4), a
           * sibling of the row gestures above with the same scope decision:
           * only a dot of THIS family's strip is a target, only a same-tier
           * sibling reorders, and the write rides the existing
           * `child:<tierParentId>` rank key — the same machinery the rows
           * write, so no new store shape exists. The dot's own tier is the
           * dragged dot's live parent: a child dot ranks the family's row
           * order (`child:<parentId>`), a sub-dot ranks that child's subs
           * (`child:<childId>`), so dots and rows always agree.
           *
           * Everything else stays inert: a dot drag carries its own drag
           * type, so a card drag hovering a dot claims nothing (the
           * click-preview strip keeps every gesture it already had), and a
           * release outside the strip resolves as the dragend refusal.
           */
          const dotTierParentOf = (
            parent: PluginSidebarThread,
            memberId: string,
          ): string | null => {
            const tierParent = liveParentOf(memberId);
            if (tierParent === null) return null;
            if (tierParent === parent.id) return tierParent;
            return childRowsOf(parent.id).some((child) => child.id === tierParent)
              ? tierParent
              : null;
          };
          const dotTierName = (parent: PluginSidebarThread, tierParentId: string): string =>
            tierParentId === parent.id
              ? parent.displayTitle
              : (childRowsOf(parent.id).find((child) => child.id === tierParentId)
                  ?.displayTitle ?? parent.displayTitle);
          const childDotDragOver = (
            parent: PluginSidebarThread,
            hoverMemberId: string,
            event: React.DragEvent,
          ): void => {
            if (!isDotDrag(event.dataTransfer.types)) return;
            if (!ranking) return;
            if (dotEscapedRef.current) {
              // The gesture already crossed the boundary: its tail is an
              // ordinary card drag, and dot drops never reorder. Claim the
              // strip quietly, promise nothing.
              event.preventDefault();
              event.stopPropagation();
              setChildDotLine(null);
              return;
            }
            const draggedId = dotDraggingRef.current;
            if (draggedId === null || draggedId === "" || draggedId === hoverMemberId) {
              // The dragged dot's own slot: claimed with no line — the drop
              // still lands here and refuses loudly, exactly like a same-family
              // row release that resolves to no move.
              event.preventDefault();
              event.stopPropagation();
              setChildDotLine(null);
              return;
            }
            const draggedTier = dotTierParentOf(parent, draggedId);
            if (draggedTier === null) {
              // A dot of ANOTHER family (or a payload that names no family
              // member): this strip is not its surface. Unclaimed — the
              // source's own strip handlers, and its dragend refusal, own
              // the gesture.
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "move";
            if (draggedTier !== dotTierParentOf(parent, hoverMemberId)) {
              // Hovering another tier's dot: claimed with no promise — dots
              // reorder within their tier, never across tiers of the family
              // (goal 3: dot drags stay inside the hierarchy), so the
              // release refuses instead of pretending.
              setChildDotLine(null);
              return;
            }
            const memberIds = childRowsOf(draggedTier).map((member) => member.id);
            const rect = event.currentTarget.getBoundingClientRect();
            const zone: Half = event.clientX - rect.left < rect.width / 2 ? "before" : "after";
            const target = moveTargetFor(memberIds, hoverMemberId, zone, draggedId);
            if (target === null) {
              // The adjacency refusals hold mid-hover too: the dot's own
              // neighbourhood promises nothing.
              setChildDotLine(null);
              return;
            }
            setChildDotLine((current) =>
              current?.familyId === parent.id &&
              current?.memberId === hoverMemberId &&
              current?.zone === zone
                ? current
                : { familyId: parent.id, memberId: hoverMemberId, zone },
            );
          };
          const childDotDrop = (
            parent: PluginSidebarThread,
            hoverMemberId: string,
            event: React.DragEvent,
          ): void => {
            if (!isDotDrag(event.dataTransfer.types)) return;
            if (!ranking) return;
            if (dotEscapedRef.current) {
              // The escaped drag came home: the release must land as a card
              // (a floor, a header, a card), never back onto dot rules.
              event.preventDefault();
              event.stopPropagation();
              setChildDotLine(null);
              reportRefusal("a dot that already left its strip must land as a card, not back on the dots.");
              return;
            }
            // The payload is authoritative at drop; the ref is the fallback
            // (draggedIdFor's contract).
            const droppedId = draggedIdFor(event, dotDraggingRef.current);
            if (droppedId === "") {
              event.preventDefault();
              event.stopPropagation();
              setChildDotLine(null);
              dotDragResolvedRef.current = true;
              reportRefusal("the drop could not identify the dragged dot.");
              return;
            }
            // Guards re-run on the payload's id: the dragover's ref can name
            // a dot the drop contradicts.
            const draggedTier = dotTierParentOf(parent, droppedId);
            const hoverTier = dotTierParentOf(parent, hoverMemberId);
            event.preventDefault();
            event.stopPropagation();
            setChildDotLine(null);
            // The surface is now resolved: the dragend's safety refusal stays
            // silent behind whatever this drop reports.
            dotDragResolvedRef.current = true;
            if (draggedTier === null) {
              reportRefusal("the dragged dot does not belong to this family's strip.");
              return;
            }
            if (droppedId === hoverMemberId) {
              reportRefusal(
                `the drop position within ${dotTierName(parent, draggedTier)} resolved to no move.`,
              );
              return;
            }
            if (draggedTier !== hoverTier) {
              reportRefusal(
                "a dot stays within its own tier of the family; drag it onto a dot of that tier.",
              );
              return;
            }
            const memberIds = childRowsOf(draggedTier).map((member) => member.id);
            const rect = event.currentTarget.getBoundingClientRect();
            const zone: Half = event.clientX - rect.left < rect.width / 2 ? "before" : "after";
            const target = moveTargetFor(memberIds, hoverMemberId, zone, droppedId);
            if (target === null) {
              reportRefusal(
                `the drop position within ${dotTierName(parent, draggedTier)} resolved to no move.`,
              );
              return;
            }
            setRankError(null);
            // The existing child-rank write: the same onRankMove the rows
            // call, with the tier's member ids as the visible order.
            onRankMove?.(childRankKey(draggedTier), droppedId, target.beforeId, target.toEnd, memberIds);
            const after = displayAfterMove(memberIds, droppedId, target.beforeId, target.toEnd);
            setAnnouncement(
              `Moved to position ${after.indexOf(droppedId) + 1} of ${after.length} within ${dotTierName(parent, draggedTier)}.`,
            );
          };
          return (
            <section
              key={column.id}
              data-column-id={column.id}
              data-column-ordered={isOrdered}
              aria-label={`${column.label}, ${column.threads.length} threads`}
              onDragOver={(event) => {
                // A dot drag (issue #249) authorises nowhere but its home
                // strip: the floor never promises it, so a release over a
                // column resolves as the refused dragend, and a member can
                // never detach by side effect — its drag-out is the explicit
                // morph gesture, and ESCAPED drags are exempt: the tail is a
                // card drag and the card rules (detach included) apply.
                if (isDotDrag(event.dataTransfer.types) && !dotEscapedRef.current) return;
                // A nested child dragged over THIS floor is a detach hover: the
                // family write rides any column, state gate or not — the same
                // rule the card nest zone follows in non-state lanes.
                const draggedId = draggingIdRef.current;
                const childOf =
                  draggedId !== null && draggedId !== "" ? liveParentOf(draggedId) : null;
                if (ranking && isLaneDrag(event.dataTransfer.types, rankKey)) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  if (childOf !== null && onReparent !== undefined) {
                    setFamilyFloorColumn(column.id);
                  }
                  return;
                }
                if (!isDropTarget) {
                  if (childOf !== null && onReparent !== undefined) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setFamilyFloorColumn(column.id);
                  }
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDragOverColumn(column.id);
                if (childOf !== null && onReparent !== undefined) {
                  setFamilyFloorColumn(column.id);
                }
              }}
              onDragLeave={
                isDropTarget || onReparent !== undefined
                  ? () => {
                      setDragOverColumn((c) => (c === column.id ? null : c));
                      setFamilyFloorColumn((c) => (c === column.id ? null : c));
                    }
                  : undefined
              }
              onDrop={(event) => {
                const threadId = draggedIdFor(event, draggingIdRef.current);
                const childOf = threadId === "" ? null : liveParentOf(threadId);
                const releaseFloor = () => {
                  setDragOverColumn(null);
                  setFamilyFloorColumn(null);
                  // The header's amber dies with any successful drop (a
                  // header drop bubbles into this very handler).
                  setFamilyHeaderColumn(null);
                };
                if (isDotDrag(event.dataTransfer.types) && !dotEscapedRef.current) {
                  // A dot drag that reaches the floor anyway (a stale
                  // dragover's authorization, or a synthetic event) refuses
                  // loudly and writes nothing: the strip is the whole dot
                  // surface of this cut (issue #249). Escaped drags fall
                  // through to the card rules below.
                  event.preventDefault();
                  releaseFloor();
                  dotDraggingRef.current = null;
                  dotDragResolvedRef.current = true;
                  reportRefusal("a dot reorder never leaves its family's strip.");
                  return;
                }
                if (ranking && isLaneDrag(event.dataTransfer.types, rankKey)) {
                  // Released over the lane's empty space below the last card:
                  // append. A drop ON a card was already claimed by that
                  // card's own handler, which stops propagation.
                  event.preventDefault();
                  clearRankDrop();
                  releaseFloor();
                  if (threadId !== "") {
                    if (childOf !== null && onReparent !== undefined) {
                      // A child released on a floor never keeps its family:
                      // the whole point of dragging it out is leaving it. The
                      // child was no visible slot in this lane, so there is
                      // no rank to move either — the detach IS the write.
                      commitUnnest(threadId);
                    } else {
                      commitMove(
                        column,
                        threadId,
                        null,
                        true,
                        shownThreads.map((candidate) => candidate.id),
                        unitOf(threadId),
                      );
                    }
                  }
                  return;
                }
                if (!isDropTarget) {
                  // The floor still takes a nested child — the detach — even
                  // where no lane write exists, so the gesture works in the
                  // project/provider/machine views too.
                  if (childOf !== null && onReparent !== undefined && threadId !== "") {
                    event.preventDefault();
                    releaseFloor();
                    commitUnnest(threadId);
                  }
                  return;
                }
                event.preventDefault();
                releaseFloor();
                if (threadId === "") return;
                dropHandler(threadId);
                if (childOf !== null && onReparent !== undefined) commitUnnest(threadId);
              }}
              className={cn(
                // Vertical lanes: one fixed-width column, full board height.
                // Horizontal lanes: one fixed-height row spanning the width
                // (the lanes row scrolls vertically between rows), its cards
                // flowing rightward inside the row's card list.
                horizontalLanes
                  ? "flex h-72 w-full min-h-0 min-w-0 shrink-0 flex-row rounded-lg transition-colors"
                  : "flex h-full min-h-0 w-64 shrink-0 flex-col rounded-lg transition-colors",
                familyFloorColumn === column.id
                  // Amber is the family drop color — the same signal the nest
                  // ring on cards gives — so "un-nests on release" is legible
                  // before the drop happens.
                  ? "bg-accent/60 ring-2 ring-amber-500"
                  : dragOverColumn === column.id && "bg-accent/60 ring-2 ring-ring",
              )}
            >
              <header
                className={cn(
                  // `group` lights the hover-revealed hide-lane icon.
                  // Vertical: a slim top strip. Horizontal: a narrow left
                  // strip the lane's label stacks down.
                  horizontalLanes
                    ? "group flex w-40 shrink-0 flex-col items-start gap-1 pb-1 pl-1 pr-1 pt-1.5 transition-colors"
                    : "group flex items-baseline gap-1.5 px-1 pb-1.5 transition-colors",
                  // Grow the hit strip only while a drag flies, and grow it
                  // with negated margins so no card moves beneath the cursor:
                  // +4px each side here, -4px back from the content flow.
                  dragInFlight && (horizontalLanes ? "-my-1 px-2 py-2.5" : "px-2 pb-2.5 -mx-1 -mb-1"),
                  familyHeaderColumn === column.id
                    ? "rounded-md ring-2 ring-amber-500 bg-accent/40"
                    : null,
                )}
                onDragOver={(event) => {
                  // Hover affordance only: the section's own onDragOver
                  // already preventDefaults a child drag and will accept the
                  // drop (the header is inside it), so nothing semantic
                  // happens here — the amber just follows the cursor up to
                  // the small element under it.
                  const draggedId = draggingIdRef.current;
                  if (draggedId === null || draggedId === "") return;
                  if (onReparent === undefined || liveParentOf(draggedId) === null) return;
                  setFamilyHeaderColumn(column.id);
                  setFamilyFloorColumn(column.id);
                }}
                onDragLeave={() => {
                  setFamilyHeaderColumn((c) => (c === column.id ? null : c));
                  setFamilyFloorColumn((c) => (c === column.id ? null : c));
                }}
                onDrop={(event) => {
                  // A release on the TITLE is not a placement: no rank move,
                  // no floor append. stopPropagation keeps the section's
                  // floor handler (state + rank in one gesture) out of it —
                  // dropping beside the cards (insertion line) stays the way
                  // to both change state AND place the card.
                  const threadId = draggedIdFor(event, draggingIdRef.current);
                  const childOf = threadId === "" ? null : liveParentOf(threadId);
                  const releaseFloor = () => {
                    setDragOverColumn(null);
                    setFamilyFloorColumn(null);
                    setFamilyHeaderColumn(null);
                  };
                  if (isDotDrag(event.dataTransfer.types) && !dotEscapedRef.current) {
                    // Same law as the floor below: a dot drag that lands on
                    // the title anyway refuses loudly and writes nothing
                    // (issue #249) — un-nesting is never a release side
                    // effect. Escaped drags fall through: the tail's detach
                    // is a card rule now.
                    event.preventDefault();
                    event.stopPropagation();
                    releaseFloor();
                    dotDraggingRef.current = null;
                    dotDragResolvedRef.current = true;
                    reportRefusal("a dot reorder never leaves its family's strip.");
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  releaseFloor();
                  if (threadId === "") return;
                  if (childOf !== null && onReparent !== undefined) {
                    commitUnnest(threadId);
                    return;
                  }
                  if (isDropTarget && !isLaneDrag(event.dataTransfer.types, rankKey)) {
                    // Cross-lane release on the title: the state change only
                    // — the card keeps its lane membership, so the operator
                    // drags it beside a card when placement matters.
                    dropHandler(threadId);
                  }
                  // Same-lane top-level: a deliberate no-op.
                }}
              >
                <h3 className="truncate text-[11px] font-medium text-muted-foreground">
                  {column.label}
                </h3>
                <span className="text-[11px] tabular-nums text-muted-foreground/60">
                  {column.threads.length}
                </span>
                {/* A hand-ordered lane says so, so a card sitting out of recency
                    order does not read as a bug. */}
                {isOrdered ? (
                  <span
                    title="This column is in your order, not by recency"
                    aria-label="Ordered by you, not by recency"
                    className="inline-flex items-center text-muted-foreground/50"
                  >
                    <Icon name="SortingOneNine" className="size-3" aria-hidden />
                  </span>
                ) : null}
                {(sweepActive && sweepKind !== null) || hideLaneHere ? (
                  <span className="ml-auto flex items-center gap-0.5">
                    {sweepActive && sweepKind !== null ? (
                      <>
                        <SweepButton
                          eligibleCount={eligible.length}
                          isArmed={isArmed}
                          run={
                            runHere === null
                              ? null
                              : { done: runHere.done, total: runHere.total }
                          }
                          destination={sweepDestination(column.id) ?? "archive"}
                          onArm={() => onSweepArm?.(column.id)}
                          onConfirm={() => onSweepConfirm?.(column.id)}
                        />
                        {isArmed || runHere !== null ? (
                          <SweepCancelButton
                            running={runHere !== null}
                            onClick={() => onSweepCancel?.()}
                          />
                        ) : null}
                      </>
                    ) : null}
                    {hideLaneHere ? (
                      // Hover-revealed at the sweep pill's slot: the eye-off
                      // icon reads as "make this lane invisible", which is
                      // exactly the write — the lane's project (or group)
                      // leaves its filter's selection. First click arms; the
                      // second writes; Escape or a press outside the armed
                      // icon (the document-level listeners above) disarms.
                      // The wording names the
                      // view's filter — each view's menu restores the lane.
                      (() => {
                        const armed = hideArmColumn === column.id;
                        const laneFilterLabel =
                          groupBy === "group" ? "Group filter" : "Project filter";
                        const laneSubject =
                          groupBy === "group" ? "its group" : "its project";
                        return (
                          <button
                            type="button"
                            data-hide-lane=""
                            data-hide-lane-armed={armed ? "" : undefined}
                            aria-label={
                              armed
                                ? `Hide the ${column.label} lane: ${laneSubject} leaves the ${laneFilterLabel}'s selection`
                                : `Hide the ${column.label} lane (click again to confirm)`
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              if (!armed) {
                                setHideArmColumn(column.id);
                                return;
                              }
                              setHideArmColumn(null);
                              const outcome =
                                onHideLane?.(column.id) ??
                                ({ kind: "refused", reason: "sole-lane" } as const);
                              setHideLaneReport({
                                message:
                                  outcome.kind === "hidden"
                                    ? `Hid the "${column.label}" lane. Restore it from the ${laneFilterLabel} in the toolbar.`
                                    : outcome.reason === "sole-lane"
                                      ? `The "${column.label}" lane is the only ${groupBy === "group" ? "group" : "project"} lane the board knows, so it stays on the board.`
                                      : `"${column.label}" is already outside the ${laneFilterLabel}, so the lane stays as it is.`,
                              });
                            }}
                            className={cn(
                              "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 text-[10px] font-medium transition-opacity",
                              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              armed
                                ? "bg-amber-500/90 text-amber-950 opacity-100 hover:bg-amber-500"
                                : cn(
                                    "transition-colors text-muted-foreground/70 hover:bg-accent/60 hover:text-foreground",
                                    "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                                  ),
                            )}
                          >
                            <Icon name="EyeOff" className="size-3" aria-hidden />
                            {armed ? "Hide" : null}
                          </button>
                        );
                      })()
                    ) : null}
                  </span>
                ) : null}
              </header>
              <div
                data-card-list
                className={cn(
                  "min-h-0 flex-1 rounded-lg bg-muted/30 p-1.5",
                  // The list scrolls along the lane flow: a vertical lane's
                  // stack scrolls its own Y, a horizontal lane's row its X.
                  horizontalLanes ? "overflow-x-auto" : "overflow-y-auto",
                )}
              >
                {column.threads.length === 0 && dragOverColumn !== column.id ? (
                  column.id === "working" ? (
                    // The ever-present Working lane answers the obvious
                    // question — is anything running? — with words.
                    <p className="px-1 py-3 text-center text-xs text-muted-foreground/60">
                      No work in progress
                    </p>
                  ) : isDropTarget ? (
                    <p className="px-1 py-3 text-center text-xs text-muted-foreground/60">
                      Drop to {column.id === "done" ? "mark done" : "mark unread"}
                    </p>
                  ) : null
                ) : null}
                {column.threads.length === 0 ? null : (() => {
                  // One renderer per card slot, shared by standalone cards
                  // and box members (a boxed run renders INSIDE one real
                  // dashed container, so its members' markup is identical
                  // either way — `boxRole` only carries the data attributes
                  // tests and styling key on).
                  const threadLi = (
                    thread: PluginSidebarThread,
                    boxRole?: "first" | "mid" | "last",
                    // The transport slots: a ghost keeps the card's old
                    // visuals in its old lane while the wipe-out runs; the
                    // arriving side is detected from the transport map (the
                    // card is in its lane's data).
                    ghostSlot?: { play: TransportPlay },
                  ) => {
                  // A live thread sitting in the Done column is a family's
                  // projection card: it renders the done portion of the
                  // family (done children nested under it) while the
                  // active card keeps the live portion. It is not a done
                  // thread — it carries the Done treatment and refuses
                  // sweep selection.
                  const isDoneProjection =
                    column.id === "done" && !doneIds.has(thread.id);
                  const projectionChildren = doneChildrenByParent.get(thread.id);
                  // This slot's box role, passed by the caller: attrs only —
                  // a box's outline is drawn by its CONTAINER (one dashed
                  // rounded element around the run), never by fragments on
                  // the cards; per-card fragments clipped at the list's top
                  // edge and never read as one box.
                  const boxDecor = boxRole;
                  // This card's transport roles: a ghost (when the run
                  // mapping injected one) and the wipe-in arrival (when the
                  // card's own lane data says it just landed here).
                  const ghostPlay = ghostSlot?.play;
                  const ownPlay = transportByThread.get(thread.id);
                  const isArriving =
                    ownPlay !== undefined &&
                    ownPlay.toColumnId === column.id &&
                    ownPlay.arrival === "wiping-in";
                  const arrivalPlay = ghostPlay ? undefined : ownPlay;
                  // The arrival's fade lives on the card wrapper INSIDE the
                  // slot: the slot li only clips (the grow animation's
                  // target), so the amber glint layer — a sibling, never a
                  // child of the fade — stays fully visible for the whole
                  // arrival sequence instead of inheriting the card's
                  // dissolve opacity.
                  const arrivingFade =
                    isArriving && arrivalPlay !== undefined && !prefersReducedMotion;
                  return (
                  <li
                    key={
                      ghostPlay !== undefined
                        ? `transport:${thread.id}`
                        : thread.id
                    }
                    aria-hidden={ghostPlay !== undefined ? true : undefined}
                    {...(ghostPlay !== undefined
                      ? // React 19 types `inert` as a boolean; the bare-string
                        // form React 18 needed now warns on every render.
                        { inert: true as const }
                      : {})}
                    data-transport-ghost={ghostPlay !== undefined ? "" : undefined}
                    data-transport-out={ghostPlay?.phase}
                    data-transport-arrival={arrivalPlay !== undefined && isArriving ? "wiping-in" : undefined}
                    style={
                      ghostPlay !== undefined && ghostPlay.phase === "collapsing"
                        ? {
                            // The static END state of the collapse, worn on
                            // the lane flow's axis (the zoom/collapse
                            // keyframes carry the matching animated close).
                            ...(horizontalLanes
                              ? { maxWidth: "0px" }
                              : { maxHeight: "0px" }),
                            overflow: "hidden",
                            ...(horizontalLanes
                              ? {
                                  marginLeft: `-${TRANSPORT_ROW_GAP_PX / 2}px`,
                                  marginRight: `-${TRANSPORT_ROW_GAP_PX / 2}px`,
                                }
                              : {
                                  marginTop: `-${TRANSPORT_ROW_GAP_PX / 2}px`,
                                  marginBottom: `-${TRANSPORT_ROW_GAP_PX / 2}px`,
                                }),
                          }
                        : arrivingFade
                          ? // Clipped shut until the grow animation opens the
                            // slot's size — the FADE no longer rides here:
                            // it claims the card wrapper inside (see
                            // data-transport-fade), so the glint layer keeps
                            // full brightness through the whole arrival.
                            horizontalLanes
                            ? { maxWidth: "0px", overflow: "hidden" }
                            : { maxHeight: "0px", overflow: "hidden" }
                          : undefined
                    }
                    ref={(el) => {
                      if (ghostPlay !== undefined) {
                        transportElsRef.current.set(`out:${ghostPlay.threadId}@${ghostPlay.gen}`, el);
                        return;
                      }
                      if (arrivingFade && arrivalPlay !== undefined) {
                        transportElsRef.current.set(
                          `slot:${arrivalPlay.threadId}@${arrivalPlay.gen}`,
                          el,
                        );
                      }
                    }}
                    data-rank-slot={ghostPlay !== undefined ? undefined : ranking ? thread.id : undefined}
                    data-group-box-member={
                      boxDecor !== undefined ? (runInfo.get(thread.id)?.boxId ?? undefined) : undefined
                    }
                    data-group-box-first={
                      boxDecor === "first" ? (runInfo.get(thread.id)?.boxId ?? undefined) : undefined
                    }
                    data-group-box-last={
                      boxDecor === "last" ? (runInfo.get(thread.id)?.boxId ?? undefined) : undefined
                    }
                        // Every card is a drop target for its own lane's
                        // drag; the hovered card decides which of its two
                        // edges the insertion line lands on, or whether the
                        // middle third offers nesting instead.
                        onDragOver={
                          (event) => {
                            if (!ranking) return;
                            if (isDotDrag(event.dataTransfer.types) && !dotEscapedRef.current) {
                              // Dot drags promise nothing on a card (issue
                              // #249): no nest zone, no edges — their surface
                              // is the family strip alone. Unclaimed, so the
                              // drop never fires here; the dragend refusal
                              // names the miss. ESCAPED drags fall through:
                              // the tail is an ordinary card drag, nest zone
                              // and all.
                              return;
                            }
                            if (!isLaneDrag(event.dataTransfer.types, rankKey)) {
                              // A drag from ANOTHER lane. A lane that takes
                              // state-change drops accepts it positioned:
                              // the same insertion line a same-lane drag
                              // gets, and the drop both moves the card into
                              // this lane and ranks it at that edge in one
                              // gesture. Lanes without a state-change drop
                              // (derived columns such as Attention or the
                              // idle buckets) keep refusing: membership
                              // there is the thread's own data — state, age,
                              // project — not a slot the board can honour.
                              // The nest zone is the one exception to the
                              // state-change gate: nesting is a family
                              // write, not lane membership, so it is
                              // offered over any card.
                              const zone = dropZoneFor(
                                event,
                                draggingIdRef.current,
                                thread.id,
                              );
                              if (zone !== "onto" && (draggingIdRef.current === null || !isDropTarget)) return;
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "move";
                              setRankDrop((current) =>
                                current?.columnId === column.id &&
                                current?.threadId === thread.id &&
                                current?.zone === zone
                                  ? current
                                  : { columnId: column.id, threadId: thread.id, zone },
                              );
                              return;
                            }
                            const droppedHoverId = draggingIdRef.current;
                            const zone = dropZoneFor(event, droppedHoverId, thread.id);
                            if (
                              memberEdgeDefersToJoin(
                                droppedHoverId ?? "",
                                runInfo.get(thread.id)?.boxId,
                                zone,
                                isLaneDrag(event.dataTransfer.types, rankKey),
                              )
                            ) {
                              // The enclosing group box arms the join instead;
                              // carrying this card's insertion line would put
                              // two promises under one pointer.
                              clearRankDrop();
                              return;
                            }
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            if (draggingIdRef.current === thread.id) {
                              clearRankDrop();
                              return;
                            }
                            // Same-run hover (a member of the dragged card's
                            // own box, either side): the EDGES reorder inside
                            // the box — the member moves alone, never the run
                            // (inBoxMoveTarget answers; the box-edge
                            // normalization stays unitMoveTarget's job). The
                            // middle third keeps the nest zone below.
                            const dragUnit =
                              draggingIdRef.current !== null && draggingIdRef.current !== ""
                                ? unitOf(draggingIdRef.current)
                                : undefined;
                            if (dragUnit !== undefined && dragUnit.includes(thread.id)) {
                              if (zone === "onto") {
                                const rep = rankRepFor(thread.id, zone);
                                setRankDrop((current) =>
                                  current?.columnId === column.id &&
                                  current?.threadId === rep.threadId &&
                                  current?.zone === rep.zone
                                    ? current
                                    : { columnId: column.id, threadId: rep.threadId, zone: rep.zone },
                                );
                                return;
                              }
                              const inBoxTarget = inBoxMoveTarget(
                                shownThreads.map((candidate) => candidate.id),
                                thread.id,
                                zone,
                                draggingIdRef.current as string,
                                runInfo,
                              );
                              if (inBoxTarget === null) {
                                clearRankDrop();
                                return;
                              }
                              setRankDrop((current) =>
                                current?.columnId === column.id &&
                                current?.threadId === thread.id &&
                                current?.zone === zone
                                  ? current
                                  : { columnId: column.id, threadId: thread.id, zone },
                              );
                              return;
                            }
                            const rep = rankRepFor(thread.id, zone);
                            // The line is the drop's promise: a release that
                            // resolves to the dragged card's own slot (the
                            // adjacency refusals moveTargetFor and
                            // unitMoveTarget hold) must not promise one. The
                            // drop still lands and refuses loudly instead.
                            const hoverTarget =
                              rep.zone === "onto"
                                ? { beforeId: null, toEnd: false }
                                : unitMoveTarget(
                                    shownThreads.map((candidate) => candidate.id),
                                    rep.threadId,
                                    rep.zone,
                                    draggingIdRef.current as string,
                                    runInfo,
                                  );
                            if (hoverTarget === null) {
                              clearRankDrop();
                              return;
                            }
                            setRankDrop((current) =>
                              current?.columnId === column.id &&
                              current?.threadId === rep.threadId &&
                              current?.zone === rep.zone
                                ? current
                                : { columnId: column.id, threadId: rep.threadId, zone: rep.zone },
                            );
                          }
                        }
                        onDrop={
                          (event) => {
                            if (isDotDrag(event.dataTransfer.types) && !dotEscapedRef.current) {
                              // A dot drag that reaches a card surface anyway
                              // (a stale dragover's authorization, or a
                              // synthetic event) refuses and nests nothing:
                              // childing a member is the childing morphology
                              // of a later cut, never a release side effect
                              // (issue #249). ESCAPED drags fall through:
                              // their tail's nest writes are card rules.
                              event.preventDefault();
                              event.stopPropagation();
                              dotDraggingRef.current = null;
                              dotDragResolvedRef.current = true;
                              reportRefusal("a dot reorder never leaves its family's strip.");
                              return;
                            }
                            if (!ranking) return;
                            // The payload is readable only here; zone math
                            // re-reads the live position (the last dragover
                            // can land on a different card than the one the
                            // state was set on) and re-runs the guard on the
                            // real dropped id — the ref the dragover used can
                            // name a card the payload contradicts.
                            const droppedId = draggedIdFor(event, draggingIdRef.current);
                            const zone = dropZoneFor(event, droppedId, thread.id);
                            if (
                              memberEdgeDefersToJoin(
                                droppedId,
                                runInfo.get(thread.id)?.boxId,
                                zone,
                                isLaneDrag(event.dataTransfer.types, rankKey),
                              )
                            ) {
                              // Claimless on purpose: the event bubbles to the
                              // group box's onDrop, which joins — the promise
                              // its dragover armed over this same card.
                              return;
                            }
                            if (zone === "onto") {
                              event.preventDefault();
                              // Claim the event so the column's own handler
                              // — the append or state-change path — does not
                              // also fire for this drop.
                              event.stopPropagation();
                              clearRankDrop();
                              releaseDropAffordances();
                              commitNest(droppedId, thread);
                              return;
                            }
                            const edge: Half = zone;
                            if (!isLaneDrag(event.dataTransfer.types, rankKey)) {
                              // A cross-lane drop ON a card: the state change
                              // and the ranked position the line showed happen
                              // in the one drop — no second drag to place the
                              // card after it lands. Guards mirror dragover
                              // above: only state-change lanes, only lane
                              // drags, or a foreign drag could write an order
                              // for a card the lane never held.
                              if (draggingIdRef.current === null || !isDropTarget) return;
                              event.preventDefault();
                              // Claim the event so the column's own handler —
                              // the unpositioned state-change path — does not
                              // also fire for this drop.
                              event.stopPropagation();
                              clearRankDrop();
                              releaseDropAffordances();
                              if (droppedId === "") return;
                              // The state change first — the card joins the
                              // lane — then the ranked slot the line showed.
                              if (dropHandler !== null) dropHandler(droppedId);
                              const target = unitMoveTarget(
                                shownThreads.map((candidate) => candidate.id),
                                thread.id,
                                edge,
                                droppedId,
                                runInfo,
                              );
                              if (target !== null) {
                                commitMove(
                                  column,
                                  droppedId,
                                  target.beforeId,
                                  target.toEnd,
                                  shownThreads.map((candidate) => candidate.id),
                                  unitOf(droppedId),
                                );
                              }
                              return;
                            }
                            event.preventDefault();
                            // The drop bubbles to the column's own handler,
                            // which treats a same-lane drag as "append". Claim
                            // the event so one drop is one move, not an
                            // insert plus an append.
                            event.stopPropagation();
                            clearRankDrop();
                            releaseDropAffordances();
                            if (droppedId === "") return;
                            // A hover inside the dragged member's own box
                            // reorders WITHIN the family: the member moves
                            // alone (no unit ids), into the slot the line
                            // showed. Every hover outside the box keeps the
                            // box-edge unit move.
                            const dropRun = runInfo.get(droppedId);
                            const hoverRun = runInfo.get(thread.id);
                            const sameBox =
                              dropRun !== undefined &&
                              dropRun.role !== "solo" &&
                              hoverRun !== undefined &&
                              hoverRun.role !== "solo" &&
                              dropRun.boxId === hoverRun.boxId;
                            const target = sameBox
                              ? inBoxMoveTarget(
                                  shownThreads.map((candidate) => candidate.id),
                                  thread.id,
                                  edge,
                                  droppedId,
                                  runInfo,
                                )
                              : unitMoveTarget(
                                  shownThreads.map((candidate) => candidate.id),
                                  thread.id,
                                  edge,
                                  droppedId,
                                  runInfo,
                                );
                            if (target === null) {
                              reportRefusal(
                                `the drop position in ${column.label} resolved to no move.`,
                              );
                              return;
                            }
                            commitMove(
                              column,
                              droppedId,
                              target.beforeId,
                              target.toEnd,
                              shownThreads.map((candidate) => candidate.id),
                              sameBox ? undefined : unitOf(droppedId),
                            );
                          }
                        }
                        onDragLeave={
                          ranking
                            ? (event) => {
                                // The marker is the hover's promise. The
                                // browser fires dragleave on the slot the
                                // moment the pointer crosses out of it — up
                                // to the title strip, into the floor gap,
                                // across to another column — and the promise
                                // must die with the hover: a drop on the
                                // title writes no placement, so a line parked
                                // there lies about where the card would land.
                                const into = event.relatedTarget;
                                if (into instanceof Node && event.currentTarget.contains(into)) {
                                  return;
                                }
                                clearRankDrop();
                              }
                            : undefined
                        }
                        // A drag is mouse-only, so a column also takes Alt+Arrow
                        // from a focused card. Without it the reorder is
                        // unreachable for keyboard and touch.
                        onKeyDown={
                          (event) => {
                            if (!ranking) return;
                            if (!event.altKey) return;
                            // The reorder keys follow the lane flow: Up/Down
                            // step along a vertical lane's stack, Left/Right
                            // along a horizontal lane's row.
                            const goingBack = horizontalLanes
                              ? event.key === "ArrowLeft"
                              : event.key === "ArrowUp";
                            const goingForward = horizontalLanes
                              ? event.key === "ArrowRight"
                              : event.key === "ArrowDown";
                            if (!goingBack && !goingForward) return;
                            const at = shownThreads.indexOf(thread);
                            const visibleIds = shownThreads.map((candidate) => candidate.id);
                            const unit = unitOf(thread.id);
                            if (unit !== undefined && unit.length > 1) {
                              // A boxed member steps its WHOLE box, anchored
                              // at the neighbouring run's edge — the same
                              // normalization a drag gets, so a step never
                              // splices into another box's middle.
                              const run = runInfo.get(thread.id);
                              const stepInfo = run;
                              if (stepInfo === undefined) return;
                              const firstIdx = visibleIds.indexOf(stepInfo.memberIds[0]);
                              const lastIdx = visibleIds.indexOf(
                                stepInfo.memberIds[stepInfo.memberIds.length - 1],
                              );
                              if (goingBack) {
                                if (firstIdx <= 0) return;
                                const target = unitMoveTarget(
                                  visibleIds,
                                  visibleIds[firstIdx - 1],
                                  "before",
                                  thread.id,
                                  runInfo,
                                );
                                if (target === null) return;
                                event.preventDefault();
                                commitMove(column, thread.id, target.beforeId, target.toEnd, visibleIds, unit);
                                return;
                              }
                              const hoverBelow = visibleIds[lastIdx + 1] ?? null;
                              if (hoverBelow === null) {
                                event.preventDefault();
                                commitMove(column, thread.id, null, true, visibleIds, unit);
                                return;
                              }
                              const target = unitMoveTarget(
                                visibleIds,
                                hoverBelow,
                                "after",
                                thread.id,
                                runInfo,
                              );
                              if (target === null) return;
                              event.preventDefault();
                              commitMove(column, thread.id, target.beforeId, target.toEnd, visibleIds, unit);
                              return;
                            }
                            const to = goingBack ? at - 1 : at + 1;
                            if (to < 0 || to >= shownThreads.length) return;
                            event.preventDefault();
                            // Back anchors on the card being stepped over;
                            // forward anchors on the one after the
                            // destination, or appends when the card is
                            // already last in the flow.
                            const beforeId =
                              goingBack
                                ? shownThreads[to].id
                                : (shownThreads[to + 1]?.id ?? null);
                            commitMove(column, thread.id, beforeId, beforeId === null, visibleIds);
                          }
                        }
                        className={cn(
                          "relative",
                          // A horizontal lane's slot holds the card's fixed
                          // width so the row's flow spaces every card evenly.
                          horizontalLanes && "w-60 shrink-0",
                          ghostPlay !== undefined && "pointer-events-none",
                          rankDrop?.columnId === column.id && rankDrop.threadId === thread.id && (
                            rankDrop.zone === "onto"
                              // The nest zone: a ring around the whole card,
                              // not an insertion line — the drop is "into"
                              // this card, not beside it. Amber marks the
                              // family write so it reads differently from the
                              // insertion line's lane-color affordance.
                              ? "after:absolute after:inset-0 after:rounded-lg after:ring-2 after:ring-amber-500 after:bg-amber-500/10"
                              : rankDrop.zone === "before"
                                // The line sits on the flow edge the drop
                                // would insert at: top/bottom in a vertical
                                // lane, left/right in a horizontal one.
                                ? horizontalLanes
                                  ? "before:absolute before:inset-y-0 before:-left-0.5 before:w-0.5 before:rounded-full before:bg-ring"
                                  : "before:absolute before:inset-x-0 before:-top-0.5 before:h-0.5 before:rounded-full before:bg-ring"
                                : horizontalLanes
                                  ? "after:absolute after:inset-y-0 after:-right-0.5 after:w-0.5 after:rounded-full after:bg-ring"
                                  : "after:absolute after:inset-x-0 after:-bottom-0.5 after:h-0.5 after:rounded-full after:bg-ring"
                          ),
                        )}
                      >
                        <div
                          data-transport-fade={arrivingFade ? "" : undefined}
                          // A plain transparent container for ordinary cards
                          // (the card participates in layout as before); the
                          // fade element only while the card is arriving.
                          className={arrivingFade ? undefined : "contents"}
                          style={arrivingFade ? { opacity: 0 } : undefined}
                          ref={(el) => {
                            if (arrivingFade && el !== null && arrivalPlay !== undefined) {
                              transportElsRef.current.set(
                                `arrival:${arrivalPlay.threadId}@${arrivalPlay.gen}`,
                                el,
                              );
                            }
                          }}
                        >
                        <ThreadCard
                          thread={thread}
                          stateDot={<StateDot thread={thread} errorAcks={errorAckIds} />}
                          isActive={thread.id === activeThreadId}
                          isTransportGhost={ghostPlay !== undefined}
                          isDone={doneIds.has(thread.id) || isDoneProjection}
                          onAttentionEnter={onAttentionEnter}
                          onAttentionLeave={onAttentionLeave}
                          isSweepHighlighted={armedSet?.has(thread.id) ?? false}
                          isSweeping={runHere !== null && runHere.activeId === thread.id}
                          isSweepSelecting={isArmed}
                          isSweepSelectable={
                            isArmed &&
                            !isDoneProjection &&
                            !(armedSet?.has(thread.id) ?? false) &&
                            !(blockedIds?.has(thread.id) ?? false)
                          }
                          onSweepToggle={(toggledId, gesture) => {
                            if (blockedIds?.has(toggledId) ?? false) {
                              setSweepRefusal(
                                `"${thread.displayTitle}" still has live children, so it cannot join a sweep.`,
                              );
                              return;
                            }
                            if (isDoneProjection) {
                              setSweepRefusal(
                                `"${thread.displayTitle}" is a family's Done card, not a done thread.`,
                              );
                              return;
                            }
                            if (gesture.shiftKey) {
                              // Shift extends: anchor through this card in
                              // display order, ids that may not join skipped.
                              // The anchor itself stays put — only non-shift
                              // clicks move it.
                              const anchor =
                                sweepAnchorRef.current?.columnId === column.id
                                  ? sweepAnchorRef.current.threadId
                                  : null;
                              onSweepRangeSelect?.(
                                sweepRangeIds(
                                  shownThreads.map((candidate) => candidate.id),
                                  anchor,
                                  toggledId,
                                  cardMayJoinSweep,
                                ),
                              );
                              return;
                            }
                            // Plain and cmd/ctrl clicks toggle one card —
                            // the mode's curation gesture — and become the
                            // next shift-click's anchor.
                            sweepAnchorRef.current = {
                              columnId: column.id,
                              threadId: toggledId,
                            };
                            onSweepToggle?.(toggledId);
                          }}
                          projectName={projectNameFor(thread.projectId)}
                          repoHrefBase={repoBaseFor(thread.projectId) ?? undefined}
                          statusFor={statusFor}
                          linkedIssues={linkedIssuesFor?.(thread.id)}
                          childLinkedIssuesFor={linkedIssuesFor}
                          validatedHrefs={validatedHrefs}
                          menuActions={menuActionsFor(thread)}
                          // The hover checkbox shares the menu's "done"
                          // action run (one done recipe), in both
                          // directions: on a not-done card it marks done,
                          // on a done card (Done lane and family
                          // projections included) it marks not done.
                          onMarkDone={menuActionsFor(thread).find((action) => action.id === "done")?.run}
                          childThreads={
                            isDoneProjection
                              ? projectionChildren
                              : nestedChildrenByParent.get(thread.id)
                          }
                          grandchildThreadsByParent={
                            // The sub-row tier draws from the nested map
                            // everywhere: a child row's own children nest
                            // there (done children of done parents included,
                            // the both-done nest rule), so one map serves
                            // live cards and Done projections alike.
                            nestedChildrenByParent
                          }
                          childCount={
                            isDoneProjection
                              ? countDoneRows(doneChildrenByParent, nestedChildrenByParent, thread.id)
                              : (childCountByParent.get(thread.id) ?? 0)
                          }
                          isCollapsed={collapsedFamilyIds?.has(
                            isDoneProjection ? foldKeyForSpace(thread.id) : thread.id,
                          )}
                          onCollapsedChange={(collapsed) =>
                            onFamilyCollapsedChange?.(
                              isDoneProjection ? foldKeyForSpace(thread.id) : thread.id,
                              collapsed,
                            )
                          }
                          hideIdleChildren={hideIdleFamilyIds?.has(
                            isDoneProjection ? foldKeyForSpace(thread.id) : thread.id,
                          )}
                          onHideIdleChildrenChange={(hide) =>
                            onFamilyHideIdleChange?.(
                              isDoneProjection ? foldKeyForSpace(thread.id) : thread.id,
                              hide,
                            )
                          }
                          snoozeFor={snoozeFor}
                          pulseRateFor={pulseRateFor}
                          doneIds={doneIds}
                          activeThreadId={activeThreadId}
                          dimmed={dimmedIds.has(thread.id)}
                          onOpen={() => onOpenThread(thread.id)}
                          onOpenThread={onOpenThread}
                          childMenuActions={menuActionsFor}
                          childRankDrag={
                            ranking &&
                            onRankMove !== undefined &&
                            // Done keeps its recency order — rows under a
                            // Done card (a done parent's or a family
                            // projection's) sort by when the work finished,
                            // and a child-rank write there would never show.
                            column.id !== "done" &&
                            childRowsOf(thread.id).length > 1
                              ? {
                                  onDragOver: (hoverChildId, event) =>
                                    childRankDragOver(thread, hoverChildId, event),
                                  onDrop: (hoverChildId, event) =>
                                    childRankDrop(thread, hoverChildId, event),
                                  onDragLeave: () => clearChildDrop(),
                                  line:
                                    childDrop !== null && childDrop.parentId === thread.id
                                      ? { childId: childDrop.childId, zone: childDrop.zone }
                                      : undefined,
                                }
                              : undefined
                          }
                          childDotDrag={
                            ranking &&
                            onRankMove !== undefined &&
                            // The same Done rule as the rows above: the
                            // projection's strip keeps its recency story.
                            column.id !== "done" &&
                            // The strip reorders when it can: more than one
                            // member painted (the card renders the family's
                            // rows plus their sub-rows — the same lists the
                            // dots agree with, per the #248 invariant).
                            childRowsOf(thread.id).length +
                              childRowsOf(thread.id).reduce(
                                (count, child) => count + childRowsOf(child.id).length,
                                0,
                              ) >
                              1
                              ? {
                                  onDragStart: (memberId, event) =>
                                    childDotDragStart(memberId, event),
                                  onDragOver: (hoverMemberId, event) =>
                                    childDotDragOver(thread, hoverMemberId, event),
                                  onDrop: (hoverMemberId, event) =>
                                    childDotDrop(thread, hoverMemberId, event),
                                  onDragEnd: () => childDotDragEnd(),
                                  line:
                                    childDotLine !== null && childDotLine.familyId === thread.id
                                      ? { memberId: childDotLine.memberId, zone: childDotLine.zone }
                                      : undefined,
                                  // The morph wire: the strip whose dot crossed
                                  // the boundary lights its own family card.
                                  escaped:
                                    dotDragEscapedMember !== null &&
                                    dotTierParentOf(thread, dotDragEscapedMember) !== null,
                                }
                              : undefined
                          }
                          stripNestDrag={
                            onReparent !== undefined
                              ? {
                                  onDragOver: (event) => stripNestOver(thread, event),
                                  onDrop: (event) => stripNestDrop(thread, event),
                                  onDragLeave: () => stripNestLeave(),
                                }
                              : undefined
                          }
                          stripNestHover={
                            stripNestHover !== null && stripNestHover.familyId === thread.id
                              ? {
                                  member: stripNestHover.member,
                                  x: stripNestHover.x,
                                  y: stripNestHover.y,
                                }
                              : undefined
                          }
                          rankKey={ranking ? rankKey : undefined}
                          onRankDragStart={rankDragLifecycle}
                        />
                        </div>
                        {/* The shimmer rides both sweeps: the ghost's
                            glints twinkle out over the OLD visuals, the
                            arrival's ride the SLOT — a sibling of the fade
                            wrapper, so they never inherit the card's
                            dissolve opacity and twinkle at full brightness
                            for the whole arrival. The ghost's own layer
                            dissolves with its host (the departure fades as
                            one). A dissolve-only decoration: the zoom plays no
                            glint field. */}
                        {ghostPlay !== undefined && transportSparksOn ? (
                          <TransportSparkLayer phaseMs={paceMs(TRANSPORT_WIPE_OUT_MS)} tone="out" />
                        ) : isArriving && arrivalPlay !== undefined && transportSparksOn ? (
                          <TransportSparkLayer phaseMs={paceMs(TRANSPORT_WIPE_IN_MS)} tone="in" />
                        ) : null}
                  </li>
                  );
                  };
                  // A run transport's ghost: the WHOLE dashed container
                  // dissolves (the box was one visual shape), holding the
                  // pre-move member snapshots inert while the wipe-out and
                  // collapse run. The container drives the wipe, the
                  // transport attributes, and the phase styles; the members
                  // render the same card markup a live box member does
                  // (firstRealCard skips ghost subtrees, and the container's
                  // inert + pointer-events cut every gesture).
                  const ghostRunLi = (play: TransportPlay) => (
                    <li
                      key={`transport:${play.threadId}`}
                      aria-hidden
                      {...({ inert: "" } as unknown as Record<string, never>)}
                      className={cn(
                        "pointer-events-none relative",
                        horizontalLanes ? "ml-1.5 w-60 shrink-0" : "mt-1.5",
                      )}
                      data-group-box={play.threadId}
                      data-transport-ghost=""
                      data-transport-out={play.phase}
                      style={
                        play.phase === "collapsing"
                          ? {
                              // The static END state of the collapse, as a
                              // card ghost's (the animation's fill keeps its
                              // frames winning in a browser; a no-WAAPI
                              // environment lands here instantly).
                              ...(horizontalLanes
                                ? { maxWidth: "0px" }
                                : { maxHeight: "0px" }),
                              overflow: "hidden",
                              ...(horizontalLanes
                                ? {
                                    marginLeft: `-${TRANSPORT_ROW_GAP_PX / 2}px`,
                                    marginRight: `-${TRANSPORT_ROW_GAP_PX / 2}px`,
                                  }
                                : {
                                    marginTop: `-${TRANSPORT_ROW_GAP_PX / 2}px`,
                                    marginBottom: `-${TRANSPORT_ROW_GAP_PX / 2}px`,
                                  }),
                            }
                          : undefined
                      }
                      ref={(el) => {
                        transportElsRef.current.set(
                          `out:${play.threadId}@${play.gen}`,
                          el,
                        );
                      }}
                    >
                      <div className="relative rounded-lg border border-dashed border-muted-foreground/50 px-1 pt-4 pb-0.5">
                        <span
                          data-group-box-label={play.threadId}
                          className="absolute -top-2 left-3 z-10 rounded-sm bg-muted px-1 text-[10.5px] leading-[14px] text-muted-foreground"
                        >
                          {play.boxName}
                        </span>
                        {collapsedGroupIds?.has(play.threadId) ? (
                          // The box was folded when it left: the ghost keeps
                          // the fold's shape — one dashed normal-size card —
                          // so the dissolve never flashes the expanded box.
                          <div
                            data-ghost-collapsed-group={play.threadId}
                            className="rounded-md border border-dashed border-muted-foreground/50 bg-card px-2.5 py-1.5"
                          >
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <span className="truncate">{play.boxName}</span>
                              <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] tabular-nums">
                                {(play.members ?? []).length}{" "}
                                {(play.members ?? []).length === 1 ? "thread" : "threads"}
                              </span>
                            </div>
                          </div>
                        ) : (
                          <ul className={cn("flex gap-1.5", horizontalLanes ? "flex-row" : "flex-col")}>
                            {(play.members ?? []).map((member) => threadLi(member))}
                          </ul>
                        )}
                        {transportSparksOn ? (
                          <TransportSparkLayer phaseMs={paceMs(TRANSPORT_WIPE_OUT_MS)} tone="out" />
                        ) : null}
                      </div>
                    </li>
                  );
                  // The run list: standalone card slots at their own
                  // positions; a boxed run renders ONE dashed container li
                  // whose members keep their own card slots inside. The
                  // container rides in the column's own order (at its first
                  // member's slot), the label sits on its top margin — inside
                  // the scrollport at any position, never clipped by the
                  // list's top edge (the old per-card fragments truncated
                  // there; observed 2026-10-09, "fraction of a label").
                  // `columnRuns` is the walk computed once for this lane
                  // above (it also feeds `shownThreads` here).
                  // The transport ghosts ride their OLD slot positions in
                  // this lane: the planner snapshots the lane's order, and
                  // insertGhostSlots weaves the ghosts in between the runs
                  // their slots occupied.
                  const laneOutGhosts = transports.filter(
                    (play) => play.fromColumnId === column.id,
                  );
                  // One display run's markup (the ghost render maps
                  // entries through it — every entry that is not a ghost
                  // is a run of this column).
                  // A run transport's arriving side: the box CONTAINER
                  // carries the wipe-in (one dashed shape, never per
                  // member) when the unit's play says it just landed here.
                  const boxArrivalFor = (groupId: string) => {
                    const play = transportByThread.get(groupId);
                    return play !== undefined &&
                      play.toColumnId === column.id &&
                      play.arrival === "wiping-in"
                      ? play
                      : undefined;
                  };
                  /**
                   * The group-box label is a drag source for the whole box: it
                   * carries the LEAD member's id (the payload every drop path
                   * already reads) plus this lane's rank-drag type, and hands
                   * the shared lifecycle the lead's id — from here the unit
                   * move math, the column-floor append, and the join
                   * affordances all run exactly as they do for a member card
                   * grab.
                   */
                  const beginBoxLabelDrag = (
                    event: React.DragEvent,
                    box: { members: readonly PluginSidebarThread[] },
                  ): void => {
                    const lead = box.members[0];
                    if (lead === undefined) return;
                    // A sleeping card refuses drag everywhere; the label is
                    // no exception.
                    if ((snoozeFor?.(lead.id) ?? null) !== null) {
                      event.preventDefault();
                      return;
                    }
                    event.dataTransfer.setData(DRAG_ID_KEY, lead.id);
                    if (ranking) {
                      event.dataTransfer.setData(rankDragType(rankKey), "");
                      rankDragLifecycle(lead.id);
                    }
                  };
                  /**
                   * One box run's fold state: the box renders as ONE
                   * normal-size card when the caller persisted a collapse for
                   * its group AND can expand it again (unwired boards never
                   * fold), and never while its label rename editor is open —
                   * the editor lives in the expanded box's label row, so the
                   * fold lifts while it is on.
                   */
                  const boxCollapseFolds = (box: GroupBox): boolean =>
                    onGroupCollapsedChange !== undefined &&
                    renamingBoxId !== box.groupId &&
                    (collapsedGroupIds?.has(box.groupId) ?? false);
                  /**
                   * The folded box's chevron chip, beside the expanded box's
                   * label: present only when the caller persists collapse
                   * state, so an unwired board never offers the fold.
                   */
                  const boxCollapseChevron = (box: {
                    groupId: string;
                    name: string;
                  }) =>
                    onGroupCollapsedChange === undefined ? null : (
                      <button
                        type="button"
                        data-group-box-collapse={box.groupId}
                        aria-label={`Collapse group ${box.name}`}
                        title={`Collapse group “${box.name}” — the member cards fold into one compact card`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onGroupCollapsedChange?.(box.groupId, true);
                        }}
                        className={cn(
                          "flex h-[14px] items-center rounded-sm bg-muted px-0.5 text-muted-foreground",
                          "transition-colors hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        )}
                      >
                        <Icon name="ChevronsUp" className="size-2.5" aria-hidden />
                      </button>
                    );
                  /**
                   * One folded box run's markup: ONE normal-size card whose
                   * dashed ring keeps the box's own vocabulary — the visual
                   * that distinguishes it from a real thread card or a parent
                   * thread card. It carries the group name, the member count,
                   * and one status dot per member (the same strip the family
                   * fold uses); the cards it stands for are hidden. The box's
                   * gestures ride it: it drags the whole unit (the lead
                   * member's payload, the label drag's own), it accepts
                   * drop-to-join over its whole surface, it carries the same
                   * amber highlight frames the expanded box draws, and a
                   * right-click opens the group's menu (its "Expand group"
                   * entry unwinds the fold).
                   */
                  const renderCollapsedBoxRun = (box: {
                    groupId: string;
                    name: string;
                    members: readonly PluginSidebarThread[];
                  }) => {
                    const collapsedGroupMenuWired =
                      onNewThreadInGroup !== undefined ||
                      onZoomToGroup !== undefined ||
                      onRenameGroup !== undefined ||
                      onDeleteGroup !== undefined ||
                      onGroupCollapsedChange !== undefined;
                    return (
                      <li
                        key={`group:${box.groupId}`}
                        // The folded card IS the group's frame in the lane:
                        // the same marker keeps the drag/join surfaces and the
                        // background click's highlight clearing honest.
                        data-group-box={box.groupId}
                        data-collapsed-group={box.groupId}
                        data-transport-arrival={
                          boxArrivalFor(box.groupId) ? "wiping-in" : undefined
                        }
                        style={
                          boxArrivalFor(box.groupId) !== undefined &&
                          !prefersReducedMotion
                            ? { maxHeight: "0px", overflow: "hidden" }
                            : undefined
                        }
                        ref={(el) => {
                          const arriving = boxArrivalFor(box.groupId);
                          if (arriving !== undefined) {
                            transportElsRef.current.set(
                              `slot:${arriving.threadId}@${arriving.gen}`,
                              el,
                            );
                          }
                        }}
                        className={cn(
                          "relative",
                          horizontalLanes ? "ml-1.5 shrink-0" : "mt-1.5",
                        )}
                        draggable={box.members.length > 0}
                        onDragStart={(event) => beginBoxLabelDrag(event, box)}
                        onDragEnd={() => rankDragLifecycle(null)}
                        onContextMenu={(event) => {
                          // The group menu covers the folded card exactly as
                          // it covers the expanded box's surface; an unwired
                          // board opens nothing.
                          if (!collapsedGroupMenuWired) return;
                          event.preventDefault();
                          setGroupMenuUngroupArmed(false);
                          setGroupMenu({
                            groupId: box.groupId,
                            name: box.name,
                            x: event.clientX,
                            y: event.clientY,
                          });
                        }}
                        onDragOver={(event) => {
                          if (!ranking || onJoinGroup === undefined) return;
                          const droppedId = draggingIdRef.current;
                          if (droppedId === null || droppedId === "") return;
                          if (
                            !canJoinGroup(
                              droppedId,
                              box.groupId,
                              groupBoxOf ?? EMPTY_GROUP_BOXES,
                              boxedUnitIds.has(droppedId),
                            )
                          ) {
                            return;
                          }
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                          setJoinHoverId(box.groupId);
                        }}
                        onDragLeave={(event) => {
                          // Same contains() guard the card slots run: the
                          // promise dies only when the hover truly left.
                          const into = event.relatedTarget;
                          if (into instanceof Node && event.currentTarget.contains(into)) return;
                          setJoinHoverId((current) => (current === box.groupId ? null : current));
                        }}
                        onDrop={(event) => {
                          if (!ranking || onJoinGroup === undefined) return;
                          const droppedId = draggedIdFor(event, draggingIdRef.current);
                          if (
                            droppedId === "" ||
                            !canJoinGroup(
                              droppedId,
                              box.groupId,
                              groupBoxOf ?? EMPTY_GROUP_BOXES,
                              boxedUnitIds.has(droppedId),
                            )
                          ) {
                            return; // unclaimed: the column's own drop path decides
                          }
                          // Claim the drop so the column's append or
                          // state-change path stays out of a join write.
                          event.preventDefault();
                          event.stopPropagation();
                          setJoinHoverId(null);
                          onJoinGroup(droppedId, box.groupId);
                        }}
                      >
                        <div
                          data-collapsed-group-card={box.groupId}
                          data-collapsed-group-join-hover={joinHoverId === box.groupId ? "" : undefined}
                          data-transport-fade={
                            boxArrivalFor(box.groupId) !== undefined &&
                            !prefersReducedMotion
                              ? ""
                              : undefined
                          }
                          style={
                            boxArrivalFor(box.groupId) !== undefined &&
                            !prefersReducedMotion
                              ? { opacity: 0 }
                              : undefined
                          }
                          ref={(el) => {
                            const boxArrival = boxArrivalFor(box.groupId);
                            if (boxArrival !== undefined && el !== null && !prefersReducedMotion) {
                              transportElsRef.current.set(
                                `arrival:${boxArrival.threadId}@${boxArrival.gen}`,
                                el,
                              );
                            }
                          }}
                          onClick={(event) => {
                            if (onHighlightGroup === undefined) return;
                            const target = event.target instanceof Element ? event.target : null;
                            if (target === null) return;
                            // The card's own controls keep their clicks (the
                            // toggle and the dot strip) — they never toggle
                            // the highlight.
                            if (
                              target.closest(
                                "[data-collapsed-group-toggle], [data-collapsed-group-dots]",
                              ) !== null
                            ) {
                              return;
                            }
                            onHighlightGroup(
                              highlightedGroupId === box.groupId ? null : box.groupId,
                            );
                          }}
                          className={cn(
                            // A NORMAL card's shape (the thread card's own
                            // rounded-md + bg-card), with the box's dashed
                            // border: the fold never reads as a real card.
                            "relative rounded-md border border-dashed border-muted-foreground/50 bg-card px-2.5 py-1.5",
                            // The join hover reads amber like the box's.
                            joinHoverId === box.groupId &&
                              "ring-2 ring-amber-500/80 border-amber-500/70",
                            // The clicked group's frames stay amber in every
                            // lane; a folded frame draws them too.
                            highlightedGroupId === box.groupId &&
                              "border-amber-500 bg-amber-500/5 ring-2 ring-amber-500/60",
                          )}
                        >
                          <button
                            type="button"
                            data-collapsed-group-toggle={box.groupId}
                            aria-expanded={false}
                            aria-label={`Expand group ${box.name}`}
                            title={`Feature group “${box.name}” — click to expand the member cards; drag this card to move the whole group; drop a card on it to join the group`}
                            onClick={(event) => {
                              event.stopPropagation();
                              onGroupCollapsedChange?.(box.groupId, false);
                            }}
                            className={cn(
                              "flex max-w-full items-center gap-1.5 rounded-sm py-0.5 pr-1.5 text-xs text-foreground",
                              "transition-colors hover:bg-accent/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            )}
                          >
                            <Icon name="ChevronRight" className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                            <span className="truncate font-medium">{box.name}</span>
                            <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
                              {box.members.length} {box.members.length === 1 ? "thread" : "threads"}
                            </span>
                          </button>
                          <button
                            type="button"
                            data-collapsed-group-dots={box.groupId}
                            aria-label={`Expand group ${box.name}`}
                            title="Show the group's member cards"
                            onClick={(event) => {
                              event.stopPropagation();
                              onGroupCollapsedChange?.(box.groupId, false);
                            }}
                            className={cn(
                              "mt-1 flex max-w-full flex-wrap items-center gap-1 rounded-sm py-0.5",
                              "transition-colors hover:bg-accent/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            )}
                          >
                            {box.members.map((member) => {
                              const state = threadState(member);
                              // The rate pulse (issue #279): a working member's
                              // dot breathes at its measured burn, base period
                              // when unmeasured. Attention dots keep their own
                              // animation; both ride the visible-only gate.
                              const pulsePeriod =
                                state === "working"
                                  ? pulsePeriodMs(pulseRateFor?.(member.id) ?? null)
                                  : null;
                              const animated = state === "attention" || pulsePeriod !== null;
                              return (
                                <span
                                  key={member.id}
                                  ref={animated ? attentionPulseRef : undefined}
                                  data-collapsed-group-dot=""
                                  data-dot-pulse={
                                    pulsePeriod === null ? undefined : String(pulsePeriod)
                                  }
                                  style={pulsePeriod === null ? undefined : dotPulseStyle(pulsePeriod)}
                                  title={`${member.displayTitle} · ${THREAD_STATE_LABELS[state] ?? state}`}
                                  className={cn(
                                    "size-1.5 rounded-full",
                                    DOT_CLASS[state] ?? "bg-muted-foreground/30",
                                    state === "attention" && "motion-safe:animate-pulse",
                                  )}
                                />
                              );
                            })}
                          </button>
                        </div>
                        {/* The arrival's glint layer rides the slot li —
                            a sibling of the fading dashed card, so the amber
                            sparks never inherit its dissolve opacity. */}
                        {transportSparksOn &&
                        boxArrivalFor(box.groupId) !== undefined ? (
                          <TransportSparkLayer phaseMs={paceMs(TRANSPORT_WIPE_IN_MS)} tone="in" />
                        ) : null}
                      </li>
                    );
                  };
                  const renderRun = (runItem: GroupRunItem) => {
                    if (runItem.kind === "box" && boxCollapseFolds(runItem.box)) {
                      return renderCollapsedBoxRun(runItem.box);
                    }
                    return runItem.kind === "single" ? (
                      threadLi(runItem.thread)
                    ) : (
                      <li
                        // One box run per group per lane: the gather walk
                        // never emits a second slice of the same group here,
                        // so the group id alone is the slot key.
                        key={`group:${runItem.box.groupId}`}
                        data-group-box={runItem.box.groupId}
                        data-transport-arrival={
                          boxArrivalFor(runItem.box.groupId) ? "wiping-in" : undefined
                        }
                        style={
                          boxArrivalFor(runItem.box.groupId) !== undefined &&
                          !prefersReducedMotion
                            ? // Clipped shut until the grow animation opens
                              // the space it needs — the fade no longer rides
                              // here: it claims the dashed container inside
                              // (data-transport-fade), so the glint layer, a
                              // sibling of that container, keeps full
                              // brightness through the whole arrival.
                              horizontalLanes
                              ? { maxWidth: "0px", overflow: "hidden" }
                              : { maxHeight: "0px", overflow: "hidden" }
                            : undefined
                        }
                        ref={(el) => {
                          const arriving = boxArrivalFor(runItem.box.groupId);
                          if (arriving !== undefined) {
                            transportElsRef.current.set(
                              `slot:${arriving.threadId}@${arriving.gen}`,
                              el,
                            );
                          }
                        }}
                        className={cn(
                          "relative",
                          horizontalLanes ? "ml-1.5 shrink-0" : "mt-1.5",
                        )}
                        onContextMenu={(event) => {
                          // The box context menu covers the box's own
                          // surface — label, padding, gaps, and the group
                          // shape. A member card opens its own menu (the
                          // card wrapper stops this event's propagation
                          // first), and a card's menu must never also open
                          // this box's. With no group capability wired the
                          // surface opens nothing.
                          if (
                            onNewThreadInGroup === undefined &&
                            onZoomToGroup === undefined &&
                            onRenameGroup === undefined &&
                            onDeleteGroup === undefined &&
                            onGroupCollapsedChange === undefined
                          ) {
                            return;
                          }
                          event.preventDefault();
                          setGroupMenuUngroupArmed(false);
                          setGroupMenu({
                            groupId: runItem.box.groupId,
                            name: runItem.box.name,
                            x: event.clientX,
                            y: event.clientY,
                          });
                        }}
                            onDragOver={(event) => {
                              if (!ranking || onJoinGroup === undefined) return;
                              // Every surface inside the dashed outline joins:
                              // label, padding, gaps, and the member cards
                              // themselves (via memberEdgeDefersToJoin). A tall
                              // member — a parent family's card, child rows and
                              // all — used to cover nearly the whole box, so
                              // the visible target advertised join and offered
                              // none of it. Over a member card, a cross-lane
                              // drag keeps the card's own gestures and never
                              // arms the box; the same-lane middle third is the
                              // nest zone and it also stays the card's.
                              const target = event.target instanceof Element ? event.target : null;
                              const memberEl = target?.closest("[data-group-box-member]") ?? null;
                              const droppedId = draggingIdRef.current;
                              if (droppedId === null || droppedId === "") return;
                              if (!canJoinGroup(droppedId, runItem.box.groupId, groupBoxOf ?? EMPTY_GROUP_BOXES, boxedUnitIds.has(droppedId))) return;
                              if (memberEl !== null) {
                                if (!isLaneDrag(event.dataTransfer.types, rankKey)) return;
                                const memberZone = dropZoneFor(
                                  event,
                                  droppedId,
                                  memberEl.getAttribute("data-rank-slot") ?? "",
                                  memberEl,
                                );
                                if (memberZone === "onto") {
                                  // The nest hover owns the card now; the box
                                  // must drop its own promise, not double-glow.
                                  setJoinHoverId((current) =>
                                    current === runItem.box.groupId ? null : current,
                                  );
                                  return;
                                }
                              }
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "move";
                              setJoinHoverId(runItem.box.groupId);
                            }}
                            onDragLeave={(event) => {
                              // Same contains() guard the card slots run: the
                              // promise dies only when the hover truly left.
                              const into = event.relatedTarget;
                              if (into instanceof Node && event.currentTarget.contains(into)) return;
                              setJoinHoverId((current) => (current === runItem.box.groupId ? null : current));
                            }}
                            onDrop={(event) => {
                              if (!ranking || onJoinGroup === undefined) return;
                              const target = event.target instanceof Element ? event.target : null;
                              const memberEl = target?.closest("[data-group-box-member]") ?? null;
                              if (memberEl !== null) {
                                // A member-surface drop reaches the container
                                // only when the member's handlers stepped aside
                                // (a same-lane edge with a live join — see
                                // memberEdgeDefersToJoin). Re-read the live zone
                                // off the payload: the pointer can have settled
                                // somewhere else since the hover armed the ring.
                                // Never a cross-lane member drop, never the nest
                                // third — those the member keeps.
                                const probeId = draggedIdFor(event, draggingIdRef.current);
                                const memberZone = dropZoneFor(
                                  event,
                                  probeId,
                                  memberEl.getAttribute("data-rank-slot") ?? "",
                                  memberEl,
                                );
                                if (
                                  !isLaneDrag(event.dataTransfer.types, rankKey) ||
                                  memberZone === "onto"
                                ) {
                                  return;
                                }
                              }
                              const droppedId = draggedIdFor(event, draggingIdRef.current);
                              if (
                                droppedId === "" ||
                                !canJoinGroup(droppedId, runItem.box.groupId, groupBoxOf ?? EMPTY_GROUP_BOXES, boxedUnitIds.has(droppedId))
                              ) {
                                return; // unclaimed: the column's own drop path decides
                              }
                              // Claim the drop so the column's append or
                              // state-change path stays out of a join write.
                              event.preventDefault();
                              event.stopPropagation();
                              setJoinHoverId(null);
                              onJoinGroup(droppedId, runItem.box.groupId);
                            }}
                          >
                            <div
                              data-group-box-join-hover={joinHoverId === runItem.box.groupId ? "" : undefined}
                              data-group-box-highlight={
                                highlightedGroupId === runItem.box.groupId ? "" : undefined
                              }
                              data-transport-fade={
                                boxArrivalFor(runItem.box.groupId) !== undefined &&
                                !prefersReducedMotion
                                  ? ""
                                  : undefined
                              }
                              style={
                                boxArrivalFor(runItem.box.groupId) !== undefined &&
                                !prefersReducedMotion
                                  ? { opacity: 0 }
                                  : undefined
                              }
                              ref={(el) => {
                                const boxArrival = boxArrivalFor(runItem.box.groupId);
                                if (boxArrival !== undefined && el !== null && !prefersReducedMotion) {
                                  transportElsRef.current.set(
                                    `arrival:${boxArrival.threadId}@${boxArrival.gen}`,
                                    el,
                                  );
                                }
                              }}
                              className={cn(
                                "relative rounded-lg border border-dashed border-muted-foreground/50 px-1 pt-4 pb-0.5",
                                // The join hover reads amber like the other
                                // family writes (the nest zone), never like
                                // the lane-colored insertion line.
                                joinHoverId === runItem.box.groupId &&
                                  "ring-2 ring-amber-500/80 border-amber-500/70",
                                // The clicked group's frames: amber in EVERY
                                // lane the group renders in (issue #86) —
                                // the operator's one-click look-at-the-whole-
                                // footprint affordance.
                                highlightedGroupId === runItem.box.groupId &&
                                  "border-amber-500 bg-amber-500/5 ring-2 ring-amber-500/60",
                              )}
                              onClick={(event) => {
                                if (onHighlightGroup === undefined) return;
                                const target = event.target instanceof Element ? event.target : null;
                                if (target === null) return;
                                // The label's own controls keep their clicks
                                // (rename editor, ungroup) — they never toggle
                                // the highlight.
                                if (
                                  target.closest(
                                    "[data-group-box-label], [data-group-rename-input], [data-group-label-delete]",
                                  ) !== null
                                ) {
                                  return;
                                }
                                if (target.closest("[data-group-box-member]") !== null) {
                                  // A member card's click (the same click opens
                                  // the pane) marks the card's group everywhere.
                                  onHighlightGroup(runItem.box.groupId);
                                  return;
                                }
                                // The frame's own surface toggles its highlight.
                                onHighlightGroup(
                                  highlightedGroupId === runItem.box.groupId ? null : runItem.box.groupId,
                                );
                              }}
                            >
                              {renamingBoxId === runItem.box.groupId ? (
                                <div className="absolute -top-2.5 left-3 z-20 flex items-center gap-0.5 rounded-sm bg-muted px-0.5">
                                  <input
                                    type="text"
                                    key={`rename:${runItem.box.groupId}`}
                                    defaultValue={runItem.box.name}
                                    autoFocus
                                    data-group-rename-input={runItem.box.groupId}
                                    aria-label={`Rename group, was ${runItem.box.name}`}
                                    maxLength={80}
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter") {
                                        commitLabelRename(
                                          runItem.box.groupId,
                                          event.currentTarget.value,
                                          runItem.box.name,
                                        );
                                      } else if (event.key === "Escape") {
                                        closeLabelEditor();
                                      }
                                  }}
                                  onBlur={(event) =>
                                    blurLabelRename(
                                      runItem.box.groupId,
                                      event.currentTarget.value,
                                      runItem.box.name,
                                    )
                                  }
                                  className="h-[18px] w-40 rounded-sm border border-input bg-muted px-1 text-[10.5px] leading-none outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                  />
                                  {onDeleteGroup !== undefined ? (
                                    <button
                                      type="button"
                                      data-group-label-delete={runItem.box.groupId}
                                      data-armed={labelDeleteArmed ? "true" : "false"}
                                      // The act is UNGROUP, not delete: the
                                      // group record and the assignments go,
                                      // the threads keep their cards — the
                                      // icon and the label both say it.
                                      title={
                                        labelDeleteArmed
                                          ? `Removes the group for all members — the threads stay on the board. Click again to confirm.`
                                          : `Ungroup all members (the threads stay on the board)`
                                      }
                                      // Keep the input focused: a plain mousedown
                                      // would blur it BEFORE the click lands and
                                      // the unmounted editor would swallow it.
                                      onMouseDown={(event) => event.preventDefault()}
                                      onClick={() => {
                                        if (!labelDeleteArmed) {
                                          setLabelDeleteArmed(true);
                                          return;
                                        }
                                        onDeleteGroup(runItem.box.groupId);
                                        closeLabelEditor();
                                      }}
                                      className={cn(
                                        "flex h-5 items-center justify-center gap-1 rounded-sm px-1 text-[10px] font-medium transition-colors",
                                        labelDeleteArmed
                                          ? "bg-destructive text-destructive-foreground"
                                          : "text-muted-foreground hover:text-destructive",
                                      )}
                                    >
                                      <Icon name="Ungroup" className="size-3" aria-hidden />
                                      {labelDeleteArmed ? <span>Ungroup</span> : null}
                                      <span className="sr-only">
                                        {labelDeleteArmed
                                          ? "Ungroup (click again to confirm)"
                                          : "Ungroup all members"}
                                      </span>
                                    </button>
                                  ) : null}
                                </div>
                              ) : onRenameGroup !== undefined ? (
                                <div className="absolute -top-2 left-3 z-10 flex items-center gap-0.5">
                                  <button
                                    type="button"
                                    data-group-box-label={runItem.box.groupId}
                                    title={`Feature group “${runItem.box.name}” — click to rename; drag this label or any member to move the whole box; drop a card on this box to join the group`}
                                    draggable
                                    onDragStart={(event) => beginBoxLabelDrag(event, runItem.box)}
                                    onDragEnd={() => rankDragLifecycle(null)}
                                    onClick={() => startLabelRename(runItem.box.groupId)}
                                    className={cn(
                                      "max-w-48 truncate rounded-sm bg-muted px-1 text-left text-[10.5px] leading-[14px] text-muted-foreground hover:text-foreground",
                                      highlightedGroupId === runItem.box.groupId
                                        ? "text-amber-600 dark:text-amber-400"
                                        : undefined,
                                    )}
                                  >
                                    {runItem.box.name}
                                  </button>
                                  {boxCollapseChevron(runItem.box)}
                                </div>
                              ) : (
                                <div className="absolute -top-2 left-3 z-10 flex items-center gap-0.5">
                                  <span
                                    data-group-box-label={runItem.box.groupId}
                                    title={`Feature group “${runItem.box.name}” — drag this label or any member to move the whole box; drop a card on this box to join the group`}
                                    draggable
                                    onDragStart={(event) => beginBoxLabelDrag(event, runItem.box)}
                                    onDragEnd={() => rankDragLifecycle(null)}
                                    className={cn(
                                      "rounded-sm bg-muted px-1 text-[10.5px] leading-[14px] text-muted-foreground",
                                      highlightedGroupId === runItem.box.groupId
                                        ? "text-amber-600 dark:text-amber-400"
                                        : undefined,
                                    )}
                                  >
                                    {runItem.box.name}
                                  </span>
                                  {boxCollapseChevron(runItem.box)}
                                </div>
                              )}
                              <ul className={cn("flex gap-1.5", horizontalLanes ? "flex-row" : "flex-col")}>
                                {runItem.box.members.map((boxMember, memberIndex) =>
                                  threadLi(
                                    boxMember,
                                    memberIndex === 0
                                      ? "first"
                                      : memberIndex === runItem.box.members.length - 1
                                        ? "last"
                                        : "mid",
                                  ),
                                )}
                              </ul>
                            </div>
                            {/* The arrival's glint layer rides the slot li —
                                a sibling of the fading dashed container, so
                                the amber sparks never inherit its dissolve
                                opacity and shine for the whole arrival. */}
                            {transportSparksOn &&
                            boxArrivalFor(runItem.box.groupId) !== undefined ? (
                              <TransportSparkLayer phaseMs={paceMs(TRANSPORT_WIPE_IN_MS)} tone="in" />
                            ) : null}
                          </li>
                    );
                  };
                  return (
                    <ul className={cn("flex gap-1.5", horizontalLanes ? "flex-row" : "flex-col")}>
                      {insertGhostSlots(columnRuns, laneOutGhosts).map((entry) =>
                        entry.kind === "ghost"
                          ? entry.ghost.members !== undefined
                            ? // A run transport: the dashed container itself
                              // is the ghost (one box-shaped dissolve).
                              ghostRunLi(entry.ghost)
                            : // The card ghost renders through threadLi with
                              // the planner's PRE-move snapshot: the visuals
                              // the card had, inert (aria-hidden, inert,
                              // pointer-events-none) while the wipe-out and
                              // collapse play over it.
                              threadLi(entry.ghost.thread, undefined, {
                                play: entry.ghost,
                              })
                          : renderRun(entry.run),
                      )}
                    </ul>
                  );
                })()}
                {column.id === "working" ? (
                  <button
                    type="button"
                    onClick={onNewTask}
                    className={cn(
                      // A slot of its own, on either axis: below the Working
                      // stack (vertical) or beside it in the row's flow
                      // (horizontal).
                      horizontalLanes
                        ? "ml-1.5 flex w-60 shrink-0 items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-3 py-2"
                        : "mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-3 py-2",
                      "text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                  >
                    <Icon name="Plus" className="size-3.5" aria-hidden />
                    New Task
                  </button>
                ) : null}
              </div>
            </section>
          );
        })}
        </div>
      </div>
      {groupMenu !== null ? (
        <MenuPopover
          open={groupMenu}
          onClose={closeGroupMenu}
          label="Group actions"
          title={groupMenu.name}
        >
          {groupBoxMenuActions({
            armed: groupMenuUngroupArmed,
            spawn:
              onNewThreadInGroup === undefined
                ? undefined
                : () => {
                    const groupId = groupMenu.groupId;
                    closeGroupMenu();
                    onNewThreadInGroup(groupId);
                  },
            rename:
              onRenameGroup === undefined
                ? undefined
                : () => {
                    const groupId = groupMenu.groupId;
                    closeGroupMenu();
                    startLabelRename(groupId);
                  },
            zoom:
              onZoomToGroup === undefined
                ? undefined
                : () => {
                    const groupId = groupMenu.groupId;
                    closeGroupMenu();
                    onZoomToGroup(groupId);
                  },
            collapse:
              onGroupCollapsedChange === undefined
                ? undefined
                : {
                    collapsed: collapsedGroupIds?.has(groupMenu.groupId) ?? false,
                    toggle: () => {
                      const groupId = groupMenu.groupId;
                      const wasCollapsed = collapsedGroupIds?.has(groupId) ?? false;
                      closeGroupMenu();
                      onGroupCollapsedChange(groupId, !wasCollapsed);
                    },
                  },
            ungroup:
              onDeleteGroup === undefined
                ? undefined
                : () => {
                    if (!groupMenuUngroupArmed) {
                      setGroupMenuUngroupArmed(true);
                      return; // the menu stays open for the confirm
                    }
                    const groupId = groupMenu.groupId;
                    closeGroupMenu();
                    onDeleteGroup(groupId);
                  },
          }).map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              onClick={action.run}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent",
                action.danger && "text-destructive",
              )}
            >
              <Icon name={action.icon} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              {action.label}
            </button>
          ))}
        </MenuPopover>
      ) : null}
    </div>
  );
}

/**
 * jsdom (the test environment) does not implement `CSS.escape`; real
 * browsers do. Column ids are code constants (done, awhile), so the
 * fallback is exact for them and safe for anything else.
 */
function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

/**
 * Disarm an armed sweep when the operator clicks anywhere else. Clicks on
 * cards inside the armed lane do NOT disarm: in sweep mode those clicks
 * toggle the card's selection. The sweep button, the cancel button, the
 * armed lane's cards, and Escape are the only surfaces that keep the mode
 * alive; anything else (empty board area, another lane, a header) ends it.
 *
 * The armed scope is either a Focus-view column (`[data-column-id]` around
 * its cards) or a Parent-view row (`[data-sweep-row]`, worn by every lane's
 * band for that row) — the id is the same column/row vocabulary either way,
 * so one hook serves both boards.
 */
export function useSweepClickAway(
  armedColumnId: string | null,
  onDisarm: () => void,
): void {
  useEffect(() => {
    if (armedColumnId === null) return;
    const scopeId = cssEscape(armedColumnId);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-sweep-button], [data-sweep-cancel]")) return;
      if (
        target.closest(`[data-column-id="${scopeId}"] [data-thread-card]`) !== null ||
        target.closest(`[data-sweep-row="${scopeId}"] [data-thread-card]`) !== null
      ) {
        return;
      }
      onDisarm();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDisarm();
    };
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    document.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
      document.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [armedColumnId, onDisarm]);
}
