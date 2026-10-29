import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type {
  BoardColumn,
  FilterState,
  GroupBy,
  GroupingContext,
  ThreadState,
} from "./grouping";
import {
  STATUS_COLUMN_ORDER,
  buildColumns,
  columnFor,
  derivedCompare,
  doneRecencyCompare,
  groupBucketFor,
  groupFilterMisses,
  threadPassesFilter,
  threadState,
} from "./grouping";
import {
  applySlotPins,
  pinRowOrder,
  type AttentionFreezePlan,
} from "./attention-freeze";
import {
  childRankKey,
  columnRankKey,
  compareByRank,
  orderForColumn,
  type RankStore,
} from "../lib/rank";
import type { TicketRef } from "../lib/tickets";

export interface FamilyIndex {
  /** Parent id → its non-archived children, in input order. Keys carry every
   * displayed parent: family roots and (post-cap, issue #120) the child rows
   * that render their own sub-rows. */
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  /** Child id → its parent's id; absent for roots (including cycle members and orphans). */
  parentOf: ReadonlyMap<string, string>;
  /**
   * Child id → its RAW parent id — before the display depth cap
   * (rows carry one sub-tier; deeper members re-home onto the family root).
   * The re-parent guard must walk real chains (a grandchild onto its
   * grandparent is a change, not a no-op), so the displayed map cannot serve
   * there.
   */
  rawParentOf: ReadonlyMap<string, string>;
  /** Visible threads that are not nested under any parent, in input order. */
  rootIds: ReadonlySet<string>;
}

export interface NestingResult {
  columns: BoardColumn[];
  /** Parent id → the live children that render nested under its card. */
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  /**
   * Parent id → the done children that render nested under the family's
   * projection card in the Done column. Only live parents get entries: a
   * done parent's done children nest via `childrenByParent` under the
   * parent's own Done card.
   */
  doneChildrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>;
}

export interface BoardAssembly {
  columns: BoardColumn[];
  /** Parent id → children that render as nested rows under the parent card. */
  nestedChildrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  /** Parent id → done children nested under the family's Done projection card. */
  doneChildrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  /**
   * Parent id → the number the card's child-count chip shows: the children
   * in the card's OWN space. A live parent counts its live children (nested
   * rows plus any that render standalone in the active space); a done parent
   * counts the rows its Done card carries. A family split across spaces — a
   * live card plus its Done projection — reads one count per card, and the
   * two sum to the family size. Empty when nesting is disabled — chips are
   * meaningless on a flat board.
   */
  childCountByParent: ReadonlyMap<string, number>;
}

export interface NestingOptions {
  /**
   * R3 "Nest child threads" toggle. `false` renders a fully flat board:
   * every visible (non-archived) thread is a standalone card in its own
   * column slot, no promotion logic, no nested rows, no chips, no `+N` —
   * and archived children do not render at all (they can never be
   * standalone). Default `true`.
   */
  nestingEnabled?: boolean;
  /**
   * Manual column orders, keyed by `columnRankKey`. Threaded into column
   * building AND the nested-sibling sort so a family reads in one order:
   * a parent that honours a rank with children that ignore it is a lie.
   */
  ranks?: RankStore;
  /**
   * Thread id → epoch-ms done stamp, for the done-children rows under a done
   * parent's Done card (newest done first). The Done column itself does not
   * read stamps: the idle sweep marks long-idle threads Done with a fresh
   * stamp, so a stamp-ordered column vaults quiet threads above recently
   * active ones.
   */
  doneTimes?: ReadonlyMap<string, number>;
  /**
   * Threads marked Done. `childPlacement` needs them: a Done parent stays in
   * the Done lane, so a live child always stands alone (same-space rule);
   * its done children nest under its Done card; a live parent's done
   * children project into the Done column.
   */
  doneIds?: ReadonlySet<string>;
  /**
   * Clear-error acknowledgment ids (issue #157, lib/error-ack-metadata):
   * threads whose error signals the operator acknowledged. Acked error arms
   * read quiet — childPlacement re-nests, family drive rules skip them.
   */
  errorAcks?: ReadonlySet<string>;
  /**
   * Jira on: threads with a Jira reason line, laned as Needs you
   * (buildColumns). Family rules (R4, nesting) do not read it.
   */
  // ponytail: lane placement only; a nested child with a reason stays nested. Thread it through familyColumnOverrides/childPlacement if that matters.
  needsYou?: ReadonlySet<string>;
  /**
   * The attention freeze (components/attention-freeze): the plan compiled
   * from the captures app.tsx holds for attended cards — the lane pins that
   * win over every claim, the final-list slot pins, and the nested-row
   * pins. Absent → placement rules run untouched (their own behavior).
   */
  attentionFreeze?: AttentionFreezePlan;
}

/**
 * One per-build slot pinning pass over the final rendered lists: the place
 * the assembled board LAST touches order, so the pins reflect what renders —
 * after the nesting drains, the projections' recency sort, and the pinned
 * lane's attention lift.
 */
export function withSlotPins(
  columns: readonly BoardColumn[],
  slots: ReadonlyMap<string, number>,
): BoardColumn[] {
  if (slots.size === 0) return [...columns];
  return columns.map((column) => {
    // The plan's slot pins are keyed column AND thread (slotPinKey); only
    // this column's own entries apply, so a twin card in another lane (a
    // family's Done projection) keeps its own slot.
    const own = new Map<string, number>();
    for (const [key, index] of slots) {
      const separator = key.indexOf("\u0000");
      if (separator === -1 || key.slice(0, separator) !== column.id) continue;
      own.set(key.slice(separator + 1), index);
    }
    if (own.size === 0) return column;
    return { ...column, threads: applySlotPins(column.threads, own) };
  });
}

/**
 * The full columns-plus-nesting assembly the board renders, in one call — the
 * composition app.tsx wires. `nestedChildrenByParent` (from
 * `nestUnderParents`, NOT the raw index) is what renders as child rows, so a
 * promoted (live child of a Done parent) or cross-axis child never appears
 * both as a standalone card and as a nested row. `doneChildrenByParent` is
 * what renders under a family's Done projection card. `childCountByParent`
 * counts each card's own space (see `BoardAssembly`).
 *
 * R4: under the status grouping, `familyColumnOverrides` places each family
 * in the column of its most attention-requiring live member, so the parent
 * card carries the family's urgency and its children nest under it.
 *
 * Archived children are hidden outright: `buildFamilyIndex` excludes
 * archived members, so an archived child renders nowhere and a child of an
 * archived parent re-roots and renders standalone. `buildColumns` also never
 * sees an archived thread.
 */
export function assembleBoard(
  threads: readonly PluginSidebarThread[],
  groupBy: GroupBy,
  context: GroupingContext,
  frozenColumns: ReadonlyMap<string, { id: string; label: string }> = new Map(),
  doneIds: ReadonlySet<string> = new Set(),
  now: number = Date.now(),
  options: NestingOptions = {},
): BoardAssembly {
  const nestingEnabled = options.nestingEnabled ?? true;
  const ranks = options.ranks ?? {};
  // Archived threads never take a column slot; the family index drops them
  // too (buildFamilyIndex is the single authoritative hide), so an archived
  // child renders nowhere at all — matching bb's sidebar, where archiving
  // removes the thread from the list.
  const visible = threads.filter((thread) => !thread.isArchived);
  const attention = options.attentionFreeze;
  const attentionColumns = attention?.columns ?? new Map();
  if (!nestingEnabled) {
    // Flat board: no families, no rows, no chips, no projections. Group
    // boxes ride along untouched (their plan's groupBoxOf goes straight to
    // the board, and the split default claims no lane).
    return {
      columns: withSlotPins(
        buildColumns(
          visible,
          groupBy,
          context,
          frozenColumns,
          doneIds,
          now,
          ranks,
          attentionColumns,
          new Map(),
          undefined,
          options.needsYou,
        ),
        attention?.slots ?? new Map(),
      ),
      nestedChildrenByParent: new Map(),
      doneChildrenByParent: new Map(),
      childCountByParent: new Map(),
    };
  }
  // One family index serves all the passes: the R4 column overrides, the
  // nesting pass, the Done projection, and the chip counts all read the same
  // parent→children map (archived members already excluded by the index).
  const familyIndex = buildFamilyIndex(visible);
  // R4: under the status grouping a family lands in the column of its most
  // attention-requiring live member, so the parent card carries the family's
  // urgency instead of splitting from its children.
  const familyOverrides = familyColumnOverrides(
    visible,
    familyIndex,
    groupBy,
    context,
    doneIds,
    now,
  );
  const nested = nestUnderParents(
    buildColumns(
      visible,
      groupBy,
      context,
      frozenColumns,
      doneIds,
      now,
      ranks,
      familyOverrides,
      attentionColumns,
      options.errorAcks,
      options.needsYou,
    ),
    visible,
    groupBy,
    context,
    now,
    familyIndex,
    // assembleBoard owns doneIds positionally; inject it so childPlacement
    // can keep the Done-lane promotion rule.
    { ...options, doneIds },
  );
  // The chip counts the children in the card's own space, the sub-row tier
  // included (issue #120: a child row nests its own children, and the chip
  // names what the card's rows region — folded when it collapses — carries):
  // rows plus their sub-rows, walking the nesting placement's own map.
  // Members placed elsewhere — a live parent's done children ride the Done
  // space's projection chip — count where they land, not here.
  const countNestedRows = (parentId: string): number => {
    let count = 0;
    for (const member of nested.childrenByParent.get(parentId) ?? []) {
      count += 1 + countNestedRows(member.id);
    }
    return count;
  };
  // A live card's chip keeps the old semantics: ALL visible non-done children
  // count, standalone-rendering members included (a pinned or Needs-you child
  // hides behind the fold too... no — it stands alone; but the chip still
  // names the family's size, as it always has). Done members walk nowhere:
  // they and their done subtrees count on the Done side.
  const countRawFamily = (parentId: string): number => {
    let count = 0;
    for (const member of familyIndex.childrenByParent.get(parentId) ?? []) {
      if (doneIds.has(member.id)) continue;
      count += 1 + countRawFamily(member.id);
    }
    return count;
  };
  const threadById = new Map(visible.map((thread) => [thread.id, thread]));
  const childCountByParent = new Map<string, number>();
  for (const parentId of familyIndex.childrenByParent.keys()) {
    const parent = threadById.get(parentId);
    childCountByParent.set(
      parentId,
      parent !== undefined && doneIds.has(parent.id)
        ? countNestedRows(parentId)
        : countRawFamily(parentId),
    );
  }
  return {
    columns: nested.columns,
    nestedChildrenByParent: nested.childrenByParent,
    doneChildrenByParent: nested.doneChildrenByParent,
    childCountByParent,
  };
}

export interface FamilyFilterResult {
  kept: PluginSidebarThread[];
  /** Members of kept families that do not themselves match the filters. */
  dimmedIds: ReadonlySet<string>;
}

/**
 * Build parent→children / child→parent maps from the thread set. This index
 * is the single authoritative place where archived members are hidden: an
 * archived child is indexed under nothing (it renders nowhere, in either
 * board view), and a child whose parent is archived re-roots — the parent is
 * not "present" — so it renders standalone instead of under a card that
 * never renders. A `parentThreadId` that points at a thread not in the set
 * (deleted) leaves the child a root — flat fallback. Corrupt parent cycles
 * are treated as roots: cycle members keep their cards instead of hanging
 * the board.
 *
 * Depth cap (rows carry one sub-tier): a family card renders child rows, and
 * a child row nests its own children as sub-rows (issue #120 — the context
 * menu's "Will nest under <child>" promise). A member deeper than that
 * re-attaches to its family root, so no display chain exceeds two rows; the
 * raw data is untouched (`rawParentOf` carries the real edges).
 */
export function buildFamilyIndex(threads: readonly PluginSidebarThread[]): FamilyIndex {
  // Archived members are dropped at the door: archived children are hidden
  // outright, and archived parents leave their children rootless.
  const visible = threads.filter((thread) => !thread.isArchived);
  const present = new Set(visible.map((thread) => thread.id));
  const parentOf = new Map<string, string>();

  for (const thread of visible) {
    const parentId = thread.parentThreadId;
    if (parentId === null || parentId === "" || !present.has(parentId)) continue;
    if (parentId === thread.id) continue; // self-parent is corrupt data
    parentOf.set(thread.id, parentId);
  }

  // Defensive cycle pass: a corrupt `parentThreadId` cycle must not hang the
  // board. Detect every member whose parent chain closes back on itself
  // (before any unlinking, so detection is order-independent), then unlink
  // them all so each renders as a root.
  const cyclic = new Set<string>();
  for (const thread of visible) {
    const start = thread.id;
    const walk = new Set<string>([start]);
    let cursor = parentOf.get(start);
    while (cursor !== undefined) {
      if (cursor === start) {
        cyclic.add(start);
        break;
      }
      if (walk.has(cursor)) break; // joins another walk's cycle; it handles itself
      walk.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }
  for (const id of cyclic) parentOf.delete(id);

  const childrenByParent = new Map<string, PluginSidebarThread[]>();
  // Depth cap (rows carry one sub-tier): a child row nests its own children
  // as sub-rows (issue #120 — the "Will nest under <child>" promise), and a
  // member deeper than that re-attaches to its family root, which keeps any
  // display tier at two rows: never hidden behind a `+N more` chip. The
  // flattening above the cap is display-only; the raw edges stay in
  // `rawParentOf`.
  const displayParentOf = new Map(parentOf);
  for (const thread of visible) {
    const chain: string[] = [];
    let cursor = thread.id;
    while (displayParentOf.has(cursor)) {
      chain.push(cursor);
      cursor = displayParentOf.get(cursor) as string;
    }
    // chain[i] sits at real display depth (chain.length - i); the family
    // root is the final `cursor`. Re-root the members of this chain deeper
    // than the sub-row tier: depth ≥ 3 to the root.
    const reattachTo = cursor;
    for (let i = 0; i <= chain.length - 3; i++) {
      displayParentOf.set(chain[i] as string, reattachTo);
    }
  }

  for (const thread of visible) {
    const parentId = displayParentOf.get(thread.id);
    if (parentId === undefined) continue;
    const siblings = childrenByParent.get(parentId);
    if (siblings === undefined) childrenByParent.set(parentId, [thread]);
    else siblings.push(thread);
  }

  const rootIds = new Set(
    visible.filter((thread) => !displayParentOf.has(thread.id)).map((thread) => thread.id),
  );
  return { childrenByParent, parentOf: displayParentOf, rawParentOf: parentOf, rootIds };
}

/**
 * Where does a child render relative to its parent in this grouping? Returns
 * `"nest"` (rows under the parent's own card), `"done"` (rows under the
 * family's projection card in the Done column), or `"flat"` (the child keeps
 * its standalone column placement).
 *
 * The one same-space rule, four steps in order:
 *
 * 1. Done is its own space: a done child paints in the Done space under the
 *    family's card there — the root's own card when the root is done, the
 *    family's projection card when it is live. Done is a projection: the
 *    family's active card and its Done card exist at once.
 * 2. Operator-intent cards stand alone: a pinned child keeps its pin (the
 *    pin badge is not drawn on nested rows), and an attention child (a
 *    pending interaction or an unread error) surfaces as its own actionable
 *    card instead of hiding behind a possibly-folded card. The row returns
 *    to the nest when the reason clears; stayNested holds it while the
 *    attention freeze owns the row.
 * 3. A Done root paints in the Done lane, so no live child shares its
 *    space: every live child of a done root gets its own card (live work
 *    never hides under Done).
 * 4. Otherwise a child nests under its root when both share the view's
 *    space key: Attention (R4 — the family moves as one unit into the
 *    column of its most attention-requiring member, `familyColumnOverrides`),
 *    recency/none (per-thread presentation, not a grouping boundary) share
 *    one key board-wide; project, provider, machine, and the feature-group
 *    assignment are data keys the child must match. A cross-key child stays
 *    flat in its own lane — nesting never rides a member into a group it
 *    does not belong to.
 */
type ChildPlacement = "nest" | "done" | "flat";

function childPlacement(
  child: PluginSidebarThread,
  parent: PluginSidebarThread,
  groupBy: GroupBy,
  groupContext: GroupingContext,
  doneIds: ReadonlySet<string>,
  /**
   * The attention freeze's stay-nested set (components/attention-freeze): a
   * nested child the operator is attending to does NOT un-nest on a fresh
   * attention flip — the operator is looking at its row, and the card must
   * not move. Attention surfaces through the row's own state treatment;
   * the un-nest happens the moment attention releases.
   */
  stayNested: ReadonlySet<string> = new Set<string>(),
  /** Clear-error acknowledgment ids (issue #157): acked error arms stay quiet. */
  errorAcks: ReadonlySet<string> = new Set<string>(),
): ChildPlacement {
  // Step 1: done is its own space.
  if (doneIds.has(child.id)) {
    return doneIds.has(parent.id) ? "nest" : "done";
  }
  // Step 2: operator-intent cards stand alone.
  if (child.isPinned) {
    return "flat";
  }
  if (threadState(child, errorAcks) === "attention" && !stayNested.has(child.id)) {
    return "flat";
  }
  // Step 3: a Done root shares its space with no live child.
  if (doneIds.has(parent.id)) {
    return "flat";
  }
  // Step 4: same space key as the root nests; a different key stays flat.
  if (groupBy === "project" || groupBy === "provider") {
    const key = groupBy === "project" ? child.projectId : child.providerId;
    const parentKey = groupBy === "project" ? parent.projectId : parent.providerId;
    return key === parentKey ? "nest" : "flat";
  }
  if (groupBy === "machine") {
    return (child.host?.id ?? "none") === (parent.host?.id ?? "none") ? "nest" : "flat";
  }
  if (groupBy === "group") {
    return groupBucketFor(child, groupContext.groupsByThread) ===
      groupBucketFor(parent, groupContext.groupsByThread)
      ? "nest"
      : "flat";
  }
  return "nest"; // status (R4: the family moves as one unit) / recency / none
}

/**
 * Would a drop-to-nest of `child` under `parent` write a card the placement
 * rules keep standing alone — a nest whose result the board cannot show?
 *
 * The board offers the middle-third nest zone over every pair the loop and
 * already-child guards allow — but a pair whose `childPlacement` comes back
 * "flat" renders that write invisible: a pinned child stands alone in its
 * own slot (step 2), an attention child surfaces as its own card (step 2), a
 * live child of a Done root keeps its own lane (step 3), and a cross-space
 * child stays outside the family's column (step 4's data keys). The drop
 * still fires the re-parent write — and the placement rule is on purpose
 * (a pinned card must never hide behind a folded family's card) — but the
 * gesture's one visible outcome is NOTHING unless the board says so: the
 * caller answers this and prints the reason in a notice, naming the undo
 * ("Make Top-Level" in the card menu). The silent version shipped twice:
 * reported 2026-10-15/16, a re-parent and a refusal both read as the board
 * ignoring the operator.
 *
 * The "group" view's assignment buckets are host data the board's own
 * groupBoxOf plan prunes (pinned/done members drop out of the plan), so
 * that one grouping cannot answer here: it reads as a visible nest.
 */
export function flatNestReason(
  child: PluginSidebarThread,
  parent: PluginSidebarThread,
  groupBy: GroupBy,
  doneIds: ReadonlySet<string>,
  errorAcks: ReadonlySet<string> = new Set<string>(),
): string | null {
  // Step 1: a done child paints in the Done space under the family's Done
  // presence either way ("done" under a live root, "nest" under a done one).
  if (doneIds.has(child.id)) return null;
  // Step 2: operator-intent cards stand alone — the write hides exactly.
  if (child.isPinned) return "a pinned card keeps its own card and slot";
  // Step 2 again, attention: the child surfaces as its own card. The
  // attention freeze's stayNested exemption is host to the assembly, not
  // the board, so this answer is conservative: a row the operator is
  // attending keeps its slot today, and the notice fires anyway — its
  // card's placement is the assembly's call, never the drop's.
  if (threadState(child, errorAcks) === "attention") {
    return "the card needs your attention, so it surfaces on its own";
  }
  // Step 3: a Done root shares its space with no live child.
  if (doneIds.has(parent.id)) return "a Done card hosts no live child rows";
  // Step 4's data keys: a cross-space child nests for the family index but
  // renders in its own lane — the write hides.
  if (groupBy === "project" && child.projectId !== parent.projectId) {
    return "the card belongs to another project's lane";
  }
  if (groupBy === "provider" && child.providerId !== parent.providerId) {
    return "the card belongs to another provider's lane";
  }
  if (groupBy === "machine") {
    return (child.host?.id ?? "none") === (parent.host?.id ?? "none")
      ? null
      : "the card belongs to another machine's lane";
  }
  return null;
}

function stateRank(state: ThreadState): number {
  const index = STATUS_COLUMN_ORDER.indexOf(state);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * The family members that drive a family's lane. The operator's rule (the
 * family is the unit of visibility): the most attention-driving member wins
 * for the whole family. The root always drives — its own attention lifts,
 * and under the recency grouping its own freshness is the floor. A
 * descendant drives only while it renders inside the family card: a child
 * copied OUT to its own lane — a Needs-you child standing alone, a done
 * child in the Done projection, a pinned child in Pinned — keeps that
 * placement and does not drive (copy-out is dual membership, not removal).
 * Archived descendants render nowhere and never drive.
 *
 * Walk order is root first, then descendants; both lane picks below break
 * ties toward the earlier entry, so an all-idle family keeps the root's own
 * bucket and a child only lifts when it strictly beats what came before it.
 */
export function familyDriveMembers(
  rootId: string,
  byId: ReadonlyMap<string, PluginSidebarThread>,
  familyIndex: FamilyIndex,
  doneIds: ReadonlySet<string>,
  errorAcks: ReadonlySet<string> = new Set<string>(),
): PluginSidebarThread[] {
  const drive: PluginSidebarThread[] = [];
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const member = byId.get(id);
    if (member === undefined || member.isArchived) continue;
    if (member.id === rootId || familyRowMember(member, doneIds, errorAcks)) {
      drive.push(member);
    }
    for (const child of familyIndex.childrenByParent.get(id) ?? []) {
      stack.push(child.id);
    }
  }
  return drive;
}

/**
 * The members that render as the family card's own rows (the same
 * exclusions `childPlacement` applies before its space-key step: done has
 * its own space, a pinned child keeps its pin, an attention child
 * stands alone). `familyDriveMembers` reads it to build the drive set;
 * keep the two in step — a row member a placement rule dropped must not
 * drive the family's lane.
 */
function familyRowMember(
  member: PluginSidebarThread,
  doneIds: ReadonlySet<string>,
  errorAcks: ReadonlySet<string> = new Set<string>(),
): boolean {
  return !doneIds.has(member.id) && !member.isPinned && threadState(member, errorAcks) !== "attention";
}

function driveElevates(
  a: PluginSidebarThread,
  b: PluginSidebarThread,
  groupBy: GroupBy,
  errorAcks: ReadonlySet<string> = new Set<string>(),
): boolean {
  if (groupBy === "recency") return a.updatedAt > b.updatedAt;
  return stateRank(threadState(a, errorAcks)) < stateRank(threadState(b, errorAcks));
}

/**
 * R4: under the status grouping, where should each family land? The family
 * (a root and its nested descendants) appears in the column of its most
 * attention-requiring nested member — the smallest state rank across the
 * family's drive set (`familyDriveMembers`: the root plus every descendant
 * that still renders inside the family card). The root's OWN attention
 * always lifts. Under the recency grouping the same drive set scores by
 * freshness instead: the newest updatedAt in the family carries the family's
 * bucket, so a child's fresh activity lifts a stale parent the same way a
 * running child lifts the status lane. The returned map is keyed by family
 * ROOT id, so only roots — the cards that take column slots — read it;
 * promoted children of Done parents and axis-flat children keep their own
 * placements.
 *
 * Under the status grouping an all-idle family gets no entry:
 * `threadState` collapses idle to a rank no member can win with, so the
 * family keeps the parent's own bucket. Under recency the root's own
 * freshness is the floor, so the entry (when any) names a bucket at least
 * as fresh as the parent's own. The parent card's raw state badge is
 * untouched: this is a placement rule, not a state rewrite.
 */
export function familyColumnOverrides(
  threads: readonly PluginSidebarThread[],
  familyIndex: FamilyIndex,
  groupBy: GroupBy,
  context: GroupingContext,
  doneIds: ReadonlySet<string>,
  now: number = Date.now(),
  errorAcks: ReadonlySet<string> = new Set<string>(),
): ReadonlyMap<string, { id: string; label: string }> {
  if (groupBy !== "status" && groupBy !== "recency") return new Map();
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const overrides = new Map<string, { id: string; label: string }>();
  for (const rootId of familyIndex.rootIds) {
    const root = byId.get(rootId);
    if (root === undefined || root.isArchived || doneIds.has(rootId)) continue;
    const best = bestFamilyDriver(rootId, byId, familyIndex, doneIds, groupBy, errorAcks);
    if (best === undefined) continue;
    // Under the status grouping an all-idle drive set names no lane (idle
    // ranks below every state that can demand a column move): the family
    // keeps the parent's own bucket, so no entry.
    if (groupBy === "status" && stateRank(threadState(best, errorAcks)) === Number.MAX_SAFE_INTEGER) {
      continue;
    }
    overrides.set(rootId, columnFor(best, groupBy, context, now, errorAcks));
  }
  return overrides;
}

/** The drive-set member that carries the family's lane under `groupBy`. */
function bestFamilyDriver(
  rootId: string,
  byId: ReadonlyMap<string, PluginSidebarThread>,
  familyIndex: FamilyIndex,
  doneIds: ReadonlySet<string>,
  groupBy: GroupBy,
  errorAcks: ReadonlySet<string> = new Set<string>(),
): PluginSidebarThread | undefined {
  let best: PluginSidebarThread | undefined;
  for (const member of familyDriveMembers(rootId, byId, familyIndex, doneIds, errorAcks)) {
    if (best === undefined || driveElevates(member, best, groupBy, errorAcks)) {
      best = member;
    }
  }
  return best;
}

/**
 * Pull nested children out of their column placement and attach them under
 * their parent's card. Applies these rules (see `childPlacement`):
 *
 * - Done children project into the Done space: a live parent's done children
 *   move under the family's projection card in the Done column — a second
 *   rendering of the parent's card, because the family is a projection and
 *   can exist in both spaces at once — while a done parent's done children
 *   nest under the parent's own Done card.
 * - R4 (status grouping): the live family moves as one unit into the column
 *   of its most attention-requiring live member (see `familyColumnOverrides`),
 *   and every live child of a live parent nests. Live children of a Done
 *   parent still promote when their state demands attention (the Done lane
 *   cannot relocate).
 * - Axis match (project/provider/machine): a live child nests only when its
 *   axis key matches its parent's; otherwise it stays flat in its own column.
 *   Recency and None groupings always nest.
 *
 * `childrenByParent` holds each parent's live nested children sorted
 * urgent-first, then in the same order the columns use (pinned-first,
 * newest-first; manual ranks within each tier) — see `sortNestedByColumnRank`;
 * a done parent's rows sort by done recency (the Done column itself orders
 * by activity recency).
 * `doneChildrenByParent` holds each projection's done children sorted newest
 * done first. Rows carry the display depth cap's one sub-tier: a child row
 * nests its own children (the map keys every displayed parent, not just
 * roots — issue #120), and members deeper than two row levels already
 * re-attached to the family root in the index.
 */
export function nestUnderParents(
  columns: readonly BoardColumn[],
  threads: readonly PluginSidebarThread[],
  groupBy: GroupBy,
  context: GroupingContext,
  now: number = Date.now(),
  familyIndex: FamilyIndex = buildFamilyIndex(threads),
  options: NestingOptions = {},
): NestingResult {
  const index = familyIndex;
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const ranks = options.ranks ?? {};
  const doneIds = options.doneIds ?? new Set<string>();
  const errorAcks = options.errorAcks ?? new Set<string>();
  const doneTimes = options.doneTimes ?? new Map<string, number>();

  // R3: nesting disabled — a fully flat board. Columns pass through
  // untouched (the caller has already kept archived threads out of them);
  // no child nests, no rows, no chips, no projections.
  if (options.nestingEnabled === false) {
    return {
      columns: withSlotPins([...columns], options.attentionFreeze?.slots ?? new Map()),
      childrenByParent: new Map(),
      doneChildrenByParent: new Map(),
    };
  }

  // Decide, per child, where it renders: rows under the parent's own card,
  // rows under the family's Done projection card, or standalone. Flat
  // children keep their column placement; the other two leave the column
  // lists entirely. The family index has already dropped archived members,
  // so neither side of an edge is archived (the guards below are defense for
  // a caller whose threads array disagrees with the index it passed).
  const nested = new Map<string, PluginSidebarThread[]>();
  const doneNested = new Map<string, PluginSidebarThread[]>();
  const flatIds = new Set<string>();
  for (const [childId, parentId] of index.parentOf) {
    const child = threadById.get(childId);
    const parent = threadById.get(parentId);
    if (child === undefined) continue; // hidden outright (archived children render nowhere)
    if (parent === undefined) {
      flatIds.add(childId);
      continue;
    }
  const placement = childPlacement(child, parent, groupBy, context, doneIds, options.attentionFreeze?.stayNested, errorAcks);
    if (placement === "flat") {
      flatIds.add(childId);
      continue;
    }
    const target = placement === "nest" ? nested : doneNested;
    const siblings = target.get(parentId);
    if (siblings === undefined) target.set(parentId, [child]);
    else siblings.push(child);
  }

  // A parent whose children all nest keeps its card; children leave the
  // column lists entirely. Only roots (and promoted/flat children) stay.
  const nestedKeyIds = nestedKeys(nested);
  const doneNestedKeyIds = nestedKeys(doneNested);
  sortNestedByColumnRank(nested, columns, groupBy, ranks, doneTimes);
  // Done-space rows read in the Done column's own order: newest done first.
  for (const children of doneNested.values()) {
    children.sort(doneRecencyCompare(doneTimes));
  }
  // Attended children pin their row slots (the attention freeze): a row the
  // operator is looking at holds its slot while the family's rows churn.
  const rowSlots = options.attentionFreeze?.rowSlots;
  if (rowSlots !== undefined && rowSlots.size > 0) {
    for (const [parentId, children] of nested) {
      const pins = rowSlots.get(parentId);
      if (pins !== undefined) nested.set(parentId, pinRowOrder(children, pins));
    }
    for (const [parentId, children] of doneNested) {
      const pins = rowSlots.get(parentId);
      if (pins !== undefined) doneNested.set(parentId, pinRowOrder(children, pins));
    }
  }
  // Pinned-lane attention lift: a pinned card whose OWN state needs the
  // operator rises to the top of the lane (a pinned attention child un-nests
  // and surfaces in Needs you instead — see `pinnedAttentionIds`).
  const pinnedAttention = pinnedAttentionIds(columns, errorAcks);

  // The Done projection: each live parent whose done children moved to the
  // Done space also renders a second card there — the family's projection
  // card — with those children nested under it. A done parent needs no
  // projection; its own card already sits in the Done column. Like every
  // card in the Done column, projections order by activity recency, not the
  // done stamp: a projection's recency is its family's most recent touch
  // (max updatedAt over the parent and its done children), so the idle
  // sweep's fresh stamps on long-idle children cannot vault the family.
  const projectionThreads = [...doneNested.keys()]
    .map((id) => threadById.get(id))
    .filter((thread): thread is PluginSidebarThread => thread !== undefined);
  const familyRecency = new Map<string, number>();
  for (const [parentId, children] of doneNested) {
    let recency = threadById.get(parentId)?.updatedAt ?? 0;
    for (const child of children) recency = Math.max(recency, child.updatedAt);
    familyRecency.set(parentId, recency);
  }
  const recencyOf = (thread: PluginSidebarThread): number =>
    familyRecency.get(thread.id) ?? thread.updatedAt;
  const doneRankOrder = orderForColumn(ranks, columnRankKey(groupBy, "done"));
  const withProjections = (cards: readonly PluginSidebarThread[]): PluginSidebarThread[] =>
    [...cards, ...projectionThreads].sort(
      compareByRank(doneRankOrder, (a, b) => {
        const aPinned = a.isPinned ? 0 : 1;
        const bPinned = b.isPinned ? 0 : 1;
        if (aPinned !== bPinned) return aPinned - bPinned;
        return recencyOf(b) - recencyOf(a);
      }),
    );

  const outColumns: BoardColumn[] = columns
    .map((column) => {
      const kept = column.threads.filter(
        (thread) =>
          !nestedKeyIds.has(thread.id) &&
          !doneNestedKeyIds.has(thread.id) &&
          (flatIds.has(thread.id) || index.rootIds.has(thread.id)),
      );
      if (column.id === "pinned") {
        return { ...column, threads: withAttentionFirst(kept, pinnedAttention) };
      }
      if (column.id === "done") {
        return { ...column, threads: withProjections(kept) };
      }
      return { ...column, threads: kept };
    })
    // Nesting drains a column when its every card is a nested child
    // (a live parent carries its whole family into the family column — R4 —
    // and the card itself takes a slot elsewhere). buildColumns yields only
    // one empty bucket by design — Working, the ever-present attention lane —
    // and “columns exist only while they hold cards” is the rule that keeps
    // the board readable and that hides Idle·buckets that have aged out or
    // emptied. A lane drained to zero violates it — the board would park an
    // empty lane (header, count 0, maybe a stale drop hint) beside columns
    // that all earn their place. Hide the drained column entirely; if a card
    // leaves the nest it returns to its own column and the lane reappears
    // with it. Working is exempt: under the status grouping the lane stays
    // even when emptied, reading "No work in progress".
    .filter(
      (column) =>
        column.threads.length > 0 || (groupBy === "status" && column.id === "working"),
    );
  // A Done column assembled from nothing but projections still earns its
  // place (buildColumns only creates the lane when a done thread exists, and
  // drained done children are its projections' rows — this guards a
  // caller-built column list without one).
  if (projectionThreads.length > 0 && !outColumns.some((column) => column.id === "done")) {
    outColumns.push({ id: "done", label: "Done", threads: withProjections([]) });
  }

  // Attention slot pins land LAST — after the drains, the projections, and
  // the pinned lane's attention lift — so the pins name exactly what renders.
  return {
    columns: withSlotPins(outColumns, options.attentionFreeze?.slots ?? new Map()),
    childrenByParent: nested,
    doneChildrenByParent: doneNested,
  };
}

/**
 * Which Pinned-lane cards currently need the operator by their OWN state —
 * a pending interaction or an unread error on the pinned thread itself. A
 * pinned card cannot relocate to a Needs-you lane (the state column overrides
 * apply to unpinned roots only), so the attention surfaces where the card
 * already sits: the lane lifts these cards to the top (`withAttentionFirst`)
 * and the card pulses (`ThreadCard`'s attention overlay reads the same
 * state). An attention CHILD of a pinned family is not in this set — it
 * un-nests (`childPlacement`) and demands attention from its own card in
 * Needs you.
 */
export function pinnedAttentionIds(
  columns: readonly BoardColumn[],
  errorAcks: ReadonlySet<string> = new Set<string>(),
): ReadonlySet<string> {
  const pinned = columns.find((column) => column.id === "pinned");
  const ids = new Set<string>();
  if (pinned === undefined) return ids;
  for (const thread of pinned.threads) {
    if (threadState(thread, errorAcks) === "attention") ids.add(thread.id);
  }
  return ids;
}

/**
 * Insert an attention tier above the Pinned lane's own order: attention
 * cards lead; the rest keep their relative order (the stable sort preserves
 * manual ranks underneath).
 */
function withAttentionFirst(
  threads: readonly PluginSidebarThread[],
  attentionIds: ReadonlySet<string>,
): PluginSidebarThread[] {
  return [...threads].sort(
    (a, b) => (attentionIds.has(a.id) ? 0 : 1) - (attentionIds.has(b.id) ? 0 : 1),
  );
}

/**
 * The collapsed-family auto-expand helpers were removed with the un-nest
 * rule: an attention child now leaves the nest entirely (`childPlacement`)
 * instead of expanding the card it hides in, so there is no source set to
 * diff and no transition to fire.
 */

/**
 * Sort each parent's nested children in the order of the column the PARENT
 * sits in. The family moves as one unit: a child's stored rank is an id in
 * that column's list, and the parent is the card the operator actually drags,
 * so the children follow the parent's column order rather than their own
 * (absent) ranks.
 *
 * There is no urgent-first tier: an attention child un-nests
 * (`childPlacement`) and never appears in these rows, so every nested child
 * is quiet and the parent column's own order applies unchanged. An unranked
 * column (or a parent not found in any column) sorts purely by the board's
 * derived order.
 *
 * Rows under a card in the Done column (a done parent's card) read in
 * done-recency order instead: newest done first. The Done column itself
 * orders by activity recency; only these rows keep the done-stamp order.
 */
function sortNestedByColumnRank(
  nested: Map<string, PluginSidebarThread[]>,
  columns: readonly BoardColumn[],
  groupBy: GroupBy,
  ranks: RankStore,
  doneTimes: ReadonlyMap<string, number>,
): void {
  const columnOfThread = new Map<string, string>();
  for (const column of columns) {
    for (const thread of column.threads) columnOfThread.set(thread.id, column.id);
  }
  for (const [parentId, children] of nested) {
    const columnId = columnOfThread.get(parentId);
    if (columnId === "done") {
      children.sort(doneRecencyCompare(doneTimes));
      continue;
    }
    // The family's own manual child order leads (the reorder-rows gesture
    // writes child:<parentId> keys — never the column's order, which the
    // parent card shares with the whole column). The column order and then
    // the derived order break ties underneath, so a family nobody has
    // reordered (and every child rank does not name) keeps the sort the
    // board has always shown.
    const base =
      columnId === undefined
        ? []
        : orderForColumn(ranks, columnRankKey(groupBy, columnId));
    const childOrder = orderForColumn(ranks, childRankKey(parentId));
    children.sort(compareByRank(childOrder, compareByRank(base, derivedCompare)));
  }
}

function nestedKeys(nested: ReadonlyMap<string, readonly PluginSidebarThread[]>): Set<string> {
  const ids = new Set<string>();
  for (const children of nested.values()) {
    for (const child of children) ids.add(child.id);
  }
  return ids;
}

/**
 * The id of the family root `threadId` belongs to — the thread's own id when
 * it IS a root, otherwise the ancestor its display parent chain ends at. The
 * walk rides the same `familyIndex.parentOf` edges the family grouping in
 * `filterFamilies` keys families by, so the result scopes exactly one of those
 * families: this is what the card menu's "Zoom to family" gesture writes
 * (issue #170), so triggering from a nested row names the family's OWNER,
 * never a sub-child of it.
 *
 * `buildFamilyIndex` has already unlinked corrupt cycles from `parentOf`, so
 * the walk terminates; an index that could still cycle is a broken index and
 * throws instead of picking an arbitrary ancestor (fail loud, never coerce).
 */
export function familyRootIdOf(threadId: string, familyIndex: FamilyIndex): string {
  let cursor = threadId;
  const bound = familyIndex.parentOf.size + 1;
  for (let hop = 0; hop <= bound; hop++) {
    const next = familyIndex.parentOf.get(cursor);
    if (next === undefined) return cursor;
    cursor = next;
    if (cursor === threadId) {
      throw new Error(`family index cycle through ${threadId}`);
    }
  }
  throw new Error(`family index cycle through ${threadId}`);
}

/**
 * The family-scope half of the zoom gesture, kept beside the family-aware
 * passes it gates (filterFamilies, filterIndividually). An absent (or empty-
 * string — never a written value, but a defensive read) `familyRootId`
 * restricts nothing: legacy stored filters scope the board the same way the
 * group filter's empty set does.
 */
function familyScopeMisses(
  thread: PluginSidebarThread,
  filter: FilterState,
  familyIndex: FamilyIndex,
): boolean {
  const scopeRoot = filter.familyRootId === "" ? undefined : filter.familyRootId;
  if (scopeRoot === undefined) return false;
  return familyRootIdOf(thread.id, familyIndex) !== scopeRoot;
}

/**
 * Family-aware filtering: a family passes when ANY of its members passes the
 * filters or search; every member of a passing family is kept, with
 * non-matching members recorded in `dimmedIds` so the board can render them
 * at reduced opacity. A family where nothing matches is dropped whole.
 *
 * One gate never dim-keeps, though: the project filter. A project filter is
 * a column gate (project grouping builds a column per kept member's
 * project), so a member whose project is not selected drops from its passing
 * family outright — dim-kept context lives only inside columns that pass,
 * never projecting a column for an unselected project. State, provider, and
 * search misses keep-and-dim as before.
 *
 * Archived members are hidden outright: the family index carries none of
 * them, so an archived thread in the input forms its own (parentless)
 * family, and since an archived thread never passes the filters its family
 * drops whole — an archived child can neither ride along nor surface its
 * family.
 */
export function filterFamilies(
  threads: readonly PluginSidebarThread[],
  familyIndex: FamilyIndex,
  filter: FilterState,
  searchQuery: string,
  projectNameFor?: (projectId: string) => string,
  ticketRefsFor?: (thread: PluginSidebarThread) => readonly TicketRef[],
  groupNameFor?: (thread: PluginSidebarThread) => string,
  groupsByThread?: ReadonlyMap<string, string>,
  now: number = Date.now(),
  errorAcks?: ReadonlySet<string>,
): FamilyFilterResult {
  const passes = (thread: PluginSidebarThread): boolean =>
    threadPassesFilter(thread, filter, searchQuery, projectNameFor, ticketRefsFor, groupNameFor, groupsByThread, now, errorAcks);

  // Group visible threads into families by their root, so a parent and its
  // descendants pass or fail together.
  const families = new Map<string, PluginSidebarThread[]>();
  for (const thread of threads) {
    let rootId = thread.id;
    let cursor = familyIndex.parentOf.get(thread.id);
    const seen = new Set<string>();
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      rootId = cursor;
      cursor = familyIndex.parentOf.get(cursor);
    }
    const family = families.get(rootId);
    if (family === undefined) families.set(rootId, [thread]);
    else family.push(thread);
  }

  const kept: PluginSidebarThread[] = [];
  const dimmedIds = new Set<string>();
  // The family scope (Zoom to family, issue #170): only the scoped family
  // survives the pass, and nothing dims for it — the other families drop
  // whole, exactly what the zoomed Parent view shows. The families map is
  // keyed by the walk `familyRootIdOf` performs, so the scope matches the
  // gesture's recorded root id.
  const scopeRoot = filter.familyRootId === "" ? undefined : filter.familyRootId;
  for (const [rootId, family] of families.entries()) {
    if (scopeRoot !== undefined && rootId !== scopeRoot) continue;
    const matching = family.filter(passes);
    if (matching.length === 0) continue;
    for (const thread of family) {
      if (matching.includes(thread)) {
        kept.push(thread);
        continue;
      }
      // A project filter is a column gate: a member in a project the
      // operator did not select never renders, dimmed or not — a dim-kept
      // member grouped by project forms a column for an unselected project
      // (the Personal / unselected-family-parent report). The group filter
      // runs the same gate (the Group view builds a column per bucket, and
      // a member of an unselected bucket must never dim back onto the
      // board). State, provider, and search misses keep-and-dim below,
      // inside columns that pass.
      if (filter.projects.size > 0 && !filter.projects.has(thread.projectId)) {
        continue;
      }
      if (groupFilterMisses(thread, filter, groupsByThread)) {
        continue;
      }
      kept.push(thread);
      dimmedIds.add(thread.id);
    }
  }
  return { kept, dimmedIds };
}

/**
 * R3: per-thread filtering for the flat board (nesting toggle OFF). No
 * family keep, no dimming — each thread passes or fails on its own, and
 * archived threads never render in flat mode. The family scope (Zoom to
 * family) still applies: a thread stays only if it belongs to the scoped
 * family, resolved from the same index the gesture recorded its root from
 * (a pass without an index builds one from the board's own set, so flat
 * mode honours the scope with the exact edges the board sees).
 */
export function filterIndividually(
  threads: readonly PluginSidebarThread[],
  filter: FilterState,
  searchQuery: string,
  projectNameFor?: (projectId: string) => string,
  ticketRefsFor?: (thread: PluginSidebarThread) => readonly TicketRef[],
  groupNameFor?: (thread: PluginSidebarThread) => string,
  groupsByThread?: ReadonlyMap<string, string>,
  now: number = Date.now(),
  errorAcks?: ReadonlySet<string>,
  familyIndex: FamilyIndex = buildFamilyIndex(threads),
): FamilyFilterResult {
  const kept: PluginSidebarThread[] = [];
  for (const thread of threads) {
    if (familyScopeMisses(thread, filter, familyIndex)) continue;
    if (
      threadPassesFilter(
        thread,
        filter,
        searchQuery,
        projectNameFor,
        ticketRefsFor,
        groupNameFor,
        groupsByThread,
        now,
        errorAcks,
      )
    ) {
      kept.push(thread);
    }
  }
  return { kept, dimmedIds: new Set() };
}