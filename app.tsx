import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_usePluginId,
  experimental_useProviders,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSdk,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { findTicketRefs, forgejoItemBase, resolveRepoSlug } from "./lib/tickets";
import {
  cardTicketRefs,
  linkedRefKeys,
  parseLinkedIssues,
  type ThreadLink,
} from "./lib/link-metadata";
import type { JsonValue } from "@get-bb/plugin-sdk";
import { installHostLinkGlue } from "./components/host-link-glue";
import { FocusBoardAppIcon } from "./components/ui/icon";
import type { rpcContract } from "./server";
import type { jiraRpcContract } from "./lib/jira-server";
import { JiraBoardContext, type JiraBoardValue } from "./components/jira-card-badges";
import { boardDoneIds } from "./lib/jira-done-check";
import { jiraThreadsByKey } from "./components/jira-column";
import { Board } from "./components/board";
import { BoardToolbar } from "./components/board-toolbar";
import { ThreadPane } from "./components/thread-pane";
import type { ThreadPaneThread } from "./components/thread-pane";
import { useSearchFocusOnSlash } from "./hooks/use-search-focus";
import { useNewThreadComposerShortcut } from "./hooks/use-new-thread-shortcut";
import { useTicketStatuses } from "./hooks/use-ticket-statuses";
import { usePulseRates } from "./hooks/use-pulse-rates";
import { NewThreadModal, type SpawnPluginMetadata } from "./components/new-thread-modal";
import type { SpawnedThread } from "./components/new-thread-modal";
import type { CardMenuAction } from "./components/thread-card-menu";
import { cardMenuActions } from "./lib/card-menu";
import type { FilterState, GroupBy, LaneHideOutcome } from "./components/grouping";
import {
  buildColumns,
  columnFor,
  filterBucketsWithoutLane,
  matchesFilter,
  NO_GROUP_BUCKET,
  parseStoredStateFilter,
  threadState,
  withJiraColumn,
} from "./components/grouping";
import { staleErrorAckIds } from "./lib/error-ack-metadata";
import {
  createRefetchScheduler,
  REFETCH_COALESCE_MS,
} from "./lib/refetch-coalescer";
import {
  buildFamilyIndex,
  familyRootIdOf,
  filterFamilies,
  filterIndividually,
  assembleBoard,
} from "./components/nesting";
import { buildParentLanes, laneRowThreads } from "./components/parent-lanes";
import type { ParentLane } from "./components/parent-lanes";
import { ParentLaneBoard } from "./components/parent-lane-board";
import {
  applyLaneFreezes,
  capturesEqual,
  captureColumnAttention,
  compileAttentionFreezes,
  laneCaptureOf,
  stripCapturedIds,
  type AttentionCapture,
  type AttentionOrigin,
  type LaneCapture,
} from "./components/attention-freeze";
import { GroupDialog } from "./components/group-dialog";
import { planGroupBoxes } from "./components/group-boxes";
import { applyUnitMoveVisible } from "./lib/rank-unit-move";
import { doneAtToEpochMs } from "./lib/done-metadata";
import { projectDisplayName } from "./lib/project-name";
import { paneContextInfo } from "./lib/pane-context";
import type { ReferenceMentions } from "./components/decorate-reference-mentions";
import {
  newThreadDerivedProjectId,
  newThreadSeedEnvironmentForProject,
  newThreadSeedProjectId,
  parseRememberedEnvironmentStored,
  parseRememberedProjectStored,
  rememberedEnvironmentStorageKey,
  rememberedEnvironmentStoredValue,
  rememberedProjectStorageKey,
  rememberedProjectStoredValue,
  type NewThreadEnvironmentArgs,
  jiraStartThreadSeed,
} from "./lib/new-thread-seed";
import type { DriftItem, JiraTicket } from "./lib/jira-schema";
import { majorityGroupSpawnSeed, type GroupSpawnSeed } from "./lib/group-spawn-seed";
import { spawnInheritedGroupId } from "./lib/group-inheritance";
import { maximizeComposerToMainView } from "./lib/compose-maximize";
import { SnoozeDialog } from "./components/snooze-dialog";
import {
  presetWakeAt,
  snoozeMenuActions,
  snoozeWakeAtMs,
  type SnoozeMenuAction,
  type SnoozeRecord,
} from "./lib/snooze";
import {
  applyInteractionFlags,
  interactionFlagChangeFromEvent,
  pendingFromInteractionRows,
  type InteractionFlagStore,
} from "./lib/interaction-sync";
import {
  paneSubPathFor,
  paneThreadIdFromSubPath,
  paneRouteAction,
} from "./lib/pane-route";
import { applyMoveVisible, orderForColumn, type RankStore } from "./lib/rank";
import {
  buildBrowserRevealPorts,
  revealThreadBrowserTabs,
  type BrowserRevealNotice,
  type BrowserRevealResult,
} from "./lib/browser-reveal";
import { pinStateChangeFromEvent, readStateChangeFromEvent } from "./lib/pin-park";
import {
  DEFAULT_DONE_ARCHIVE_MS,
  DEFAULT_IDLE_ARCHIVE_MS,
  SWEEP_SETTLED_WORDS,
  armSweep,
  confirmSweep,
  runSweep,
  sweepArmPreselects,
  sweepCandidatesForDoneColumn,
  sweepCandidatesForIdleColumn,
  sweepColumnKind,
  sweepDestination,
  toggleSweepSelection,
  addSweepSelection,
  type ArmedSweep,
  type DoneAgeSource,
  type SweepDestination,
  type SweepNotice,
  type SweepRunView,
} from "./lib/sweep";
import { useSweepClickAway } from "./components/board";
import { useCrossWindowStorage } from "./components/preferences-sync";
import {
  COLLAPSED_FAMILIES_KEY,
  COLLAPSED_GROUPS_KEY,
  GROUP_BY_KEY,
  HIDE_IDLE_CHILDREN_KEY,
  NEST_CHILDREN_KEY,
  PARENT_LANE_ORDER_KEY,
  applyStoredSetDelta,
  clearStored,
  collapsedGroupsStoredValue,
  escStopsRunningFromSetting,
  newThreadShortcutKeyFromSetting,
  nestStoredValue,
  parseCollapsedFamiliesStored,
  parseCollapsedGroupsStored,
  parseHideIdleChildrenStored,
  parseNestStored,
  parseGroupStored,
  parseParentLaneOrderStored,
  parseWallpaperStored,
  repairStoredList,
  toggleStoredSetId,
  readStored,
  readStoredText,
  writeStored,
  type ParentLaneOrder,
  wallpaperLayerOf,
  wallpaperStoredValue,
  type WallpaperLayer,
  type WallpaperSettings,
  WALLPAPER_KEY,
  CARD_TRANSPORT_KEY,
  MOTION_PREF_KEY,
  MOTION_PACING_KEY,
  LANE_DIRECTION_KEY,
  parseCardTransportStored,
  cardTransportStoredValue,
  parseLaneDirectionStored,
  laneDirectionStoredValue,
  parseMotionSettings,
  motionPacingStoredValue,
  motionSettingsStoredValues,
  type CardTransportPref,
  type LaneDirectionPref,
  type MotionPref,
  type MotionPacing,
  type MotionSettings,
  type SweepSettingKey,
} from "./components/preferences";
import { type ArchiveUnit } from "./lib/duration";
import {
  familyStateMigration,
  type FamilyStateStore,
} from "./lib/family-state";
import { usePrefersDarkScheme } from "./components/ui/hooks/use-media-query";
import { WallpaperActiveProvider } from "./components/wallpaper-contrast";
import { PaneSheetCoverageProvider } from "./components/pane-sheet-coverage";
import { WallpaperPaintLayer } from "./components/wallpaper-paint";
import { EmptyState } from "./components/empty-state";
import { SettingsModal, type SettingsTab } from "./components/settings-modal";
import { AppearanceSettingsSection } from "./components/settings-section";
import {
  APP_VERSION,
  CURRENT_UNRELEASED_FINGERPRINT,
  currentUnreleasedLeads,
  hasUnseenWhatsNew,
  readLastSeenUnreleased,
  readLastSeenUnreleasedItems,
  readLastSeenVersion,
  unreleasedItemFingerprints,
  unseenUnreleasedLeads,
  whatsNewEntriesFor,
  writeLastSeenUnreleased,
  writeLastSeenUnreleasedItems,
  writeLastSeenVersion,
  type WhatsNewEntry,
} from "./lib/whats-new";

const FILTER_KEY = "focus-board:filter";
const SEARCH_KEY = "focus-board:search";
/** This panel's own registered route path, for pane-history pushes. */
const PANEL_PATH = "board";

/** The nesting map when there is none (flat board, parent grouping): a stable
 *  empty, so the auto-expand effect's inputs never churn identity per render. */
const EMPTY_NESTED: ReadonlyMap<string, readonly PluginSidebarThread[]> = new Map();

/** No natural-lane capture: the attention freeze owns the pane's pin now, so
 *  app passes a stable empty to assembleBoard's legacy frozenColumns param. */
const EMPTY_FROZEN_COLUMNS: ReadonlyMap<string, { id: string; label: string }> = new Map();

/**
 * `toPluginPanel` is typed `void`, but the host may return `false` when it
 * could not push the route (no history owner on this surface) — or throw on
 * one. Either way the push did not happen: report it as rejected so the pane
 * falls back to local state instead of dying with the click.
 */
function pushRejected(push: () => void): boolean {
  try {
    return (push() as unknown as boolean | undefined) === false;
  } catch {
    return true;
  }
}

/** Adapt metadata records ({doneAt: ISO, keep?}) into the sweep's extras
 *  shape ({doneAt: epoch-ms, keep?}). */
function recordsAsExtras(
  records: Record<string, { doneAt?: number | string; keep?: boolean }>,
): Record<string, { doneAt?: number; keep?: boolean }> {
  const out: Record<string, { doneAt?: number; keep?: boolean }> = {};
  for (const [id, record] of Object.entries(records)) {
    out[id] = {
      ...(typeof record.doneAt === "string"
        ? { doneAt: doneAtToEpochMs(record.doneAt) ?? undefined }
        : record.doneAt !== undefined
          ? { doneAt: record.doneAt }
          : {}),
      ...(record.keep === true ? { keep: true } : {}),
    };
  }
  return out;
}

function readStoredList(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === "string");
      }
    }
  } catch {
    // localStorage can throw in embedded contexts; fall through to default.
  }
  return [];
}

/** The banner copy naming why the desktop browser could not be reached. */
function browserReachFailure(error: unknown): string {
  return `Reaching the desktop browser failed: ${
    error instanceof Error ? error.message : String(error)
  }`;
}

function BoardPage({ subPath }: { subPath: string }) {
  const {
    status: sidebarStatus,
    threads: sidebarThreads,
    projects,
  } = experimental_useSidebarThreads();
  const pluginId = experimental_usePluginId();
  const actions = experimental_useSidebarThreadActions();
  const { providers } = experimental_useProviders();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  // Host-declared plugin settings (the detail page's config panel), reactive.
  const { values: settingValues } = useSettings();
  // The thread pane's Escape behavior: only a stored false turns the setting
  // off; loading or an unavailable settings surface keeps the ON default.
  const escStopsRunningThread = escStopsRunningFromSetting(
    settingValues?.escStopsRunningThread,
  );
  // The board's New Thread composer shortcut: the effective configured key
  // (lowercased single letter/digit) or null when the operator turned the
  // shortcut off; the C default applies while loading (components/preferences.ts).
  const newThreadShortcutKey = newThreadShortcutKeyFromSetting(
    settingValues?.newThreadShortcutKey,
  );
  // The settings modal's Behavior tab writes the same host declaration the
  // detail page's config panel edits — a partial values patch on this
  // plugin's settings (the host stores settings per key, so the panel keys
  // beside it are untouched), then reacts through `useSettings()` when the
  // host confirms. Failures propagate to the row's inline error.
  const setPluginSettings = useCallback(
    async (patch: Record<string, string | number | boolean>) =>
      void (await sdk.plugins.updateSettings({ pluginId, values: patch })),
    [sdk, pluginId],
  );
  const setEscStopsRunningThread = useCallback(
    async (value: boolean) => {
      await setPluginSettings({ escStopsRunningThread: value });
    },
    [setPluginSettings],
  );
  const setNewThreadShortcutKey = useCallback(
    (value: string) => setPluginSettings({ newThreadShortcutKey: value }),
    [setPluginSettings],
  );
  const setSweepThreshold = useCallback(
    (write: { key: SweepSettingKey; value: number | ArchiveUnit }) =>
      setPluginSettings({ [write.key]: write.value }),
    [setPluginSettings],
  );

  // The board's "needs you" state rides the sidebar's `hasPendingInteraction`
  // flag, but the sidebar cache can lag behind an answered question: the
  // server clears its flag the moment the interaction settles, while the
  // cached board row keeps the stale one until some unrelated change
  // refetches the list (observed 2026-09-29, thr_6fzk5sjz79). Guard: verify
  // every `interactions-changed` event below and overlay the verified flag
  // on the sidebar rows until the sidebar row agrees again
  // (lib/interaction-sync).
  const [interactionFlags, setInteractionFlags] = useState<InteractionFlagStore>(
    () => new Map(),
  );
  useEffect(() => {
    let disposed = false;
    const record = (threadId: string, hasPendingInteraction: boolean) => {
      setInteractionFlags((current) => {
        const next = new Map(current);
        next.set(threadId, hasPendingInteraction);
        return next;
      });
    };
    try {
      const unsubscribe = sdk.subscribe({
        event: "thread:changed",
        callback: (event) => {
          const change = interactionFlagChangeFromEvent(event);
          if (change === null) return;
          if (change.hasPendingInteraction !== null) {
            // The host attached the new flag on the event; it is the server
            // truth for this change.
            record(change.threadId, change.hasPendingInteraction);
            return;
          }
          // A host that omits the flag on the event must be verified
          // against the interaction rows instead.
          void sdk.threads.interactions
            .list({ threadId: change.threadId })
            .then(
              (rows) => {
                if (disposed) return;
                record(change.threadId, pendingFromInteractionRows(rows));
              },
              () => {}, // A lost verify keeps the sidebar value; the next event corrects it.
            );
        },
      });
      return () => {
        disposed = true;
        unsubscribe();
      };
    } catch {
      // Embedded contexts (screenshot harness) have no subscribe; the board
      // falls back to the sidebar's flags with no overlay.
      return undefined;
    }
  }, [sdk]);
  // Sidebar rows with the verified flags overlaid; everything downstream —
  // grouping, nesting, lanes, cards, the pane lookup — renders from this.
  const threads = useMemo(
    () => applyInteractionFlags(sidebarThreads, interactionFlags),
    [sidebarThreads, interactionFlags],
  );

  const [doneIds, setDoneIds] = useState<ReadonlySet<string>>(new Set());
  // The board's own GitHub links (metadata "linkedIssues"): the chip surface
  // for items a thread's text never names (issue #13 — no cross-plugin read
  // of the GitHub plugin's link rows exists). Record<string, ThreadLink[]>;
  // a thread absent from it carries no linked chips.
  const [linksByThread, setLinksByThread] = useState<Record<string, ThreadLink[]>>({});
  // tracker_validate's confirmed-href set, declared above the filter pass so
  // the ticket-aware search callback (ticketRefsFor, below) can read it: the
  // chip rule gates text refs identically in render and in search.
  const [validatedHrefs, setValidatedHrefs] = useState<ReadonlySet<string>>(new Set());
  // The RPC contract's link records tolerate a legacy GitHub record without
  // its tracker tag; parse normalizes each thread's array into ThreadLink[]
  // (and fails loud on anything malformed, never coerces).
  const linksFromRpc = useCallback(
    (result: { links: Record<string, unknown> }) => {
      const out: Record<string, ThreadLink[]> = {};
      for (const [threadId, links] of Object.entries(result.links)) {
        const parsed = parseLinkedIssues(links as JsonValue);
        if (parsed !== null) out[threadId] = parsed;
      }
      return out;
    },
    [],
  );
  // Pinned-pin parks: a lane-exit unpin parks the pin (thread metadata via
  // RPC) so the writes that bring the card back to the operator — Mark Not
  // Done, Mark Unread — can restore it. Local optimistic state drives the
  // restore decisions; the server record is the cross-reload truth.
  const [parkIds, setParkIds] = useState<ReadonlySet<string>>(new Set());
  // Clear-error acknowledgments (issue #157): threads whose error signals the
  // operator acknowledged. Local set drives the optimistic display (dot,
  // accent, lane); the server record (plugin metadata "errorAck") is the
  // cross-reload truth. The stale sweep below drops an ack on any turn that
  // leaves the error status, so a later error claims attention fresh.
  const [errorAckIds, setErrorAckIds] = useState<ReadonlySet<string>>(new Set());
  // The ack's ride ends when the thread's status leaves "error" — a new turn
  // started, so the next error must claim attention fresh and cannot inherit
  // an acknowledgment given to an earlier one (issue #157). The board owns
  // the sweep (bb never watches turns): drop the ids that went stale from
  // the local set and clear their records; the clear publishes the ack
  // signal, which refetches in every other open board.
  useEffect(() => {
    const stale = staleErrorAckIds(threads, errorAckIds);
    if (stale.length === 0) return;
    setErrorAckIds((current) => {
      const next = new Set(current);
      for (const id of stale) next.delete(id);
      return next;
    });
    for (const id of stale) {
      rpc.call("error_ack_set", { threadId: id, acked: false }).catch(() => {});
    }
  }, [threads, errorAckIds, rpc]);
  // Done ages + sweep overrides come from the per-thread plugin-metadata
  // records: doneAt is the ISO stamp, keep the sweep override. The epoch
  // adapter (lib/done-metadata) feeds the sweep's injected `now` contract.
  const [doneExtras, setDoneExtras] = useState<Record<string, { doneAt?: number; keep?: boolean }>>({});
  const [sweepConfig, setSweepConfig] = useState({
    doneArchiveMs: DEFAULT_DONE_ARCHIVE_MS,
    idleArchiveMs: DEFAULT_IDLE_ARCHIVE_MS,
  });
  // Refetch units: the exact bodies the mount effect and the realtime
  // signals both consume, named so the realtime coalescer (below) can run
  // each once per pass.
  const refetchDoneState = useCallback(() => {
    rpc.call("done_list").then(
      (result) => {
        setDoneIds(new Set(result.doneIds));
        setDoneExtras(recordsAsExtras(result.records));
      },
      () => {}, // Done marking is optional state; the board works without it.
    );
    // Parks ride the done refetch: another panel (or the CLI path) may have
    // parked or consumed a pin this panel has not mirrored.
    rpc.call("pin_parks_list").then(
      (result) => setParkIds(new Set(Object.keys(result.parks))),
      () => {}, // Parks gate nothing; an unloadable park list loses no pin.
    );
    rpc.call("sweep_config_get").then(
      (result) =>
        setSweepConfig({
          doneArchiveMs: result.doneArchiveMs,
          idleArchiveMs: result.idleArchiveMs,
        }),
      () => {}, // Settings are optional; defaults apply when unreachable.
    );
  }, [rpc, setDoneIds, setDoneExtras, setParkIds, setSweepConfig]);
  const refetchLinks = useCallback(() => {
    rpc.call("link_list").then(
      (result) => setLinksByThread(linksFromRpc(result)),
      () => {}, // Links are optional state; the board works without them.
    );
  }, [rpc, setLinksByThread]);
  const refetchErrorAcks = useCallback(() => {
    rpc.call("error_acks_list").then(
      (result) => setErrorAckIds(new Set(result.ackIds)),
      () => {}, // Acks are optional state; the board works without them.
    );
  }, [rpc, setErrorAckIds]);
  useEffect(() => {
    refetchDoneState();
    refetchLinks();
    refetchErrorAcks();
  }, [refetchDoneState, refetchLinks, refetchErrorAcks]);
  // The realtime coalescer (issue #186): one shared debounce over every
  // refetch-carrying signal, so a burst of signals — one write echoed
  // across channels, or several writes landing together — produces one
  // refetch pass, not one per signal. The mount refetches above stay
  // immediate; only the signal path waits the quiet window.
  const refetchScheduler = useMemo(() => createRefetchScheduler(REFETCH_COALESCE_MS), []);
  useEffect(() => refetchScheduler.dispose, [refetchScheduler]);
  useRealtime("done-changed", () => {
    refetchScheduler.schedule("done", refetchDoneState);
  });
  // The board's own link signal mirrors done-changed: every open panel
  // refetches the map, so a link written by the agent tool or the CLI
  // converges on the card that is already on screen.
  useRealtime("link-changed", () => {
    refetchScheduler.schedule("links", refetchLinks);
  });
  // Jira chips: one board-state read, refetched on the server's jira-changed.
  const jiraRpc = useRpc<typeof jiraRpcContract>();
  const [jiraState, setJiraState] = useState<{
    enabled: boolean; stale: boolean; tickets: JiraBoardValue["ticketByKey"];
    threads: JiraBoardValue["threads"]; pending: JiraBoardValue["pendingOps"];
    snapshotAge: number | null; error: string | null;
    suggestions: { threadId: string; key: string }[]; drift: DriftItem[]; autoLinks: { threadId: string; key: string }[];
    next: NonNullable<JiraBoardValue["nextByThread"]>;
  }>({ enabled: false, stale: false, tickets: {}, threads: {}, pending: [], snapshotAge: null, error: null, suggestions: [], drift: [], autoLinks: [], next: {} });
  const refetchJira = useCallback(() => {
    jiraRpc.call("jira_board_state", null).then(
      async (r) => {
        // The Jira column's suggestions and drift ride the stored reconcile plan.
        const plan = r.enabled ? await jiraRpc.call("jira_reconcile_plan", null).catch(() => null) : null;
        setJiraState({
          enabled: r.enabled,
          stale: r.stale,
          tickets: Object.fromEntries(r.tickets.map((t) => [t.key, t])),
          threads: r.threads,
          pending: Object.values(r.pending),
          snapshotAge: r.snapshotAge,
          error: r.error,
          suggestions: plan?.suggestions ?? [],
          drift: plan?.drift ?? [],
          autoLinks: plan?.autoLinks ?? [],
          next: r.next,
        });
      },
      () => {}, // Jira is optional state; the board works without it.
    );
  }, [jiraRpc]);
  useEffect(() => refetchJira(), [refetchJira]);
  useRealtime("jira-changed", () => {
    refetchScheduler.schedule("jira", refetchJira);
  });
  useRealtime("jira-reconcile-changed", () => {
    refetchScheduler.schedule("jira", refetchJira);
  });
  const jiraValue = useMemo<JiraBoardValue>(
    () => ({
      enabled: jiraState.enabled,
      stale: jiraState.stale,
      ticketByKey: jiraState.tickets,
      threads: jiraState.threads,
      pendingOps: jiraState.pending,
      nextByThread: jiraState.next,
      onAction: (kind, threadId, index, reason) => {
        jiraRpc.call("jira_card_action", { kind, threadId, ...(index === undefined ? {} : { index, reason }) }).then(refetchJira, () => {});
      },
    }),
    [jiraState, jiraRpc, refetchJira],
  );
  // The ack signal mirrors done-changed: every open board refetches the set
  // so a Clear error (menu, or any later surface) converges everywhere.
  useRealtime("error-ack-changed", () => {
    refetchScheduler.schedule("errorAcks", refetchErrorAcks);
  });
  // The board's snapshot is the DoneAgeSource implementation: stamps for
  // Done ages, keep flags as the sweep override.
  const doneAgeSource: DoneAgeSource = useMemo(
    () => ({
      doneMarkedAt: (threadId) => doneExtras[threadId]?.doneAt ?? null,
      kept: (threadId) => doneExtras[threadId]?.keep === true,
    }),
    [doneExtras],
  );
  const idleKept = useCallback(
    (threadId: string) => doneExtras[threadId]?.keep === true,
    [doneExtras],
  );
  // Thread id → epoch-ms done stamp, feeding the done-children rows under a
  // done parent's card and the parent-lane board's Done row (both newest
  // done first). The Done column itself ignores stamps and sorts by
  // activity recency; the idle sweep's fresh stamps must not vault
  // long-idle threads to the top of it.
  const doneTimes = useMemo(() => {
    const times = new Map<string, number>();
    for (const [threadId, extra] of Object.entries(doneExtras)) {
      if (extra.doneAt !== undefined) times.set(threadId, extra.doneAt);
    }
    return times;
  }, [doneExtras]);

  // Snoozed threads: per-thread plugin metadata ({ wakeAt, setAt }) surfaced
  // through the snooze RPCs. The board only mirrors the records — dimming,
  // the wake chip, menu entries, and sweep skipping all derive from them;
  // the wake itself (markUnread at the target time) is server-side.
  const [snoozeRecords, setSnoozeRecords] = useState<Record<string, SnoozeRecord>>({});
  const refetchSnoozes = useCallback(() => {
    rpc.call("snooze_list").then(
      (result) => setSnoozeRecords(result.snoozes),
      () => {}, // Snoozing is optional state; the board works without it.
    );
  }, [rpc]);
  useEffect(() => {
    refetchSnoozes();
  }, [refetchSnoozes]);
  useRealtime("snooze-changed", () => {
    refetchScheduler.schedule("snoozes", refetchSnoozes);
  });
  const snoozedIds = useMemo(
    () => new Set(Object.keys(snoozeRecords)),
    [snoozeRecords],
  );
  /** Wake epoch-ms for a thread, null when it is not snoozed. */
  const snoozeFor = useCallback(
    (threadId: string): number | null => {
      const record = snoozeRecords[threadId];
      return record === undefined ? null : snoozeWakeAtMs(record);
    },
    [snoozeRecords],
  );
  // A snooze set by any surface (this panel's menu, the CLI, another panel)
  // lands here through the snooze-changed refetch; the optimistic write
  // below only smooths this panel's own gesture.
  const snoozeUntil = useCallback(
    (threadId: string, wakeAt: Date) => {
      const wakeAtIso = wakeAt.toISOString();
      setSnoozeRecords((current) => ({
        ...current,
        [threadId]: { wakeAt: wakeAtIso, setAt: new Date().toISOString() },
      }));
      rpc.call("snooze_set", { threadId, wakeAt: wakeAtIso }).catch(() => refetchSnoozes());
    },
    [rpc, refetchSnoozes],
  );
  // Current-intent: lifting a snooze explicitly (Unsnooze, or any later
  // state-changing gesture on the card). Optimistic removal; a rejected
  // write settles the truth back through a refetch.
  const clearSnooze = useCallback(
    (threadId: string) => {
      setSnoozeRecords((current) => {
        if (current[threadId] === undefined) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      rpc.call("snooze_clear", { threadId }).catch(() => refetchSnoozes());
    },
    [rpc, refetchSnoozes],
  );
  // "Pick a time…" dialog target: the thread id waiting on a custom wake
  // time, null when no dialog is open.
  const [snoozeDialogFor, setSnoozeDialogFor] = useState<string | null>(null);
  // "Group…" picker target: the thread id whose card menu opened the group
  // picker, null when closed. The thread may leave the board while it is
  // open; the render closes quietly, like the snooze picker.
  const [groupDialogFor, setGroupDialogFor] = useState<string | null>(null);

  // Manual column orders, keyed by columnRankKey. A column with no stored
  // order stays in the derived order and shows no drag affordance, so the
  // board never implies a reorder it will silently drop.
  const [ranks, setRanks] = useState<RankStore>({});
  // A rank write the host rejected (issue #232: the failure path used to
  // refetch the stored order silently, so an optimistic landing fell back
  // with no word — the operator's rank writes never reached the KV and the
  // card fell back on every drag against the rejecting host). The next
  // gesture clears it.
  const [rankSaveError, setRankSaveError] = useState<string | null>(null);
  const refetchRanks = useCallback(() => {
    rpc.call("rank_list").then(
      // Guarded, not trusted: the zod contract says `orders` is there, but a
      // host running a different plugin build could answer without it, and
      // an unvalidated `undefined` would throw during render and take the
      // whole board down over an optional feature.
      (result) => {
        const orders = (result as { orders?: unknown }).orders;
        if (orders !== undefined && orders !== null && typeof orders === "object") {
          setRanks(orders as RankStore);
        }
      },
      () => {}, // Ranking is optional state; the board works without it.
    );
  }, [rpc]);
  useEffect(() => {
    refetchRanks();
  }, [refetchRanks]);
  useRealtime("rank-changed", () => {
    refetchScheduler.schedule("ranks", refetchRanks);
  });

  // Feature groups (the family boxes): the registry (names) and the
  // per-thread assignments, both optional state — the board renders a plain
  // board without them. One group-changed signal per surface (menu, CLI,
  // another panel) refetches both shapes.
  const [groupRegistry, setGroupRegistry] = useState<Record<string, { name: string; createdAt: string }>>({});
  const [groupAssignments, setGroupAssignments] = useState<Record<string, string>>({});
  const refetchGroups = useCallback(() => {
    rpc.call("groups_list").then(
      (result) => {
        setGroupRegistry(result.groups);
        setGroupAssignments(result.memberships);
      },
      () => {}, // Groups are optional state; the board works without them.
    );
  }, [rpc]);
  useEffect(() => {
    refetchGroups();
  }, [refetchGroups]);
  useRealtime("group-changed", () => {
    refetchScheduler.schedule("groups", refetchGroups);
  });
  const setThreadGroup = useCallback(
    (threadId: string, groupId: string | null) => {
      // Optimistic; the group-changed refetch settles the truth — including
      // any prune the write caused (the last unassigned group vanishes).
      setGroupAssignments((current) => {
        const next = { ...current };
        if (groupId === null) delete next[threadId];
        else next[threadId] = groupId;
        return next;
      });
      rpc.call("group_set", { threadId, groupId }).catch(() => refetchGroups());
    },
    [rpc, refetchGroups],
  );
  /** Create a named group and assign the thread to it — one gesture. */
  const createAndAssignGroup = useCallback(
    (threadId: string, name: string) => {
      rpc
        .call("group_create", { name })
        .then((created: unknown) => {
          const group = (created as { group: { id: string; name: string; createdAt: string } })
            .group;
          // The registry record lands from the response, not from the echo:
          // realtime is ephemeral (a signal can fail to deliver — the SDK
          // documents the reconcile path), and the board drops an assignment
          // whose group id the registry doesn't know yet, so betting on the
          // group-changed refetch left the card unboxed and the picker's
          // list without the new group. Same optimistic pattern the
          // rename/delete writers use; the echo's refetch still settles.
          setGroupRegistry((current) =>
            current[group.id] !== undefined
              ? current
              : { ...current, [group.id]: { name: group.name, createdAt: group.createdAt } },
          );
          setThreadGroup(threadId, group.id);
        })
        .catch(() => refetchGroups());
    },
    [rpc, refetchGroups, setGroupRegistry, setThreadGroup],
  );
  /**
   * Rename a registry group in place. Optimistic (the shared record means
   * one write re-labels every member card); the group-changed refetch
   * settles the truth.
   */
  const renameGroup = useCallback(
    (groupId: string, name: string) => {
      setGroupRegistry((current) =>
        current[groupId] === undefined
          ? current
          : { ...current, [groupId]: { ...current[groupId], name } },
      );
      rpc.call("group_rename", { groupId, name }).catch(() => refetchGroups());
    },
    [rpc, refetchGroups],
  );
  /**
   * Delete a registry group outright: the record AND every member's
   * assignment go server-side (archived holders included). Optimistic like
   * the rename; assignments to the dead id leave the board's state up front.
   */
  const deleteGroup = useCallback(
    (groupId: string) => {
      setGroupRegistry((current) => {
        const next = { ...current };
        delete next[groupId];
        return next;
      });
      setGroupAssignments((current) => {
        const next: Record<string, string> = {};
        for (const [threadId, assigned] of Object.entries(current)) {
          if (assigned !== groupId) next[threadId] = assigned;
        }
        return next;
      });
      rpc.call("group_delete", { groupId }).catch(() => refetchGroups());
    },
    [rpc, refetchGroups],
  );

  // The sidebar view refreshes over its own realtime subscription, but
  // archive/unarchive changes also bump the pane's button state and the
  // archived lookup that keeps the pane usable after archiving. Only the
  // pane needs archived threads (the board's columns exclude them; archived
  // children render only as rows under their live parent), so a minimal shape
  // from the SDK list is enough.
  const [archiveTick, setArchiveTick] = useState(0);
  const [archivedThreads, setArchivedThreads] = useState<
    readonly {
      id: string;
      title: string | null;
      titleFallback: string | null;
      href: string | null;
    }[]
  >([]);
  useEffect(() => {
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      callback: (event) => {
        if (event.entity === "thread" && event.changes.includes("archived-changed")) {
          setArchiveTick((tick) => tick + 1);
        }
      },
    });
    return unsubscribe;
  }, [sdk]);
  useEffect(() => {
    let cancelled = false;
    sdk.threads
      .list({ archived: true, limit: 200 })
      .then(
        (result) => {
          if (!cancelled) {
            setArchivedThreads(
              result.map((thread) => ({
                id: thread.id,
                title: thread.title,
                titleFallback: thread.titleFallback,
                // The pane's open menu reuses the row href for its
                // in-browser and copy-link destinations; archived rows from
                // older SDK views may not carry one.
                href: "href" in thread && typeof thread.href === "string" ? thread.href : null,
              })),
            );
          }
        },
        () => {}, // Archived lookup is best-effort; the board works without it.
      );
    return () => {
      cancelled = true;
    };
  }, [sdk, archiveTick]);

  const [groupBy, setGroupBy] = useState<GroupBy>(() =>
    // "section"/"environment" were dropped in 0.1.4; stale stored values fall
    // back to the default below. The new "parent" grouping is added in this
    // sashay and validated by parseGroupStored.
    parseGroupStored(
      readStored(
        GROUP_BY_KEY,
        ["none", "status", "recency", "project", "provider", "machine", "parent", "group"],
        "status",
      ),
    ),
  );
  // Tracker item base per project, for ticket-chip link-outs: GitHub slug
  // when the remote resolves as one, forgejo base otherwise. Best-effort:
  // a failed or non-GitHub lookup just means chips render without links.
  // Re-runs when the sidebar project list changes (new project, or a
  // late-arriving remote) so the map is never a stale one-shot snapshot.
  const [repoBaseByProject, setRepoBaseByProject] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    sdk.projects
      .list()
      .then(
        (projectList) => {
          if (cancelled) return;
          const next: Record<string, string> = {};
          for (const project of projectList) {
            const slug = resolveRepoSlug(project.gitRemoteUrl);
            if (slug !== null) {
              next[project.id] = `https://github.com/${slug}`;
            } else {
              // Forgejo/Cove remote: the base item URLs build on, so #N text
              // refs gain hrefs and ride tracker_validate like GitHub ones.
              const base = forgejoItemBase(project.gitRemoteUrl);
              if (base !== null) next[project.id] = base;
            }
          }
          setRepoBaseByProject(next);
        },
        () => {}, // Link-out is optional; the board works without it.
      );
    return () => {
      cancelled = true;
    };
  }, [sdk, projects]);
  const repoBaseFor = useCallback(
    (projectId: string): string | null => repoBaseByProject[projectId] ?? null,
    [repoBaseByProject],
  );
  const [filter, setFilter] = useState<FilterState>(() => ({
    projects: new Set(readStoredList(`${FILTER_KEY}:projects`)),
    providers: new Set(readStoredList(`${FILTER_KEY}:providers`)),
    states: new Set(parseStoredStateFilter(readStoredList(`${FILTER_KEY}:states`))),
    groups: new Set(readStoredList(`${FILTER_KEY}:groups`)),
    familyRootId: readStoredText(`${FILTER_KEY}:family`, "") || undefined,
  }));
  const [search, setSearch] = useState<string>(() => readStoredText(SEARCH_KEY, ""));
  // R3 "Nest child threads" toggle, default ON, persisted like groupBy.
  const [nestChildren, setNestChildren] = useState<boolean>(() =>
    parseNestStored(readStored(NEST_CHILDREN_KEY, ["on", "off"], "on")),
  );
  // D5a parent-lane board lane order: recency (default) or project grouping.
  const [parentLaneOrder, setParentLaneOrder] = useState<ParentLaneOrder>(() =>
    parseParentLaneOrderStored(readStored(PARENT_LANE_ORDER_KEY, ["recency", "project"], "recency")),
  );
  // Collapsed family cards and the idle-children filter are deliberate-toggle
  // sets that now live on the bb server (one plugin KV row, lib/family-state),
  // not in browser localStorage: the same fold and hide read on every window
  // AND every machine. Both start empty and hydrate from `family_state_list`
  // just below; each set only ever records deliberate toggles, so an id absent
  // from it renders expanded / not hidden.
  const [collapsedFamilies, setCollapsedFamilies] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [hideIdleFamilies, setHideIdleFamilies] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // A family-state write the host rejected (the fold/idle toggle did not
  // save): the toggle rolls back to the server's truth and this names the
  // failure. Null when the last write landed.
  const [familyStateSaveError, setFamilyStateSaveError] = useState<string | null>(
    null,
  );
  // Flips true once the first server read (or its migration) has settled, so
  // the one-time localStorage migration below runs exactly once per mount.
  const familyStateHydratedRef = useRef(false);
  const refetchFamilyState = useCallback(() => {
    rpc.call("family_state_list").then(
      (result) => {
        // Guarded, not trusted: the zod contract says both arrays are there,
        // but a host running a different plugin build could answer without
        // them, and an unvalidated `undefined` would throw during the read
        // (the rank refetch's same guard).
        const raw = result as { collapsedFamilies?: unknown; hideIdleChildren?: unknown };
        const server: FamilyStateStore = {
          collapsedFamilies: Array.isArray(raw.collapsedFamilies)
            ? raw.collapsedFamilies.filter((id): id is string => typeof id === "string")
            : [],
          hideIdleChildren: Array.isArray(raw.hideIdleChildren)
            ? raw.hideIdleChildren.filter((id): id is string => typeof id === "string")
            : [],
        };
        const firstRead = !familyStateHydratedRef.current;
        familyStateHydratedRef.current = true;
        if (firstRead) {
          // One-time migration: the server row is the truth from here on. If
          // it is empty and localStorage still holds folds (an operator
          // upgrading from the localStorage era), union them in; only a
          // successful write retires the legacy keys, so a failed migration
          // keeps the folds on screen and retries on the next load.
          const localCollapsed = parseCollapsedFamiliesStored(
            readStoredText(COLLAPSED_FAMILIES_KEY, ""),
          );
          const localHideIdle = parseHideIdleChildrenStored(
            readStoredText(HIDE_IDLE_CHILDREN_KEY, ""),
          );
          const migration = familyStateMigration(server, {
            collapsedFamilies: [...localCollapsed],
            hideIdleChildren: [...localHideIdle],
          });
          if (migration !== null) {
            rpc
              .call("family_state_merge", {
                collapsedFamilies: [...migration.collapsedFamilies],
                hideIdleChildren: [...migration.hideIdleChildren],
              })
              .then(
                (merged) => {
                  setCollapsedFamilies(new Set(merged.collapsedFamilies));
                  setHideIdleFamilies(new Set(merged.hideIdleChildren));
                  clearStored(COLLAPSED_FAMILIES_KEY);
                  clearStored(HIDE_IDLE_CHILDREN_KEY);
                },
                () => {
                  // The migration write failed: keep the folds on screen and
                  // leave the legacy keys in place so the next load retries.
                  setCollapsedFamilies(new Set(migration.collapsedFamilies));
                  setHideIdleFamilies(new Set(migration.hideIdleChildren));
                },
              );
            return;
          }
          // Server authoritative (or nothing to migrate): retire the keys.
          clearStored(COLLAPSED_FAMILIES_KEY);
          clearStored(HIDE_IDLE_CHILDREN_KEY);
        }
        setCollapsedFamilies(new Set(server.collapsedFamilies));
        setHideIdleFamilies(new Set(server.hideIdleChildren));
      },
      () => {}, // Family fold state is optional; the board works without it.
    );
  }, [rpc]);
  useEffect(() => {
    refetchFamilyState();
  }, [refetchFamilyState]);
  // A fold or hide written by any surface (another window, another machine,
  // the migration above) converges here through the coalesced refetch.
  useRealtime("family-state-changed", () => {
    refetchScheduler.schedule("familyState", refetchFamilyState);
  });
  // Collapsed family boxes: the GROUP ids whose dashed boxes fold into one
  // normal-size card. Same deliberate-toggle-only shape as the family fold:
  // an id absent from the stored list renders expanded, and a corrupt stored
  // list degrades to every box expanded.
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() =>
    parseCollapsedGroupsStored(readStoredText(COLLAPSED_GROUPS_KEY, "")),
  );
  // Board wallpaper: a versioned settings document (single global layer
  // today; per-project / per-group overrides extend the same document).
  const [wallpaper, setWallpaper] = useState<WallpaperSettings>(() =>
    parseWallpaperStored(readStoredText(WALLPAPER_KEY, "")),
  );
  const persistWallpaper = useCallback((next: WallpaperSettings) => {
    setWallpaper(next);
    writeStored(WALLPAPER_KEY, wallpaperStoredValue(next));
  }, []);
  // The paint's anchor point: the panel root's box, read by
  // useWallpaperPaintFrame (components/wallpaper-paint.tsx) to place the
  // wallpaper relative to the window, not to the panel.
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Appearance tab: the card-transport read and the motion override, backed
  // by the same tolerant localStorage stores every other board preference
  // uses. Defaults keep today's board untouched (the dissolve plays; the
  // OS media query rules motion).
  const [cardTransport, setCardTransport] = useState<CardTransportPref>(() =>
    parseCardTransportStored(readStoredText(CARD_TRANSPORT_KEY, "")),
  );
  const persistCardTransport = useCallback((value: CardTransportPref) => {
    setCardTransport(value);
    writeStored(CARD_TRANSPORT_KEY, cardTransportStoredValue(value));
  }, []);
  // The Motion settings pair (components/preferences.ts): the follow-system
  // checkbox and the notched slider. Yesterday's stored tri-state carries
  // over through parseMotionSettings; the persist paths write both keys.
  const [motionFollow, setMotionFollow] = useState<boolean>(() =>
    parseMotionSettings(readStoredText(MOTION_PREF_KEY, ""), readStoredText(MOTION_PACING_KEY, "")).follow,
  );
  const [motionPacing, setMotionPacing] = useState<MotionPacing>(() =>
    parseMotionSettings(readStoredText(MOTION_PREF_KEY, ""), readStoredText(MOTION_PACING_KEY, "")).pacing,
  );
  const persistMotion = useCallback((follow: boolean, pacing: MotionPacing) => {
    const stored = motionSettingsStoredValues(follow, pacing);
    writeStored(MOTION_PREF_KEY, stored.pref);
    writeStored(MOTION_PACING_KEY, motionPacingStoredValue(stored.pacing));
    setMotionFollow(follow);
    setMotionPacing(pacing);
  }, []);
  // Cross-window propagation (the storage listener): a second bb window's
  // panel is a second document over the same localStorage, and its writes
  // fire a `storage` event reaching every document but its own. The wallpaper
  // document hydrates wholesale through its normal parser and the group-box
  // fold through set-delta application. The FAMILY fold and idle-hide sets no
  // longer ride this listener: they now live on the server and converge
  // through the `family-state-changed` signal above, so they follow a second
  // window AND a second machine. Scalar keys (groupBy, search, paneWidth,
  // motion, card transport, the per-dimension filter keys) are
  // last-write-wins by design: each write owns its whole key, so no hydration
  // is needed and none runs.
  const hydrateWallpaper = useCallback((_oldRaw: string | null, newRaw: string | null) => {
    setWallpaper(parseWallpaperStored(newRaw ?? ""));
  }, []);
  const hydrateCollapsedGroups = useCallback(
    (oldRaw: string | null, newRaw: string | null) => {
      setCollapsedGroups((current) =>
        applyStoredSetDelta(current, oldRaw, newRaw, parseCollapsedGroupsStored),
      );
    },
    [],
  );
  useCrossWindowStorage([
    { key: COLLAPSED_GROUPS_KEY, onRemoteChange: hydrateCollapsedGroups },
    { key: WALLPAPER_KEY, onRemoteChange: hydrateWallpaper },
  ]);
  // Appearance tab: the board lane direction's read. Vertical keeps today's
  // column board; horizontal reads every lane as a row (issue #153). Backed
  // by the same tolerant store; the choice hands straight to the Board.
  const [laneDirection, setLaneDirection] = useState<LaneDirectionPref>(() =>
    parseLaneDirectionStored(readStoredText(LANE_DIRECTION_KEY, "")),
  );
  const persistLaneDirection = useCallback((value: LaneDirectionPref) => {
    setLaneDirection(value);
    writeStored(LANE_DIRECTION_KEY, laneDirectionStoredValue(value));
  }, []);
  // Scheme read for the wallpaper's dark variant: the hook lives with the
  // media-query hooks and flips live (a change listener, no reload).
  const darkScheme = usePrefersDarkScheme();
  // The open pane lives in the panel's URL subPath (`t/<threadId>`), not in
  // component state, so bb's back arrow, a reload, and deep links all land on
  // the pane the user left. The ref mirrors the last pushed thread id; sync
  // and push use it to tell an external route change from an echo of our own.
  const paneThreadId = paneThreadIdFromSubPath(subPath);
  const pushedThreadIdRef = useRef<string | null>(null);
  // Fallback pane id for hosts whose toPluginPanel cannot push (returns
  // false): pane state then lives in component state alone — no back-arrow
  // restoration, but the board stays fully usable.
  const [fallbackPaneThreadId, setFallbackPaneThreadId] = useState<string | null>(null);
  const openThreadId = paneThreadId ?? fallbackPaneThreadId;
  // Sweep arm state: at most one armed column at a time. The candidate id
  // list is captured at arm time and frozen — late arrivals never join.
  const [armedSweep, setArmedSweep] = useState<ArmedSweep | null>(null);
  // A confirmed sweep in flight: sequential archives with per-card progress
  // (throbber on the active card, highlight kept on the rest). Null when idle.
  const [sweepRun, setSweepRun] = useState<SweepRunView | null>(null);
  // Cancel flag for the live run: read by the runner between archives.
  // A ref, not state — cancelling must not re-render the loop's inputs.
  const sweepCancelRef = useRef(false);
  // A finished sweep's summary ("3 failed: ...", or a cancelled run's undo
  // offer). Null when nothing needs saying.
  const [sweepNotice, setSweepNotice] = useState<SweepNotice | null>(null);
  // Stable dismiss: the Board's auto-dismiss timer effect keys on it.
  const clearSweepNotice = useCallback(() => setSweepNotice(null), []);
  // The browser-reveal gesture's honest outcome (a thread with no
  // controlled tab, a stuck-hidden tab, a listing failure). Null when
  // everything surfaced — the side panel itself is that feedback.
  const [browserNotice, setBrowserNotice] = useState<BrowserRevealNotice | null>(null);
  const clearBrowserNotice = useCallback(() => setBrowserNotice(null), []);
  // The amber group highlight (issue #86): the feature group the last group
  // click marked. Split groups render a frame per lane; the highlight makes
  // the whole footprint legible in one gesture. Board state is not persisted:
  // a click elsewhere clears it (see Board's background click).
  const [highlightedGroupId, setHighlightedGroupId] = useState<string | null>(null);
  const disarmSweep = useCallback(() => setArmedSweep(null), []);
  // Click-away and Escape disarm only an idle arm — and only from outside
  // the armed column: its cards' clicks toggle the sweep selection, so the
  // hook needs the column id to spare them. A running sweep is not armed
  // for this hook at all; it cannot be dismissed out from under itself.
  useSweepClickAway(
    armedSweep !== null && sweepRun === null ? armedSweep.columnId : null,
    disarmSweep,
  );
  // Sweep mode is manual from here: arming pre-selects the past-threshold
  // candidates (armSweepFor), then every card click in the column flips its
  // membership. Live-child parents are refused by the Board itself and
  // never reach this toggle.
  const toggleSweepSelectionFor = useCallback((threadId: string) => {
    setArmedSweep((current) =>
      current === null ? current : toggleSweepSelection(current, threadId),
    );
  }, []);
  // A shift-click's range joins the live selection additively (lib/sweep's
  // addSweepSelection: union, curated membership untouched). The Board
  // computes the ids; this only applies them to the armed state.
  const addSweepSelectionFor = useCallback((threadIds: readonly string[]) => {
    setArmedSweep((current) =>
      current === null ? current : addSweepSelection(current, threadIds),
    );
  }, []);
  // The sweep's way out: during a run, stop before the next archive; in an
  // idle armed mode, exit. One X button serves both, labeled per state.
  const cancelSweepFor = useCallback(() => {
    if (sweepRun !== null) {
      sweepCancelRef.current = true;
      return;
    }
    setArmedSweep(null);
  }, [sweepRun]);
  // What's new: two "seen" models, picked by the running build. A stable
  // build compares versions: a fresh install (nothing stored) is stamped
  // silently — everything is new, so nothing counts as new — and an upgrade
  // pulses until the modal is opened. A prerelease build (dev's
  // "0.6.0-dev") keys "seen" to the [Unreleased] group's content instead:
  // its fingerprint is stamped silently on first load, and the button pulses
  // again whenever the group's bullets change (each merge to dev). Opening
  // marks seen; the button itself never leaves.
  const [lastSeenVersion, setLastSeenVersion] = useState<string | null>(
    () => readLastSeenVersion(),
  );
  const [lastSeenUnreleased, setLastSeenUnreleased] = useState<string | null>(
    () => readLastSeenUnreleased(),
  );
  useEffect(() => {
    if (lastSeenVersion === null) {
      writeLastSeenVersion(APP_VERSION);
      setLastSeenVersion(APP_VERSION);
    }
  }, [lastSeenVersion]);
  // The unreleased fingerprint is NOT stamped at load: a fresh dev build
  // pulses its standing group until opened (see hasUnseenWhatsNew); only
  // opening the tab records it as seen (openSettings).
  const whatsNewUnseen = hasUnseenWhatsNew({
    runningVersion: APP_VERSION,
    lastSeenVersion,
    unreleasedFingerprint: CURRENT_UNRELEASED_FINGERPRINT,
    lastSeenUnreleasedFingerprint: lastSeenUnreleased,
  });
  // Opening the modal on What's new marks the changelog seen — the same
  // side effect the standalone What's-new modal owned before it became a
  // tab; opening on Behavior (the plain gear) touches nothing. The per-line
  // amber ground truth resolves BEFORE the baseline overwrite: the fresh
  // set (leads the stored per-item list had not yet seen) is held in state
  // so the deep-linked tab renders exactly the new lines amber, then the
  // store extends with every current lead.
  const [unreleasedNewLeads, setUnreleasedNewLeads] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const activateWhatsNew = () => {
    const leads = currentUnreleasedLeads();
    setUnreleasedNewLeads(unseenUnreleasedLeads(leads, readLastSeenUnreleasedItems()));
    writeLastSeenUnreleasedItems(unreleasedItemFingerprints(leads));
    writeLastSeenUnreleased(CURRENT_UNRELEASED_FINGERPRINT);
    setLastSeenUnreleased(CURRENT_UNRELEASED_FINGERPRINT);
    writeLastSeenVersion(APP_VERSION);
    setLastSeenVersion(APP_VERSION);
  };
  const openSettings = useCallback((tab: SettingsTab) => {
    if (tab === "whats-new") {
      activateWhatsNew();
    }
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);
  const handleTabChange = useCallback((tab: SettingsTab) => {
    if (tab === "whats-new") {
      activateWhatsNew();
    }
    setSettingsTab(tab);
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("behavior");
  // The delta is captured at load (before opening marks it seen): a dev
  // build leads with its unreleased group; stable builds show entries since
  // the stored version when one is pending, all recent entries otherwise.
  // The unreleased entry rides its per-line unseen set so amber marks only
  // what is genuinely new to this reader.
  const whatsNewEntries: readonly WhatsNewEntry[] = useMemo(
    () =>
      whatsNewEntriesFor(
        APP_VERSION,
        whatsNewUnseen,
        lastSeenVersion,
        unreleasedNewLeads,
      ),
    [whatsNewUnseen, lastSeenVersion, unreleasedNewLeads],
  );
  // ---- The attention freeze (components/attention-freeze).
  // A card the operator attends to — the pointer on it, or the pane open on
  // it — holds the placement captured at attention time: its lane, its slot,
  // its family's lane claim, its row on the parent view. Live data churn
  // re-sorts the board AROUND the attended placement; the placement rules
  // run again the moment attention releases (mouse out / pane close).
  // User-initiated placements (drops, rank moves, menu actions, pane
  // toggles) strip the pin first so the gesture's move lands; the recapture
  // effect below re-pins the settled result.
  // Pending state-claim writes (below, the one-shot lane-reveal claims):
  // armed at gesture time with the write's expected resulting state, and
  // consumed the commit the board reflects it. The attention recapture
  // reads them as its in-flight marker — see the recapture effect.
  const pendingStateClaimsRef = useRef<
    Map<string, { field: "isPinned" | "isUnread"; value: boolean }>
  >(new Map());
  const [paneCapture, setPaneCapture] = useState<AttentionCapture | null>(null);
  const [paneLaneCapture, setPaneLaneCapture] = useState<LaneCapture | null>(null);
  // Hover captures live in refs, never state (issue #186's frontend half). As
  // state, every pointer landing on a card rebuilt the board: the freeze plan
  // fed the assembly, `columns` got a fresh identity, and every card
  // re-rendered — measured 335 ThreadCard renders per hover enter on a
  // 478-card board, which dropped a phone to 4-13fps while idle held 60fps.
  // Idle held 60fps, so hovering WAS the whole per-frame cost.
  //
  // A hover is not board state: the board's order is a pure function of the
  // thread data, so a pointer landing on a card changes nothing the board
  // renders. These refs hold the pin each attended card captured at enter
  // time, and the board build (below) reads them and applies the pins as a
  // placement CONSTRAINT — so a data-driven build still keeps the attended
  // card in its captured slot, while the hover that CREATES the capture
  // renders zero cards. The pane's captures stay state on purpose: opening a
  // pane IS a render-worthy change.
  const hoverCapturesRef = useRef<Map<string, AttentionCapture>>(new Map());
  const hoverLaneCapturesRef = useRef<Map<string, LaneCapture>>(new Map());
  // The board build each hovered id last saw: the assembly object (column
  // board) or the lane list (parent board), read from the latest-value bridge
  // at enter time. Attention leave compares the recorded build against the
  // CURRENT one: if the board rebuilt while the pointer rested on the card,
  // that build applied the pin and the card may now sit at a stale slot, so
  // the release forces one rebuild to run the live placement rules again. If
  // the build is unchanged, the pin was never applied to a rendered board (it
  // equals the live placement), so the release renders nothing — the common
  // case a hover sweep wants cheap. Comparing the build OBJECT is the pure way
  // to ask "did the board rebuild": the build memos mint a fresh object
  // exactly when they recompute, so identity is the rebuild signal.
  const hoverEnterBuildRef = useRef<Map<string, unknown>>(new Map());
  const [hoverRebuildEpoch, setHoverRebuildEpoch] = useState(0);
  // The capture's inputs (assembly, parent lanes, family index) arrive later
  // in the render; the ref bridges them to the event-time capture callbacks —
  // the same latest-value pattern the scroll managers run.
  const attentionInputRef = useRef<{
    parent: boolean;
    view: GroupBy;
    assembly: ReturnType<typeof assembleBoard> | null;
    parentLanes: readonly ParentLane[] | null;
    parentOf: ReadonlyMap<string, string>;
  } | null>(null);
  // Capture one attention on the column board (components/attention-freeze's
  // captureColumnAttention): the focus card's rendered lane and slot and its
  // family root's card. Group members are deliberately absent — under the
  // split default the group renders across lanes on purpose.
  const captureThreadAttention = useCallback(
    (threadId: string, origin: AttentionOrigin): AttentionCapture | null => {
      const input = attentionInputRef.current;
      if (input === null) return null;
      return captureColumnAttention(threadId, input, origin, Date.now());
    },
    [],
  );
  const capturePaneAttention = useCallback((threadId: string): void => {
    const input = attentionInputRef.current;
    if (input === null) return;
    if (input.parent) {
      // The parent view's freeze is a lane-order capture, not a column one.
      setPaneCapture(null);
      setPaneLaneCapture(
        input.parentLanes === null
          ? null
          : laneCaptureOf(input.parentLanes, threadId, {
              origin: "selection",
              capturedAt: Date.now(),
            }),
      );
      return;
    }
    setPaneLaneCapture(null);
    setPaneCapture(captureThreadAttention(threadId, "selection"));
  }, [captureThreadAttention]);
  // Strip the pin for every thread a user-initiated placement touched, so
  // the gesture's write lands instead of snapping the attended card back.
  const releaseAttentionFor = useCallback((removedIds: ReadonlySet<string>) => {
    setPaneCapture((current) =>
      current === null ? null : stripCapturedIds(current, removedIds),
    );
    // The hover pins are stripped in place: the gesture's write lands
    // unpinned, so the relocated card lands where the placement rules put it
    // instead of snapping back to the slot it was hovered at.
    const hover = hoverCapturesRef.current;
    if (hover.size > 0) {
      const next = new Map<string, AttentionCapture>();
      for (const [threadId, capture] of hover) {
        next.set(threadId, stripCapturedIds(capture, removedIds));
      }
      hoverCapturesRef.current = next;
    }
    setPaneLaneCapture((current) =>
      current === null
        ? null
        : removedIds.has(current.focusId)
          ? // Keep the focus; the placement is void until the recapture pass
            // re-pins the gesture's settled result (an all-empty lane id
            // matches no lane, so the void capture pins nothing meanwhile).
            { ...current, laneId: "", laneIndex: -1, row: null }
          : current,
    );
    const hoverLanes = hoverLaneCapturesRef.current;
    if (hoverLanes.size > 0) {
      const next = new Map<string, LaneCapture>();
      for (const [threadId, capture] of hoverLanes) {
        next.set(
          threadId,
          removedIds.has(threadId) ? { ...capture, laneId: "", laneIndex: -1, row: null } : capture,
        );
      }
      hoverLaneCapturesRef.current = next;
    }
  }, []);
  // On attention: capture the entered card's rendered placement (its lane
  // and slot; on the parent view, its lane order slot and row). The capture
  // replaces nothing — a per-thread map, so sibling cards (nested rows
  // under an attended family card) hold their own pins independently.
  const attentionEnter = useCallback(
    (threadId: string) => {
      const input = attentionInputRef.current;
      if (input === null) return;
      if (input.parent) {
        const capture =
          input.parentLanes === null
            ? null
            : laneCaptureOf(input.parentLanes, threadId, {
                origin: "hover",
                capturedAt: Date.now(),
              });
        if (capture === null) return;
        hoverLaneCapturesRef.current.set(threadId, capture);
        hoverEnterBuildRef.current.set(threadId, input.parentLanes);
        return;
      }
      const capture = captureThreadAttention(threadId, "hover");
      if (capture === null) return;
      hoverCapturesRef.current.set(threadId, capture);
      hoverEnterBuildRef.current.set(threadId, input.assembly);
    },
    [captureThreadAttention],
  );
  // Off attention: release that card's pin. If the board rebuilt while the
  // pointer rested on the card, that build applied the pin and the card may
  // now sit at a stale slot, so the release forces one rebuild to run the live
  // placement rules again. If the build object is unchanged, the pin was never
  // applied to a rendered board, so the release renders nothing — the common
  // case for a hover sweep, and the one that keeps hovering phone-cheap.
  const attentionLeave = useCallback((threadId: string) => {
    hoverCapturesRef.current.delete(threadId);
    hoverLaneCapturesRef.current.delete(threadId);
    const enteredBuild = hoverEnterBuildRef.current.get(threadId);
    hoverEnterBuildRef.current.delete(threadId);
    const currentBuild = attentionInputRef.current?.parent
      ? attentionInputRef.current.parentLanes
      : attentionInputRef.current?.assembly;
    if (enteredBuild !== undefined && enteredBuild !== currentBuild) {
      setHoverRebuildEpoch((epoch) => epoch + 1);
    }
  }, []);

  const persistGroupBy = useCallback((value: GroupBy) => {
    setGroupBy(value);
    writeStored(GROUP_BY_KEY, value);
  }, []);
  const persistFilter = useCallback((next: FilterState) => {
    setFilter(next);
    writeStored(`${FILTER_KEY}:projects`, JSON.stringify([...next.projects]));
    writeStored(`${FILTER_KEY}:providers`, JSON.stringify([...next.providers]));
    writeStored(`${FILTER_KEY}:states`, JSON.stringify([...next.states]));
    writeStored(`${FILTER_KEY}:groups`, JSON.stringify([...(next.groups ?? [])]));
    // The family scope (Zoom to family) stores a bare id: a cleared scope
    // writes "" so the stored value keeps its single honest shape.
    writeStored(`${FILTER_KEY}:family`, next.familyRootId ?? "");
  }, []);
  const persistSearch = useCallback((value: string) => {
    setSearch(value);
    writeStored(SEARCH_KEY, value);
  }, []);
  // Zoom-to-group (a group box's context-menu entry) is a landing gesture,
  // not a chip write: it switches the view to the Group board AND restricts
  // the existing group-restrict set to exactly that group — the two
  // persisted surfaces the toolbar's View menu and group dropdown already
  // drive, never a second, parallel filter state.
  const zoomToGroup = useCallback(
    (groupId: string) => {
      persistGroupBy("group");
      persistFilter({ ...filter, groups: new Set([groupId]) });
    },
    [filter, persistFilter, persistGroupBy],
  );

  const persistNestChildren = useCallback((enabled: boolean) => {
    setNestChildren(enabled);
    writeStored(NEST_CHILDREN_KEY, nestStoredValue(enabled));
  }, []);
  const persistParentLaneOrder = useCallback((value: ParentLaneOrder) => {
    setParentLaneOrder(value);
    writeStored(PARENT_LANE_ORDER_KEY, value);
  }, []);
  // Deliberate-toggle sets: state is the UI's source of truth, the mount
  // run repairs a corrupt stored list once (repairStoredList), and every
  // local mutation writes its one-id delta against the stored list as it
  // stands at that instant (toggleStoredSetId), so a concurrent bb window's
  // unrelated fold survives. There is deliberately NO state-driven whole-set
  // write-back effect: one built from possibly stale state is exactly what
  // erased another bb window's fold (issue #245). This path now covers the
  // per-GROUP box fold only — the per-FAMILY fold and idle-hide sets moved to
  // the server row above (lib/family-state).
  useEffect(() => {
    repairStoredList(COLLAPSED_GROUPS_KEY, parseCollapsedGroupsStored, collapsedGroupsStoredValue);
  }, []);
  // The per-family fold: optimistic local state for an instant chevron, then
  // the server write. A rejected write rolls the toggle back to the server's
  // truth and names the failure (never a silent unsaved fold).
  const setFamilyCollapsed = useCallback(
    (parentId: string, collapsed: boolean) => {
      setCollapsedFamilies((current) => {
        const next = new Set(current);
        if (collapsed) next.add(parentId);
        else next.delete(parentId);
        return next;
      });
      rpc
        .call("family_state_set", { key: "collapsedFamilies", id: parentId, on: collapsed })
        .catch((error: unknown) => {
          refetchFamilyState();
          setFamilyStateSaveError(
            error instanceof Error ? error.message : String(error),
          );
        });
    },
    [rpc, refetchFamilyState],
  );
  // The idle-children hide: same optimistic write and same rollback.
  const setFamilyHideIdle = useCallback(
    (parentId: string, hide: boolean) => {
      setHideIdleFamilies((current) => {
        const next = new Set(current);
        if (hide) next.add(parentId);
        else next.delete(parentId);
        return next;
      });
      rpc
        .call("family_state_set", { key: "hideIdleChildren", id: parentId, on: hide })
        .catch((error: unknown) => {
          refetchFamilyState();
          setFamilyStateSaveError(
            error instanceof Error ? error.message : String(error),
          );
        });
    },
    [rpc, refetchFamilyState],
  );
  // The collapsed group boxes keep the localStorage write discipline: a local
  // toggle updates this window's state and writes its one-id delta against
  // the stored list (a concurrent bb window's fold survives), the mount run
  // repairs a corrupt stored list once, and a remote window's toggle hydrates
  // through the storage listener above. This per-GROUP fold is a deliberate
  // non-goal of the family-state move (see the pull request).
  const setGroupCollapsed = useCallback((groupId: string, collapsed: boolean) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (collapsed) next.add(groupId);
      else next.delete(groupId);
      return next;
    });
    toggleStoredSetId(
      COLLAPSED_GROUPS_KEY,
      groupId,
      collapsed,
      parseCollapsedGroupsStored,
      collapsedGroupsStoredValue,
    );
  }, []);

  // The sidebar view pushes fresh thread data continuously; this signal
  // additionally fires on host-side changes so cards never sit stale.
  useRealtime("thread-list-changed", () => {});

  // The family pipeline runs on the NON-HIDDEN set. Archived threads are
  // included here but are hidden by the pipeline itself: buildFamilyIndex —
  // the single authoritative hide — drops them, so an archived child renders
  // nowhere (in either board view) and a child of an archived parent
  // re-roots. assembleBoard keeps them out of the columns in both modes.
  const nonHiddenThreads = useMemo(
    () => threads.filter((thread) => !thread.isHidden),
    [threads],
  );
  const liveThreads = useMemo(
    () => nonHiddenThreads.filter((thread) => !thread.isArchived),
    [nonHiddenThreads],
  );

  // The filter dropdowns' row sources, derived from the board's live set the
  // way the columns are: project and provider ids, and the Group filter's
  // buckets — every assigned id on the board (registry names, "Unknown
  // group" for a record-less assignment) plus the "No group" sentinel when
  // an unassigned thread sits on the board.
  const filterOptions = useMemo(() => {
    const projectIds = new Set<string>();
    const providerIds = new Set<string>();
    const buckets = new Set<string>();
    let unassigned = false;
    for (const thread of liveThreads) {
      projectIds.add(thread.projectId);
      providerIds.add(thread.providerId);
      const groupId = groupAssignments[thread.id];
      if (groupId === undefined) unassigned = true;
      else buckets.add(groupId);
    }
    const groupOptions: readonly { id: string; label: string }[] = [
      ...[...buckets].map((id) => ({
        id,
        label: groupRegistry[id]?.name ?? "Unknown group",
      })),
      ...(unassigned ? [{ id: NO_GROUP_BUCKET, label: "No group" }] : []),
    ].sort((a, b) => a.label.localeCompare(b.label));
    return { projectIds, providerIds, groupOptions };
  }, [liveThreads, groupAssignments, groupRegistry]);

  // The Board's hide-a-lane gesture (Project and Group views): the lane's
  // project (or group) leaves its filter's selection — the same write the
  // filter menu's checkbox for that bucket would make, so the menu restores
  // the lane. The Board carries the report; refusals (the board's only
  // known lane of its kind, or a lane standing outside the selection
  // through box overrides) say why. The Group filter's known buckets are
  // the menu's own row list, the No-group sentinel included (its lane
  // hides and restores like any other).
  const hideLane = useCallback(
    (columnId: string): LaneHideOutcome => {
      const isGroup = groupBy === "group";
      const outcome = filterBucketsWithoutLane(
        isGroup ? (filter.groups ?? new Set()) : filter.projects,
        isGroup
          ? filterOptions.groupOptions.map((option) => option.id)
          : projects.map((project) => project.id),
        columnId,
      );
      if (outcome.kind === "hidden") {
        persistFilter(
          isGroup ? { ...filter, groups: outcome.next } : { ...filter, projects: outcome.next },
        );
      }
      return outcome.kind === "hidden" ? { kind: "hidden" } : outcome;
    },
    [groupBy, filter, projects, filterOptions, persistFilter],
  );
  // The board card's label for a thread's project (lib/project-name): rows
  // from the sidebar's project list render their real name; bb's personal
  // project and unresolvable ids render "No project" — the term bb's own
  // New-thread picker uses for that state, so the board-card label and the
  // composer's picker name the same project state alike. The composer's
  // label text itself lives in bb core (get-bb/bb#5340).
  const projectNameFor = useCallback(
    (projectId: string) =>
      projectDisplayName(projectId, {
        personalProjectId: projects.find((project) => project.isPersonal)?.id,
        projects,
      }),
    [projects],
  );
  // The chip row each card shows, exactly as ThreadCard derives it
  // (cardTicketRefs): text refs after the tracker_validate gate, plus the
  // board's store links. Toolbar search matches this set, so typing "#38"
  // finds every card carrying a #38 chip — including the store-link case
  // whose title and branch never say #38.
  const ticketRefsFor = useCallback((thread: PluginSidebarThread) => {
    const branch = thread.environment?.branchName ?? thread.host?.name ?? "";
    return cardTicketRefs({
      title: thread.displayTitle,
      branch,
      ...(repoBaseByProject[thread.projectId] !== undefined
        ? { repoHrefBase: repoBaseByProject[thread.projectId] }
        : {}),
      linkedIssues: linksByThread[thread.id],
      validatedHrefs,
    });
  }, [repoBaseByProject, linksByThread, validatedHrefs]);
  // The feature-group name each card renders (registry + per-thread
  // assignment). Toolbar search matches it: typing a group's name surfaces
  // its member cards, exactly like typing a project or branch name does.
  const groupNameFor = useCallback(
    (thread: PluginSidebarThread): string => {
      const groupId = groupAssignments[thread.id];
      return groupId === undefined ? "" : (groupRegistry[groupId]?.name ?? "");
    },
    [groupAssignments, groupRegistry],
  );
  // Family-aware filtering replaces per-thread filtering when nesting is ON:
  // a family passes when any member matches, non-matching members render
  // dimmed (archived members are hidden outright by the family index, so
  // they never appear here at all) — except a project-filter miss, which
  // drops the member outright: project selection is a column gate, so a
  // dim-kept member in an unselected project never projects a column.
  // Nesting OFF means a fully flat board — per-thread filtering again. The
  // "parent" grouping overrides that (D11): the nesting toggle is inert
  // there, and lane mode always filters family-first (D10 keep-and-dim).
  const familyIndex = useMemo(() => buildFamilyIndex(nonHiddenThreads), [nonHiddenThreads]);
  // The feature-group assignment map (thread id → group id) as a stable Map
  // for the filter pass AND the grouping context below: the group filter
  // needs the bucket per thread everywhere the per-thread predicate runs,
  // in both board views.
  const groupsByThread = useMemo(
    () => new Map<string, string>(Object.entries(groupAssignments)),
    [groupAssignments],
  );
  const familyFiltered = useMemo(
    () =>
      nestChildren || groupBy === "parent"
        ? filterFamilies(nonHiddenThreads, familyIndex, filter, search.trim(), projectNameFor, ticketRefsFor, groupNameFor, groupsByThread, Date.now(), errorAckIds)
        : filterIndividually(nonHiddenThreads, filter, search.trim(), projectNameFor, ticketRefsFor, groupNameFor, groupsByThread, Date.now(), errorAckIds),
    [nestChildren, groupBy, nonHiddenThreads, familyIndex, filter, search, projectNameFor, ticketRefsFor, groupNameFor, groupsByThread, errorAckIds],
  );
  // The feature-group plan (issue #86's split default): which groups render
  // a box, and each member's box identity. The plan claims NO lane —
  // members render where their own data places them, and the frame wraps
  // each lane's slice (a lone slice included). Computed over the FULL
  // non-hidden set — a member a search hid is dimmed inside its passing
  // box, never dropped from the group's count.
  // The FAMILY lane still beats the PANE's natural-lane capture ("family
  // wins") — EXCEPT while a card's attention freeze is live: an attended
  // card holds its rendered placement over every claim, and the family
  // lanes run again the moment the attention releases. A capture taken
  // under another grouping is inert here (its lane names a grouping that no
  // longer runs).
  // The attention freeze is compiled INSIDE the board builds below, from the
  // pane capture (state) plus the hover captures (refs). The pane capture is a
  // dep of those builds; the hover captures are read from their refs so a
  // hover alone never rebuilds — the pin lands at the next DATA-driven build,
  // which is exactly when it has something to hold against. `hoverRebuildEpoch`
  // is the one exception: a hover RELEASE that follows a build forces a
  // rebuild so the live placement rules can move the card back.
  //
  // The grouping context, extended once with the feature-group maps: under
  // the "group" grouping `columnFor` resolves a thread's column from its
  // assignment (so the split group's frames agree with the natural group
  // columns — no overrides needed). Other groupings ignore the extra fields.
  const groupContext = useMemo(
    () => ({
      projects,
      providers,
      groupsByThread,
      groupNames: new Map(Object.entries(groupRegistry).map(([id, group]) => [id, group.name])),
    }),
    [projects, providers, groupsByThread, groupRegistry],
  );
  // Column placement only (the sweep reads the stamps): a Jira Done check in
  // flight keeps its card in Done.
  const placedDoneIds = useMemo(
    () => boardDoneIds(doneIds, jiraState.enabled, jiraState.threads),
    [doneIds, jiraState.enabled, jiraState.threads],
  );
  // Jira on: a card with a reason line (nudge, deeper check, failed Done check) reads as Needs you.
  const jiraNeedsYou = useMemo(
    () => (jiraState.enabled ? new Set(Object.keys(jiraState.threads).filter((id) => jiraState.threads[id]!.reason !== null)) : undefined),
    [jiraState.enabled, jiraState.threads],
  );
  const groupBoxPlan = useMemo(
    () =>
      planGroupBoxes(
        liveThreads,
        groupsByThread,
        groupContext.groupNames,
        groupBy,
        groupContext,
        placedDoneIds,
        Date.now(),
      ),
    [liveThreads, groupsByThread, groupContext, groupBy, placedDoneIds],
  );
  // ONE keep pass: the family filter is the board's only filter rule. The
  // retired group-box pass re-gated its input and dropped dimmed family
  // members whenever a frame existed (Defect 1 of the derived ruleset);
  // deletion restores the plan's decision 4 — a passing family renders
  // whole, misses dimmed, frames never re-gate.
  const filtered = familyFiltered.kept;
  const dimmedIds = familyFiltered.dimmedIds;

  const searchActive = search.trim() !== "";
  // Search runs inside filterFamilies (it keeps the whole family on a hit and
  // dims non-matching members), so `searched` is just the kept set.
  const searched = filtered;

  // Single assembly: buildColumns → nestUnderParents. The nesting result's
  // map (not the raw family index) drives which children render as nested
  // rows, so a promoted or cross-axis child appears only as its standalone
  // card — never both standalone AND nested. `doneChildrenByParent` drives
  // the Done projection cards. The chip counts come from the assembly too,
  // counted per card's own space (live children on a live card; done rows on
  // a Done card). With nesting OFF the board is flat: no rows, no chips.
  const isParentGroupBy = groupBy === "parent";
  const parentLanes = useMemo(() => {
    if (!isParentGroupBy) return null;
    // The lane freezes are read HERE, not from a memo keyed on the captures
    // (issue #186): the pane's lane capture is state, the hovered cells are
    // refs, and a data-driven rebuild must see the captures as they stand now
    // — a memo that did not recompute on a hover would hand this build a stale
    // snapshot and silently drop the hovered lane's pin.
    const laneFreezes: LaneCapture[] = [];
    if (paneLaneCapture !== null) laneFreezes.push(paneLaneCapture);
    for (const capture of hoverLaneCapturesRef.current.values()) laneFreezes.push(capture);
    return applyLaneFreezes(
      buildParentLanes(searched, placedDoneIds, Date.now(), doneTimes, errorAckIds),
      laneFreezes,
    );
  }, [isParentGroupBy, searched, placedDoneIds, doneTimes, errorAckIds, paneLaneCapture, hoverRebuildEpoch]);
  const parentLaneChildrenByParent = useMemo(
    () => (isParentGroupBy ? familyIndex.childrenByParent : new Map<string, readonly PluginSidebarThread[]>()),
    [isParentGroupBy, familyIndex],
  );
  const assembly = useMemo(() => {
    if (isParentGroupBy) return null;
    return assembleBoard(searched, groupBy, groupContext, EMPTY_FROZEN_COLUMNS, placedDoneIds, Date.now(), {
      nestingEnabled: nestChildren,
      ranks,
      doneTimes,
      attentionFreeze: compileAttentionFreezes([
        ...(paneCapture !== null && paneCapture.view === groupBy ? [paneCapture] : []),
        ...[...hoverCapturesRef.current.values()].filter((capture) => capture.view === groupBy),
      ]),
      errorAcks: errorAckIds,
      needsYou: jiraNeedsYou,
    });
  }, [isParentGroupBy, searched, groupBy, groupContext, placedDoneIds, nestChildren, ranks, doneTimes, paneCapture, errorAckIds, hoverRebuildEpoch, jiraNeedsYou]);
  const columns = assembly?.columns ?? [];
  // The map that actually renders as nested rows (nesting rules applied, so a
  // promoted, un-nested, or cross-axis child is absent — expanding the card
  // could never reveal it). Stable across renders.
  const nestedChildrenByParent = assembly?.nestedChildrenByParent ?? EMPTY_NESTED;
  // The capture bridge (attention-freeze): refreshed every render, read at
  // attention events and in the recapture effect below.
  attentionInputRef.current = {
    parent: isParentGroupBy,
    view: groupBy,
    assembly,
    parentLanes,
    parentOf: familyIndex.parentOf,
  };
  // Attention recapture: re-resolve every live capture against the current
  // board. A user-initiated placement stripped its pin first (release-
  // AttentionFor above), so the strip's write lands unpinned and this pass
  // re-pins the settled placement. A pin nothing stripped rebuilds to its
  // pinned placement — the pass is a no-op (capturesEqual) — and a focus
  // whose card left the board prunes its capture.
  // The in-flight guard: a capture whose strip is a gesture's own write
  // (armed as a pendingStateClaim, consumed the commit the board reflects
  // the written value) must NOT rebuild yet — the board still renders the
  // pre-gesture placement, and rebuilding would re-pin the stale lane right
  // over the gesture's move (a read card's Mark Unread from the pane sat in
  // its idle lane until the pane closed — reported 2026-10-13). Keep the
  // strip; the landing consumes the claim and the next pass re-pins.
  useEffect(() => {
    const inFlight = pendingStateClaimsRef.current;
    const settled = (threadId: string): boolean => !inFlight.has(threadId);
    setPaneCapture((current) => {
      if (current === null) return current;
      if (!settled(current.focusId)) return current;
      const rebuilt = captureThreadAttention(current.focusId, current.origin);
      return capturesEqual(rebuilt, current) ? current : rebuilt;
    });
    // The hover captures live in refs (issue #186): re-resolve them in place
    // and force ONE rebuild only when the settled placement actually moved
    // (a gesture wrote a new lane). A pass that reproduces every capture is a
    // no-op, so a data refresh does not re-render the board through this path.
    let hoverChanged = false;
    const hover = hoverCapturesRef.current;
    for (const [threadId, capture] of hover) {
      if (!settled(threadId)) continue;
      const rebuilt = captureThreadAttention(threadId, capture.origin);
      if (rebuilt !== null && capturesEqual(rebuilt, capture)) continue;
      hoverChanged = true;
      if (rebuilt !== null) hover.set(threadId, rebuilt);
      else hover.delete(threadId);
    }
    setPaneLaneCapture((current) => {
      if (current === null) return current;
      if (!settled(current.focusId)) return current;
      const input = attentionInputRef.current;
      if (input === null || !input.parent || input.parentLanes === null) return current;
      const rebuilt = laneCaptureOf(input.parentLanes, current.focusId, {
        origin: current.origin,
        capturedAt: current.capturedAt,
      });
      return rebuilt !== null && rebuilt.laneId === current.laneId && rebuilt.laneIndex === current.laneIndex
        ? current
        : rebuilt ?? null;
    });
    let hoverLaneChanged = false;
    const input = attentionInputRef.current;
    const hoverLanes = hoverLaneCapturesRef.current;
    if (input !== null && input.parent && input.parentLanes !== null) {
      for (const [threadId, capture] of hoverLanes) {
        if (!settled(threadId)) continue;
        const rebuilt = laneCaptureOf(input.parentLanes, threadId, {
          origin: capture.origin,
          capturedAt: capture.capturedAt,
        });
        if (rebuilt === null) {
          hoverLanes.delete(threadId);
          hoverLaneChanged = true;
          continue;
        }
        if (
          rebuilt.laneId !== capture.laneId ||
          rebuilt.laneIndex !== capture.laneIndex ||
          rebuilt.row?.id !== capture.row?.id ||
          rebuilt.row?.index !== capture.row?.index
        ) {
          hoverLanes.set(threadId, rebuilt);
          hoverLaneChanged = true;
        }
      }
    }
    if (hoverChanged || hoverLaneChanged) {
      setHoverRebuildEpoch((epoch) => epoch + 1);
    }
  }, [captureThreadAttention, ranks, doneIds, threads, groupBy, paneCapture, paneLaneCapture]);

  // The old collapsed-family auto-expand is gone: an attention child now
  // un-nests (nesting.ts `childPlacement`) and surfaces as its own card
  // while the folded rows stay folded, so there is no expansion to fire and
  // the persisted collapse never fights the surfacing.

  // Sweep eligibility per sweepable column, computed from the current board
  // data. Arming (in armSweepFor) captures this list at arm time; while a
  // sweep is armed the FROZEN list is what Board displays and what confirm
  // applies — the live recompute is only for the next arm. Only the
  // aged-out arms (Done, A-while-ago) pre-select their past-threshold
  // candidates; Pinned, Unread, and the fresher idle buckets arm empty
  // (sweepArmPreselects) and the operator curates by clicking cards.
  //
  // Sweep-family contract: a thread with ≥1 live (non-archived) child is
  // never sweep-eligible in either aged-out arm; children stay eligible
  // independently. The parent set comes from the full live list, not the
  // column, so cross-column and flat-mode families are covered alike.
  const liveChildParentIds = useMemo(() => {
    const parents = new Set<string>();
    for (const thread of liveThreads) {
      if (thread.parentThreadId !== null) parents.add(thread.parentThreadId);
    }
    return parents;
  }, [liveThreads]);

  // ONE eligibility law for every sweep surface: the Focus view calls this
  // with each column's own threads, the Parent view with a row's cards
  // gathered across every lane (laneRowThreads). Same predicates, same
  // config, same exclusions — so a thread sweepable in one view is
  // sweepable in the other, and one excluded for a pinned/attention/live
  // reason is excluded identically.
  const sweepCandidatesAmong = useCallback(
    (scopeId: string, threads: readonly PluginSidebarThread[]): readonly string[] => {
      const kind = sweepColumnKind(scopeId);
      if (kind === null) return [];
      const now = Date.now();
      // A snoozed thread sleeps through sweeps too: the wake is the whole
      // point of the snooze, so its card is not a sweep candidate — on any
      // arm, aged-out or manually curated (the server-side sweep skips
      // snoozed facts the same way).
      const sweepable = threads.filter(
        (candidate) => !snoozedIds.has(candidate.id),
      );
      switch (kind) {
        case "done":
          return sweepCandidatesForDoneColumn(
            sweepable,
            doneIds,
            doneAgeSource,
            { doneArchiveMs: sweepConfig.doneArchiveMs },
            now,
            liveChildParentIds,
          );
        case "idle-bucket":
          return sweepArmPreselects(scopeId)
            ? sweepCandidatesForIdleColumn(
                sweepable,
                doneIds,
                { idleArchiveMs: sweepConfig.idleArchiveMs, kept: idleKept, jiraEnabled: jiraState.enabled },
                now,
                liveChildParentIds,
                errorAckIds,
              )
            : [];
        // Manual arms: arming enters sweep mode with nothing selected; the
        // operator curates the sweep by clicking cards.
        case "pinned":
        case "unread":
          return [];
        default:
          return [];
      }
    },
    [doneIds, doneAgeSource, idleKept, liveChildParentIds, snoozedIds, sweepConfig, errorAckIds, jiraState.enabled],
  );

  const sweepCandidatesFor = useCallback(
    (columnId: string): readonly string[] => {
      const column = columns.find((candidate) => candidate.id === columnId);
      if (column === undefined) return [];
      return sweepCandidatesAmong(columnId, column.threads);
    },
    [columns, sweepCandidatesAmong],
  );

  // The Parent view's sweep, per ROW: the same law over the row's cards
  // across every family lane. A row exists on every lane, so this is a
  // union; a row that holds nothing sweepable still arms (manual sweep
  // mode), exactly as an empty Focus column does.
  const parentLaneSweepCandidatesFor = useCallback(
    (rowId: string): readonly string[] => {
      if (parentLanes === null) return [];
      return sweepCandidatesAmong(rowId, laneRowThreads(parentLanes, rowId));
    },
    [parentLanes, sweepCandidatesAmong],
  );


  // A Done-column projection card (a live family's Done card) cannot join a
  // sweep either: it is a rendering of a live parent, not a done thread.
  const doneProjectionParentIds = useMemo(
    () => new Set(assembly?.doneChildrenByParent.keys() ?? []),
    [assembly],
  );
  const sweepBlockedIds = useMemo(
    () => new Set([...liveChildParentIds, ...doneProjectionParentIds]),
    [liveChildParentIds, doneProjectionParentIds],
  );

  const armSweepFor = useCallback(
    (columnId: string) => {
      // A running sweep owns the gesture: no re-arming mid-run. And a
      // non-sweepable column never arms — the pill is its only door, and
      // that pill exists only on sweepable lanes.
      if (sweepRun !== null) return;
      if (sweepColumnKind(columnId) === null) return;
      setArmedSweep(armSweep(columnId, sweepCandidatesFor(columnId)));
    },
    [sweepCandidatesFor, sweepRun],
  );

  // The Parent view's arm: the same gesture over a row's cards across every
  // lane. The row id is the armed scope, so the Focus board's confirm,
  // toggle, range, cancel, and undo paths serve this arm unchanged — one
  // armed sweep, two boards that can show it.
  const armParentLaneSweepFor = useCallback(
    (rowId: string) => {
      if (sweepRun !== null) return;
      if (sweepColumnKind(rowId) === null) return;
      setArmedSweep(armSweep(rowId, parentLaneSweepCandidatesFor(rowId)));
    },
    [parentLaneSweepCandidatesFor, sweepRun],
  );

  // visibleRefKey is a sorted, comma-joined snapshot ("owner/repo#42,...").
  // Safe to join: repo slugs cannot contain commas or hashes. It doubles as
  // the effect dependency (cheap string equality) and is re-parsed below.
  const visibleRefKey = useMemo(
    () =>
      liveThreads
        .flatMap((thread) => {
          const repoBase = repoBaseByProject[thread.projectId];
          const repo = repoBase === undefined ? null : resolveRepoSlug(repoBase);
          const branch = thread.environment?.branchName ?? thread.host?.name ?? "";
          // Text refs group under the thread's project repo; the board's own
          // links carry their repo slug, so a link still batches a status
          // lookup even when the project remote is not GitHub.
          return repo === null
            ? linkedRefKeys(linksByThread[thread.id])
            : [
                ...findTicketRefs(thread.displayTitle, { extraText: branch })
                  .filter((ref) => ref.number !== undefined)
                  .map((ref) => `${repo}#${ref.number}`),
                ...linkedRefKeys(linksByThread[thread.id]),
              ];
        })
        .sort()
        .join(","),
    [liveThreads, repoBaseByProject, linksByThread],
  );
  // The operator-moment fingerprint for the chip snapshot (issue #205):
  // pane open/close, a card's lane (threadState under the current error
  // acks), and every display container's order — the assembled columns,
  // the nested and done child rows, and the parent view's lanes. A lane
  // transition or a re-sort changes the join, so the hook refetches with
  // the ref set unchanged; a fingerprint-equal render (the common case)
  // borrows the settled snapshot. "" mirrors the empty ref set.
  const chipRepaintSignal = useMemo(() => {
    if (visibleRefKey === "") return "";
    const parts: string[] = [`pane:${openThreadId ?? "closed"}`];
    const paint = (thread: PluginSidebarThread) => {
      parts.push(
        `${thread.id}:${threadState(thread, errorAckIds)}${doneIds.has(thread.id) ? ":done" : ""}`,
      );
    };
    for (const column of columns) {
      parts.push(`col:${column.id}`);
      for (const thread of column.threads) paint(thread);
    }
    nestedChildrenByParent.forEach((children, parentId) => {
      parts.push(`nested:${parentId}`);
      for (const thread of children) paint(thread);
    });
    const doneRowsByParent = assembly?.doneChildrenByParent ?? EMPTY_NESTED;
    doneRowsByParent.forEach((children, parentId) => {
      parts.push(`doneRow:${parentId}`);
      for (const thread of children) paint(thread);
    });
    if (parentLanes !== null) {
      for (const lane of parentLanes) {
        parts.push(`lane:${lane.id}`);
        for (const row of lane.rows) {
          parts.push(`row:${row.id}`);
          for (const thread of row.threads) paint(thread);
        }
      }
    }
    return parts.join(",");
  }, [visibleRefKey, columns, nestedChildrenByParent, parentLanes, openThreadId, errorAckIds, doneIds, assembly]);
  // Text-ref hrefs across visible threads, the tracker_validate batch (the
  // chip rule: a #N/URL in text chips only when the item is confirmed).
  // Sorted-join mirrors visibleRefKey: cheap string equality as the effect
  // dep, safe join (https hrefs carry no commas).
  const textRefHrefsKey = useMemo(
    () =>
      Array.from(
        new Set(
          liveThreads.flatMap((thread) => {
            const repoBase = repoBaseByProject[thread.projectId];
            const branch = thread.environment?.branchName ?? thread.host?.name ?? "";
            return findTicketRefs(thread.displayTitle, {
              extraText: branch,
              ...(repoBase !== undefined ? { repoHrefBase: repoBase } : {}),
            })
              .map((ref) => ref.href)
              .filter((href): href is string => href !== undefined);
          }),
        ),
      )
        .sort()
        .join(","),
    [liveThreads, repoBaseByProject],
  );
  useEffect(() => {
    if (textRefHrefsKey === "") {
      setValidatedHrefs(new Set());
      return;
    }
    let cancelled = false;
    const urls = textRefHrefsKey.split(",");
    rpc.call("tracker_validate", { urls }).then(
      (result) => {
        if (cancelled) return;
        setValidatedHrefs(
          new Set(
            Object.entries(result.results)
              .filter(([, verdict]) => verdict.confirmed)
              .map(([url]) => url),
          ),
        );
      },
      () => {}, // Validation optional; an empty set just holds text chips back.
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, textRefHrefsKey]);
  // Live tracker status for ticket chips. Batched: one RPC per visible-ref
  // snapshot (numeric refs grouped per repo), re-fetched when the visible
  // ref set changes, on a poll interval, on window focus, and on an
  // operator-moment bump (the repaint fingerprint below — no per-card
  // calls). Failures degrade to "no status known"; the board never breaks
  // on this path.
  const ticketStatuses = useTicketStatuses({ rpc, visibleRefKey, refreshSignal: chipRepaintSignal });

  const statusFor = useCallback(
    (repo: string | null, number: number | undefined) => {
      if (repo === null || number === undefined) return undefined;
      return ticketStatuses[repo]?.[number];
    },
    [ticketStatuses],
  );

  // Live token burn rates for the working dots' pulse (issue #279): one poll
  // for the whole board, nothing while the document is hidden. The lookup is a
  // per-id prop like `statusFor` above, and the card comparator probes its
  // results, so a poll only repaints the cards whose dots actually changed.
  const pulseRates = usePulseRates({ rpc });
  const pulseRateFor = useCallback(
    (threadId: string) => pulseRates.get(threadId),
    [pulseRates],
  );

  const anyFilterActive =
    filter.projects.size > 0 ||
    filter.providers.size > 0 ||
    filter.states.size > 0 ||
    (filter.groups?.size ?? 0) > 0 ||
    filter.familyRootId !== undefined ||
    searchActive;
  // The family scope's chip label (issue #170): the scoped family root's
  // own display title. A stale root (the family is gone) reads "Unknown
  // family" — the chip stays visible so the scope stays clearable.
  const familyScopeLabel = filter.familyRootId === undefined
    ? undefined
    : (sidebarThreads.find((thread) => thread.id === filter.familyRootId)?.displayTitle ??
      "Unknown family");
  // The board's own new-thread composer: a modal over the board and pane, so
  // composing never leaves the surface and bb's new-thread window stays out
  // of the way. The nonce re-focuses the composer editor on every open.
  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  // The thread the composer will spawn a child of, or null for a plain
  // root thread: the "New child thread…" menu actions set it, the toolbar's
  // New Thread clears it. Held as an id, not a thread row — the sidebar
  // cache can refresh underneath and the title resolves fresh at render.
  const [newThreadParentId, setNewThreadParentId] = useState<string | null>(null);
  // The group the composer will spawn INTO and tag the result with ("New
  // thread in group…"): a preset like the parent-child one — the two are
  // mutually exclusive (each opener clears the other).
  const [newThreadGroupId, setNewThreadGroupId] = useState<string | null>(null);
  // The group preset's majority seed (lib/group-spawn-seed): the members'
  // most common project and provider/model pair, resolved by the effect
  // below. Undefined while loading or when no member voted.
  const [newThreadGroupSeed, setNewThreadGroupSeed] = useState<GroupSpawnSeed | undefined>(undefined);
  // The Jira column's Start thread preset (lib/new-thread-seed jiraStartThreadSeed):
  // prompt + pluginMetadata for the composer; cleared when the composer closes.
  const [newThreadJira, setNewThreadJira] = useState<{ key: string; prompt: string; pluginMetadata: SpawnPluginMetadata } | null>(null);
  const startJiraThread = useCallback((ticket: JiraTicket) => {
    setComposerFocusRequest((nonce) => nonce + 1);
    setNewThreadParentId(null);
    setNewThreadGroupId(null);
    setNewThreadGroupSeed(undefined);
    setNewThreadJira({ key: ticket.key, ...jiraStartThreadSeed(ticket, Date.now()) });
    setNewThreadOpen(true);
  }, []);
  const onNewThreadOpenChange = useCallback((open: boolean) => {
    setNewThreadOpen(open);
    if (!open) setNewThreadJira(null);
  }, []);
  const openNewThread = useCallback(() => {
    setComposerFocusRequest((nonce) => nonce + 1);
    setNewThreadParentId(null);
    setNewThreadGroupId(null);
    setNewThreadGroupSeed(undefined);
    setNewThreadOpen(true);
  }, []);
  // The child-spawn entry point the card and pane menus share: same composer,
  // same pane-open flow after the spawn, just preset to nest the result
  // under the acted-on thread.
  const openNewChildThread = useCallback((threadId: string) => {
    setComposerFocusRequest((nonce) => nonce + 1);
    setNewThreadParentId(threadId);
    setNewThreadGroupId(null);
    setNewThreadGroupSeed(undefined);
    setNewThreadOpen(true);
  }, []);
  // The group-spawn entry point (the group box context menu): same composer,
  // preset to tag the result into the acted-on group.
  const openNewThreadInGroup = useCallback((groupId: string) => {
    setComposerFocusRequest((nonce) => nonce + 1);
    setNewThreadParentId(null);
    setNewThreadGroupId(groupId);
    setNewThreadGroupSeed(undefined);
    setNewThreadOpen(true);
  }, []);
  // The composer dialog's "will nest under" hint names where the card will
  // RENDER (issue #120): the display index carries the real edge through the
  // grandchild tier (a child-row preset nests there now), but a thread whose
  // own row is already a sub-row (display depth ≥ 2) shows its spawned thread
  // beside its siblings under the family root — promise where it lands. A
  // parent that left the board (deleted) while the modal is open falls back
  // to its id — the spelling degrades, the spawn still carries the parent.
  const newThreadParent = useMemo(() => {
    if (newThreadParentId === null) return undefined;
    return threads.find((candidate) => candidate.id === newThreadParentId);
  }, [newThreadParentId, threads]);
  const newThreadNest = useMemo(() => {
    if (newThreadParentId === null) return undefined;
    const parent = newThreadParent;
    const parentTitle = parent === undefined ? newThreadParentId : parent.displayTitle;
    const fallback = { nestTitle: parentTitle, spawnParentTitle: undefined as string | undefined };
    if (parent === undefined) return fallback;
    // Display chain walk: two or more displayed edges above the preset
    // parent mean its row is a sub-row tier; the spawned thread's row lands
    // under the family root, and the hint carries the spawn truth beside it.
    const first = familyIndex.parentOf.get(parent.id);
    if (first === undefined) return fallback;
    if (familyIndex.parentOf.get(first) === undefined) return fallback;
    let cursor = familyIndex.parentOf.get(first) as string;
    while (true) {
      const next = familyIndex.parentOf.get(cursor);
      if (next === undefined) break;
      cursor = next;
    }
    const root = threads.find((candidate) => candidate.id === cursor);
    return {
      nestTitle: root === undefined ? cursor : root.displayTitle,
      spawnParentTitle: parent.displayTitle,
    };
  }, [newThreadParentId, newThreadParent, familyIndex, threads]);
  const newThreadParentTitle = newThreadNest?.nestTitle;
  // The composer's project seed (lib/new-thread-seed): a child preset copies
  // its PARENT'S project, so the family keeps landing in one place; a group
  // preset copies the MEMBERS' MAJORITY project (the group's spawn seed) the
  // same way — a preset's copy beats the filter either way; without a preset
  // the rungs descend the ladder — the single filter-selected
  // project, then the board's unanimous project (the threads already here),
  // then the project this board's composer last spawned into (remembered,
  // plugin-scoped localStorage). Only a LOADED picker list may reject a
  // derived or remembered id — a slow project query never wipes the memory,
  // and the composer re-seeds on prop change when the list heals.
  const rememberedProjectKey = rememberedProjectStorageKey(pluginId);
  const [rememberedProjectId, setRememberedProjectId] = useState<
    string | undefined
  >(() => parseRememberedProjectStored(window.localStorage.getItem(rememberedProjectKey)));
  const newThreadProjectId = useMemo(
    () =>
      newThreadSeedProjectId({
        parentProjectId:
          newThreadGroupId !== null
            ? newThreadGroupSeed?.projectId
            : newThreadParent?.projectId,
        filterProjectId:
          filter.projects.size === 1 ? [...filter.projects][0] : undefined,
        derivedProjectId: newThreadDerivedProjectId(
          searched
            .filter((thread) => !thread.isArchived)
            .map((thread) => thread.projectId),
        ),
        rememberedProjectId,
        personalProjectId: projects.find((project) => project.isPersonal)?.id,
        knownProjectIds: projects.map((project) => project.id),
        knownProjectsLoaded: sidebarStatus === "ready",
      }),
    [newThreadParent, newThreadGroupId, newThreadGroupSeed, filter.projects, searched, rememberedProjectId, projects, sidebarStatus],
  );
  // The composer's environment seed (lib/new-thread-seed's full ladder): a
  // parent whose checkout is a worktree seeds the `reuse` variant so the
  // child starts in the parent's checkout (plain/unknown checkouts express
  // nothing from a row); otherwise the remembered-ENVIRONMENT rung — the
  // environment the composer resolved on the picked project's last
  // successful spawn (e.g. the "(new) worktree" pick), keyed per project in
  // plugin-scoped localStorage so a `reuse` memory of project A never seeds
  // project B. No project resolved: no memory read either — the environment
  // memory is a companion to the project memory, never a stand-alone pick.
  const rememberedEnvironmentsKey = rememberedEnvironmentStorageKey(pluginId);
  const [rememberedEnvironments, setRememberedEnvironments] = useState<
    Record<string, NewThreadEnvironmentArgs> | undefined
  >(() =>
    parseRememberedEnvironmentStored(
      window.localStorage.getItem(rememberedEnvironmentsKey),
    ),
  );
  // The write path merges from this mirror, so the callback can stay free of
  // stale-map closures regardless of how often it re-creates.
  const rememberedEnvironmentsRef = useRef(rememberedEnvironments);
  rememberedEnvironmentsRef.current = rememberedEnvironments;
  const rememberSpawnEnvironment = useCallback(
    (projectId: string, environment: NewThreadEnvironmentArgs) => {
      const next = {
        ...(rememberedEnvironmentsRef.current ?? {}),
        [projectId]: environment,
      };
      window.localStorage.setItem(
        rememberedEnvironmentsKey,
        rememberedEnvironmentStoredValue(next),
      );
      setRememberedEnvironments(next);
    },
    [rememberedEnvironmentsKey],
  );
  const newThreadEnvironmentSeed = useMemo(
    () =>
      newThreadSeedEnvironmentForProject({
        parentEnvironment: newThreadParent?.environment,
        rememberedEnvironment:
          newThreadProjectId !== undefined
            ? rememberedEnvironments?.[newThreadProjectId]
            : undefined,
      }),
    [newThreadParent, newThreadProjectId, rememberedEnvironments],
  );
  // The group preset's seed fetch: the members' votes (project + provider
  // from each row; model from the SDK's resolved defaultExecutionOptions —
  // the same chain the server's autotitle probe clones a spawn from),
  // majority-voted by lib/group-spawn-seed. A member that resolves nothing
  // casts no vote; a fetch failure leaves the composer's own defaults in
  // charge — a failed seed must not block the composer from opening. The
  // preset runs only while the modal is open; a closed modal clears it.
  useEffect(() => {
    if (!newThreadOpen || newThreadGroupId === null) {
      setNewThreadGroupSeed(undefined);
      return;
    }
    let cancelled = false;
    const members = threads.filter(
      (candidate) =>
        !candidate.isArchived && groupAssignments[candidate.id] === newThreadGroupId,
    );
    void Promise.all(
      members.map(async (member) => {
        let model: string | null = null;
        try {
          const options = await sdk.threads.defaultExecutionOptions({ threadId: member.id });
          model = options?.model ?? null;
        } catch {
          model = null; // a member that cannot resolve casts no vote
        }
        return {
          projectId: member.projectId,
          providerId: member.providerId,
          model,
        };
      }),
    ).then((votes) => {
      if (!cancelled) setNewThreadGroupSeed(majorityGroupSpawnSeed(votes));
    });
    return () => {
      cancelled = true;
    };
  }, [newThreadOpen, newThreadGroupId, threads, groupAssignments, sdk]);
  // Expand ("maximize") the board composer into bb's main new-thread view:
  // the seeds and the composer's stored prompt text ride along, the main
  // view focuses the prompt, and the board's own draft is KEPT — a maximize
  // is a close, not a spawn (lib/compose-maximize). A child preset cannot
  // follow — the main view cannot spawn a nested thread — so the modal only
  // gets the maximize button while no child preset is armed.
  const maximizeNewThread = useCallback(() => {
    maximizeComposerToMainView({
      navigate,
      storage: window.localStorage,
      projectId: newThreadProjectId,
      // The main view's hand-off only carries the `reuse` variant (an
      // environment id); a remembered `(new) worktree` pick has no id to
      // transfer, so the main view keeps its own environment default.
      environmentId:
        newThreadEnvironmentSeed?.type === "reuse"
          ? newThreadEnvironmentSeed.environmentId
          : undefined,
    });
    setNewThreadOpen(false);
  }, [navigate, newThreadProjectId, newThreadEnvironmentSeed]);
  // A freshly spawned thread is not in the sidebar cache on the tick the
  // pane route opens, and the pane only renders for a resolvable thread.
  // The spawn result stands in until the cache carries the thread (this row
  // then clears and the cached thread — with live status — wins).
  const [provisionalSpawn, setProvisionalSpawn] = useState<{
    id: string;
    displayTitle: string;
    status: ThreadPaneThread["status"];
  } | null>(null);
  useEffect(() => {
    if (
      provisionalSpawn !== null &&
      sidebarThreads.some((thread) => thread.id === provisionalSpawn.id)
    ) {
      setProvisionalSpawn(null);
    }
  }, [sidebarThreads, provisionalSpawn]);
  // Archived riders sit in `searched` when nesting is ON (they stay under
  // their parent); board-level counts stay live-thread counts.
  const boardCount = useMemo(
    () => searched.filter((thread) => !thread.isArchived).length,
    [searched],
  );
  const emptyBecauseFiltered = liveThreads.length > 0 && boardCount === 0 && anyFilterActive;

  // The open pane's thread can vanish from the active view (archived,
  // deleted); the archived list keeps it resolvable so the pane stays open
  // with an Unarchive button. Only deletion closes the pane.
  // The open pane's thread can vanish from the active view (archived,
  // deleted); the archived list keeps it resolvable so the pane stays open
  // with an Unarchive button. Only deletion closes the pane.
  const openThreadActive = threads.find((thread) => thread.id === openThreadId) ?? null;
  const openThreadArchived =
    openThreadActive === null && openThreadId !== null
      ? (archivedThreads.find((thread) => thread.id === openThreadId) ?? null)
      : null;
  const personalProjectId = projects.find((project) => project.isPersonal)?.id;
  const openThread: ThreadPaneThread | null =
    openThreadActive !== null
      ? {
          id: openThreadActive.id,
          displayTitle: openThreadActive.displayTitle,
          status: openThreadActive.status,
          isUnread: openThreadActive.isUnread,
          isPinned: openThreadActive.isPinned,
          href: openThreadActive.href,
          context: paneContextInfo(openThreadActive, {
            personalProjectId,
            projects,
          }),
        }
      : openThreadArchived !== null
        ? {
            id: openThreadArchived.id,
            displayTitle:
              openThreadArchived.title ?? openThreadArchived.titleFallback ?? openThreadArchived.id,
            status: "idle",
            isUnread: false,
            isPinned: false,
            // Older stored archived rows predate href; the app-relative
            // thread route is the same URL the sidebar row carries.
            href: openThreadArchived.href ?? `/threads/${openThreadArchived.id}`,
          }
        : provisionalSpawn !== null && provisionalSpawn.id === openThreadId
          ? {
              id: provisionalSpawn.id,
              displayTitle: provisionalSpawn.displayTitle,
              status: provisionalSpawn.status,
              isUnread: false,
              isPinned: false,
              href: `/threads/${provisionalSpawn.id}`,
            }
          : null;

  const openThreadIsArchived =
    openThreadId === null
      ? false
      : (threads.some(
          (thread) => thread.id === openThreadId && !thread.isArchived,
        )
          ? false
          : archivedThreads.some((thread) => thread.id === openThreadId));

  // "/" is the board's search gesture, live only with no pane open (the
  // pane's chat input owns keystrokes while it is up).
  const searchInputRef = useRef<HTMLInputElement>(null);
  useSearchFocusOnSlash({ enabled: openThread === null, searchInputRef });

  // The configured New Thread shortcut key, live only from the overview
  // board with no pane open (the hotkey's guards own the rest: editable
  // targets, dialogs, modifier chords). While the composer itself is open
  // the hotkey drops, so a stray second press cannot reseed the preset.
  useNewThreadComposerShortcut({
    enabled: openThread === null && !newThreadOpen,
    hotkey: newThreadShortcutKey ?? "",
    onActivate: openNewThread,
  });

  // Opening (or switching) a pane pushes a panel route, so every pane is one
  // history entry and the back arrow walks back through the cards the user
  // opened — reopening a trail of panes they lost track of. Closing replaces
  // instead, so × / Escape do not multiply entries. A failed push (host route
  // owner unavailable — older bb, exotic embeds) falls back to the pane still
  // opening locally, which keeps the board usable without URL state.
  const openThreadCard = useCallback(
    (threadId: string) => {
      pushedThreadIdRef.current = threadId;
      const rejected = pushRejected(() =>
        navigate.toPluginPanel(PANEL_PATH, {
          subPath: paneSubPathFor(threadId),
        }),
      );
      // The attention freeze: the pane's card captures its rendered
      // placement (lane, slot, family lane, lane view) at open time.
      capturePaneAttention(threadId);
      if (rejected && openThreadId !== threadId) {
        // Without a working history integration the subPath never changes, so
        // open locally: the pane opens now and closes via onClose below.
        setFallbackPaneThreadId(threadId);
      }
    },
    [navigate, openThreadId, capturePaneAttention],
  );

  // Reference chips in the pane (issue #161): labels resolve from the board's
  // current rows — live sidebar threads first, then the archived list — and
  // routing splits on what the board knows: a listed thread opens in the
  // pane (the surface the operator is already on), an unlisted one goes to
  // bb's main thread view (any thread id works there), and a project chip
  // opens that project. The memo keeps the pane's decoration effect from
  // re-firing on unrelated rerenders; unknown labels paint the raw id and
  // fill in on the next scan when the rows catch up.
  const referenceMentions = useMemo<ReferenceMentions>(
    () => ({
      labels: {
        threadLabel: (threadId) => {
          const archived = archivedThreads.find(
            (archived) => archived.id === threadId,
          );
          return (
            threads.find((thread) => thread.id === threadId)?.displayTitle ??
            archived?.title ??
            archived?.titleFallback ??
            null
          );
        },
        projectLabel: (projectId) => {
          const row = projects.find((project) => project.id === projectId);
          if (row === undefined) return null;
          return projectDisplayName(projectId, {
            personalProjectId: projects.find((project) => project.isPersonal)?.id,
            projects,
          });
        },
      },
      onOpen: (reference) => {
        if (reference.kind === "project") {
          navigate.toProject(reference.id);
          return;
        }
        const listed =
          threads.some((thread) => thread.id === reference.id) ||
          archivedThreads.some((archived) => archived.id === reference.id);
        if (listed) openThreadCard(reference.id);
        else navigate.toThread(reference.id);
      },
    }),
    [threads, archivedThreads, projects, navigate, openThreadCard],
  );

  // The composer modal resolved a spawn: remember the project it landed in
  // (the remembered rung of the seed ladder, fed from the submit success
  // path — a failed spawn never writes), file the provisional row, then
  // open the new thread in the pane (route push + frozen column as usual).
  const handleSpawnedThread = useCallback(
    (thread: SpawnedThread) => {
      const key = rememberedProjectStorageKey(pluginId);
      window.localStorage.setItem(key, rememberedProjectStoredValue(thread.projectId));
      setRememberedProjectId(thread.projectId);
      setProvisionalSpawn({
        id: thread.id,
        displayTitle: thread.title ?? thread.titleFallback ?? thread.id,
        status: thread.status,
      });
      openThreadCard(thread.id);
    },
    [pluginId, openThreadCard],
  );
  // The group tag every successful composer spawn carries, resolved from
  // the armed presets (lib/group-inheritance): the explicit "New thread in
  // group…" preset, or — the operator's decided design, metadata at spawn —
  // a child preset's inheritance of its parent's membership. A resolver
  // miss (root spawn, ungrouped parent) writes nothing: a plain spawn never
  // clears an assignment. The optimistic assign + the group-changed
  // refetch (setThreadGroup) settle the box on the board.
  const handleComposerSpawnedThread = useCallback(
    (thread: SpawnedThread) => {
      const groupId = spawnInheritedGroupId({
        presetGroupId: newThreadGroupId,
        parentThreadId: newThreadParentId,
        parentGroupId:
          newThreadParentId !== null ? groupAssignments[newThreadParentId] : undefined,
      });
      if (groupId !== undefined) {
        setThreadGroup(thread.id, groupId);
      }
      handleSpawnedThread(thread);
    },
    [
      newThreadGroupId,
      newThreadParentId,
      groupAssignments,
      setThreadGroup,
      handleSpawnedThread,
    ],
  );

  // The Jira column's data, on top of the chips' value (unchanged while Jira is off).
  const jiraBoardValue = useMemo<JiraBoardValue>(() => {
    if (!jiraState.enabled) return jiraValue;
    const titleOf = new Map(threads.map((t) => [t.id, t.displayTitle]));
    const threadsByKey = jiraThreadsByKey(jiraState.threads, jiraState.autoLinks, titleOf);
    const suggestions: Record<string, { threadId: string; title: string }[]> = {};
    for (const x of jiraState.suggestions) (suggestions[x.key] ??= []).push({ threadId: x.threadId, title: titleOf.get(x.threadId) ?? x.threadId });
    const act = (input: Parameters<typeof jiraRpc.call<"jira_column_action">>[1]) => {
      jiraRpc.call("jira_column_action", input).then(refetchJira, () => {});
    };
    return {
      ...jiraValue,
      onSnooze: (threadId) => snoozeUntil(threadId, presetWakeAt("tomorrow9", new Date())),
      column: {
        tickets: Object.values(jiraState.tickets).filter((t) => t.assignedToMe && t.statusCategory !== "done"),
        threadsByKey,
        suggestions,
        drift: jiraState.drift,
        stale: jiraState.stale,
        snapshotAgeMs: jiraState.snapshotAge,
        error: jiraState.error,
        onStartThread: startJiraThread,
        onLink: (key, threadId) => act({ action: "link", key, threadId }),
        onDismiss: (key, threadId) => act({ action: "dismiss-suggestion", key, threadId }),
        onFix: (d, opts) => act({ action: "fix", key: d.key, kind: d.kind, ...opts }),
        onOpenThread: openThreadCard,
        pending: jiraState.pending,
      },
    };
  }, [jiraValue, jiraState, threads, jiraRpc, refetchJira, startJiraThread, openThreadCard, snoozeUntil]);
  const boardColumns = useMemo(() => withJiraColumn(columns, groupBy, jiraState.enabled), [columns, groupBy, jiraState.enabled]);

  const closeThreadPane = useCallback(() => {
    pushedThreadIdRef.current = null;
    const rejected = pushRejected(() => navigate.toPluginPanel(PANEL_PATH, { subPath: "" }));
    if (rejected && openThreadId !== null) {
      // The rejected push never settles, so the route effect's close branch
      // does not run: release the attention pin here instead — fallback mode
      // owns the pane without URL state, and this close is the whole story.
      setFallbackPaneThreadId(null);
      setPaneCapture(null);
      setPaneLaneCapture(null);
    }
  }, [navigate, openThreadId]);

  // The URL is the source of truth for the pane. A subPath change that our
  // own push did not cause — bb's back arrow, a shared deep link, a reload —
  // must move the pane, including closing it. The pushed-id ref identifies
  // echoes: a push is only settled once the subPath prop actually carries the
  // pushed id, so a dropped push (route owner said no) leaves no stale marker
  // and the next back navigation still wins.
  useEffect(() => {
    const action = paneRouteAction(paneThreadId, pushedThreadIdRef.current);
    if (action.kind === "settle-open") {
      pushedThreadIdRef.current = null;
      return;
    }
    if (action.kind === "settle-close") {
      // A close settle — ours (closeThreadPane's push landing) or the board's
      // back arrow walking to the plain board — releases the attention pin
      // the open captured; the placement rules run again from here on.
      pushedThreadIdRef.current = null;
      setFallbackPaneThreadId(null);
      setPaneCapture(null);
      setPaneLaneCapture(null);
      return;
    }
    // External navigation onto a thread the board has open elsewhere in its
    // history: adopt the URL's thread so the pane follows the route owner.
    // The freeze is captured once per adopted thread — live thread updates
    // must never re-freeze, or a thread that moved placements would slide the
    // card after the fact (the same contract a click-opened pane has); the
    // recapture pass below is the only re-pin, and it reads the pinned board.
    const adoptId = action.threadId;
    setFallbackPaneThreadId(null);
    setPaneCapture((current) => {
      if (current !== null && current.focusId === adoptId) return current;
      const rebuilt = captureThreadAttention(adoptId, "selection");
      return rebuilt;
    });
    setPaneLaneCapture((current) => {
      if (current !== null && current.focusId === adoptId) return current;
      const input = attentionInputRef.current;
      if (input === null || !input.parent || input.parentLanes === null) return current;
      return laneCaptureOf(input.parentLanes, adoptId, {
        origin: "selection",
        capturedAt: Date.now(),
      });
    });
  }, [paneThreadId, captureThreadAttention]);

  // Project creation needs a host checkout path; the personal workspace's
  // host hosts every project, so create under the first known host.
  const createProject = useCallback(
    async (name: string) => {
      const hosts = await sdk.hosts.list();
      if (hosts.length === 0) {
        throw new Error("No connected host to create the project checkout on.");
      }
      const host = hosts.find((candidate) => candidate.lifecycle?.phase === "active") ?? hosts[0];
      await sdk.projects.create({
        name,
        source: {
          type: "local_path",
          hostId: host.id,
          path: `~/bb-projects/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        },
      });
    },
    [sdk],
  );

  // One-shot lane-reveal claims (menu moves). Every menu action that
  // relocates a card — Pin/Unpin, Mark Done/Not Done, Mark Read/Unread —
  // moves a card the pane never opened, and the destination lane (Pinned
  // far left, Done far right) can sit offscreen in a scrolled board: the
  // action reads as the card silently vanishing from where it was.
  //
  // The board only follows the OPEN card (its keep-in-view effect), and it
  // must not follow the DATA (passive status flips and host-side changes
  // would yank the user's place) — so the board gets an intent CLAIM
  // instead. Pin/Read ride the host bridge: the state (with it, the
  // relocation) lands in a later render than the click, so rather than fire
  // the reveal at click time, the run arms a pending claim that the effect
  // below consumes the moment the thread's observable state matches — landing
  // the reveal request in the same commit the card relocates. Done/Unread
  // are local and optimistic: their runs fire the reveal directly, batched
  // with the state change (Board processes it post-relocation).
  //
  // A claim that outlives its action (the host never applies the requested
  // state) fires later, on the next state match — still the user's intent.
  const [revealRequest, setRevealRequest] = useState<{
    threadId: string;
    seq: number;
  } | null>(null);
  const revealSeqRef = useRef(0);
  const requestReveal = useCallback((threadId: string) => {
    revealSeqRef.current += 1;
    setRevealRequest({ threadId, seq: revealSeqRef.current });
  }, []);
  useEffect(() => {
    const claims = pendingStateClaimsRef.current;
    if (claims.size === 0) return;
    for (const [threadId, claim] of claims) {
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (thread === undefined || thread[claim.field] !== claim.value) continue;
      claims.delete(threadId);
      requestReveal(threadId);
    }
    // Consumes per threads update while claims are armed; the deletion (and
    // requestReveal's own setState) is the re-run trigger.
  }, [threads, requestReveal]);

  // The Pinned lane-exit rule. A pinned card leaving the Pinned lane (a
  // cross-column drop or the menu's Mark Done) un-pins as part of the
  // gesture — column placement derives from the pin, so the pin must go
  // with it or the card bounces straight back into Pinned on the next
  // grouping pass. But the un-pinned pin is PARKED, not destroyed: the park
  // marker rides board-owned thread metadata (lib/pin-park), and the state
  // writes that bring the card back to the operator — Mark Not Done, Mark
  // Unread — restore the pin exactly as it stood before the gesture. A
  // same-lane reorder (including within Pinned) is claimed by the card's
  // reorder path and never reaches any of these helpers.
  const parkPin = useCallback(
    (threadId: string) => {
      setParkIds((current) => new Set(current).add(threadId));
      rpc
        .call("pin_park_set", { threadId, parked: true })
        .catch(() => {
          // Roll the optimistic park back when the server rejects: a pin
          // the server never parked must not be restorable.
          setParkIds((current) => {
            const next = new Set(current);
            next.delete(threadId);
            return next;
          });
        });
    },
    [rpc, setParkIds],
  );
  const clearParkPin = useCallback(
    (threadId: string) => {
      // An explicit board pin write expresses current intent and beats any
      // parked value, so every Pin/Unpin wipe clears it. No park, no write.
      if (!parkIds.has(threadId)) return;
      setParkIds((current) => {
        const next = new Set(current);
        next.delete(threadId);
        return next;
      });
      void rpc.call("pin_park_set", { threadId, parked: false }).catch(() => {});
    },
    [parkIds, rpc],
  );
  const restoreParkedPin = useCallback(
    (threadId: string) => {
      if (!parkIds.has(threadId)) return;
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (thread === undefined) return;
      // Already pinned (the operator re-pinned before the restore ran, or a
      // foreign surface did): the park is stale — consume quietly, never
      // double-pin.
      if (thread.isPinned) {
        clearParkPin(threadId);
        return;
      }
      // The restore itself, then the park dies — one gesture, once. The
      // reveal claim rides along: the card moves back to Pinned (far left,
      // offscreen in a scrolled board) when the write lands, not when this
      // function runs, so the consumed-when-applied claim is what keeps the
      // board following it.
      pendingStateClaimsRef.current.set(threadId, {
        field: "isPinned",
        value: true,
      });
      void actions.setPinned(threadId, true);
      clearParkPin(threadId);
    },
    [actions, clearParkPin, parkIds, threads],
  );
  const exitPinnedLane = useCallback(
    (threadId: string): Promise<unknown> => {
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (thread === undefined || !thread.isPinned) return Promise.resolve();
      // The unpin is the gesture; the park is a side record, never a
      // substitute for removing the pin itself. The unpin's promise returns
      // so the sweep's sequential runner can await the write (the fire-and-
      // forget drag paths ignore it).
      const unpin = actions.setPinned(threadId, false);
      parkPin(threadId);
      return unpin;
    },
    [actions, parkPin, threads],
  );

  // Confirm a sweep: apply the arm's per-thread gesture to the captured
  // selection, strictly one at a time (the runner's contract — the host's
  // sidebar writes run one row at a time, so an unawaited loop applies only
  // the last candidate; observed 2026-10-01: a 4-thread sweep archived one).
  // Side effects stay out of the state updater: read the armed snapshot,
  // clear it, then sweep. React may re-invoke updaters; an action call must
  // never run twice. Lives below exitPinnedLane/parkPin because the Pinned
  // arm exits through the lane exit (unpin, pin parked).
  const confirmSweepFor = useCallback(
    (columnId: string) => {
      const current = armedSweep;
      if (current === null || current.columnId !== columnId) return;
      if (sweepRun !== null) return; // one run at a time
      const threadIds = confirmSweep(current, true);
      // The sweep's runner moves (or removes) the confirmed cards: release
      // their pins so the gestures land; the attention rules resume for
      // what remains on the board.
      releaseAttentionFor(new Set(threadIds));
      const destination = sweepDestination(columnId);
      if (destination === null) {
        // Not a sweepable column: a confirm here is a caller bug. Refuse —
        // never default to archiving — and drop the arm.
        setArmedSweep(null);
        return;
      }
      if (threadIds.length === 0) {
        setArmedSweep(null);
        return;
      }
      // The idle arm's exit is staged: mark Done (the same recipe as a drop
      // on the Done column), never archive a quiet-but-not-done thread. The
      // fresh doneAt stamp starts the Done arm's archive clock, so swept
      // threads resurface there in doneArchiveDays instead of vanishing.
      const markDone = async (threadId: string): Promise<void> => {
        await rpc.call("done_set", { threadId, done: true });
        setDoneIds((currentDone) => {
          const next = new Set(currentDone);
          next.add(threadId);
          return next;
        });
        // Done implies read: the card must not land in Done still claiming
        // unread (the same rule the drop-on-Done path applies).
        const thread = threads.find((candidate) => candidate.id === threadId);
        if (thread !== undefined && thread.isUnread) {
          void actions.setRead(threadId, true);
        }
      };
      // The Pinned arm exits through the lane exit: unpin, pin parked, so a
      // swept thread returns to Pinned the next time it calls for attention.
      const sweepOne = (threadId: string): Promise<unknown> => {
        switch (destination) {
          case "done":
            return markDone(threadId);
          case "unpinned":
            return exitPinnedLane(threadId);
          case "read":
            // The catch-up gesture: mark read, nothing else. Marking read
            // carries no state-truth reactions (parks ride unread, not read).
            return actions.setRead(threadId, true);
          default:
            return sdk.threads.archive({ threadId });
        }
      };
      const settledWord = SWEEP_SETTLED_WORDS[destination];
      setSweepNotice(null);
      setSweepRun({ columnId, total: threadIds.length, done: 0, activeId: null });
      sweepCancelRef.current = false;
      void runSweep(threadIds, {
        act: sweepOne,
        onActive: (activeId) =>
          setSweepRun((run) => (run === null ? run : { ...run, activeId })),
        onSettled: () =>
          setSweepRun((run) =>
            run === null ? run : { ...run, done: run.done + 1, activeId: null },
          ),
        // Cancel between actions; the one in flight always finishes.
        shouldContinue: () => !sweepCancelRef.current,
      }).then((result) => {
        setSweepRun(null);
        const failedIds = result.failures.map((failure) => failure.threadId);
        // A cancelled run keeps whatever was never swept armed (plus any
        // failures) so it can be inspected, retried, or explicitly exited;
        // the pill flipping back to its count is the cancellation feedback.
        // Undo is OFFERED, never automatic: cancel means "stop", undo is a
        // deliberate second click.
        const stayArmed = result.cancelled
          ? [...failedIds, ...result.remaining]
          : failedIds;
        setArmedSweep(stayArmed.length > 0 ? { columnId, threadIds: stayArmed } : null);
        if (result.cancelled) {
          if (result.swept.length === 0 && result.failures.length === 0) return;
          const failedCopy =
            result.failures.length > 0
              ? ` ${result.failures.length} failed: ${result.failures
                  .map((failure) => failure.message)
                  .join(", ")}.`
              : "";
          setSweepNotice({
            message: `Sweep stopped. ${result.swept.length} ${settledWord}, ${result.remaining.length} not attempted.${failedCopy}`,
            undo: { ids: result.swept, destination },
          });
          return;
        }
        if (result.failures.length === 0) return;
        // Fail loud: the failed candidates stay armed (highlight) for a
        // one-click retry, and a banner says what happened.
        const failedTitles = result.failures.map((failure) => {
          const match = threads.find((candidate) => candidate.id === failure.threadId);
          return `"${match?.displayTitle ?? match?.titleFallback ?? failure.threadId}" (${failure.message})`;
        });
        const attempted = threadIds.length - result.remaining.length;
        setSweepNotice({
          message: `Sweep ${settledWord} ${attempted - result.failures.length} of ${threadIds.length}; ${result.failures.length} failed: ${failedTitles.join(", ")}. The failed cards stay highlighted. Click the broom to retry.`,
        });
      });
    },
        [actions, armedSweep, exitPinnedLane, releaseAttentionFor, rpc, sdk, sweepRun, threads],
  );

  // Undo a cancelled run, reversing exactly what it settled: unarchive the
  // Done arm's ids, unmark Done the idle arm's ids (the thread was never
  // archived; a done_set(false) returns it to its column), re-pin the
  // Pinned arm's ids (consuming the park the sweep's lane exit wrote — a
  // re-pin supersedes it), and mark the Unread arm's ids unread again (the
  // write's own echo carries the state-truth reactions, as for any
  // deliberate mark-unread). Top-level selections only, never the server's
  // whole archivedThreadIds subtree, because a child already archived
  // before the sweep must stay archived. Sequential like the run itself;
  // failures surface in the banner, the successes quietly return to their
  // columns.
  const undoSweepFor = useCallback(
    (threadIds: readonly string[], destination: SweepDestination) => {
      void (async () => {
        // User-initiated: the undone cards return to their previous lanes;
        // release their pins so the restoration lands, then recapture.
        releaseAttentionFor(new Set(threadIds));
        const failed: string[] = [];
        for (const threadId of threadIds) {
          try {
            if (destination === "done") {
              await rpc.call("done_set", { threadId, done: false });
              setDoneIds((current) => {
                const next = new Set(current);
                next.delete(threadId);
                return next;
              });
            } else if (destination === "unpinned") {
              await actions.setPinned(threadId, true);
              clearParkPin(threadId);
            } else if (destination === "read") {
              await actions.setRead(threadId, false);
            } else {
              await sdk.threads.unarchive({ threadId });
            }
          } catch (error) {
            failed.push(
              error instanceof Error ? `${threadId} (${error.message})` : threadId,
            );
          }
        }
        if (failed.length === 0) {
          setSweepNotice(null);
          return;
        }
        setSweepNotice({
          message: `Undo restored ${threadIds.length - failed.length} of ${threadIds.length}; ${failed.length} could not be restored: ${failed.join(", ")}.`,
        });
      })();
    },
    [actions, clearParkPin, releaseAttentionFor, rpc, sdk],
  );

  // The state-truth reaction to a thread BECOMING unread — fired by our own
  // gesture paths (card menu, pane toggle, the non-exit drag onto Unread)
  // and, with the suppression token below, by the native feed when a
  // foreign surface marks the thread unread. The card's state, not the
  // actor, decides what happens beside the mark itself:
  //  - a parked pin returns — the operator is calling the card back up the
  //    attention ladder, and the pin it had before the exit comes with it;
  //  - done is undone — unread and done contradict on the card (the same
  //    ladder rule that lets attention outrank working placement), so a
  //    Done card the operator marks unread comes back un-done.
  // Every check is on CURRENT state, so the reaction is idempotent: our
  // gestures compose it directly for an immediate response, and the feed
  // echo of the same write re-runs it as a no-op. The one non-idempotent
  // case is the drag exit itself — marking unread there must not restore
  // the park the very gesture just wrote — which is what the suppression
  // token (consumed by the write's own echo) is for.
  const applyUnreadStateEffects = useCallback(
    (threadId: string, options: { suppressParkRestore?: boolean } = {}) => {
      if (options.suppressParkRestore !== true) restoreParkedPin(threadId);
      if (doneIds.has(threadId)) {
        setDoneIds((current) => {
          const next = new Set(current);
          next.delete(threadId);
          return next;
        });
        rpc.call("done_set", { threadId, done: false }).catch(() => {});
      }
    },
    [doneIds, restoreParkedPin, rpc, setDoneIds],
  );
  /**
   * Suppression token for the drag exit's own read echo: consumed by the
   * feed's first read-state-changed event for the thread, so the gesture
   * that parks does not immediately restore its own park. It guards only
   * the restore — the un-done path cannot fire for a card the exit never
   * marked done — and any foreign surfaced write racing into the same echo
   * slot would be consumed with it; the residual races are milliseconds
   * in scale, bounded by the echo latency rather than a timer.
   */
  const unreadEchoSuppressRef = useRef<ReadonlySet<string>>(new Set());

  // Park reconciliation over the same native cross-surface feed
  // (`sdk.subscribe`, "thread:changed"): EVERY pin write — bb's sidebar,
  // another panel instance, the CLI — publishes `pin-state-changed`, which
  // closes the one gap a park marker alone cannot see. A pin that some other
  // writer takes back supersedes the parked value; without this, a later
  // Mark Not Done / Mark Unread would resurrect a pin against that intent.
  // Attribution is not needed, because the rule keys on the RESULTING pin
  // state read fresh at reconcile time: pinned → supersede (clear the park;
  // this board's own restore echo lands here too, but its park is consumed
  // synchronously with its own pin write, so the clear is the same
  // idempotent no-op either way); unpinned → the lane exit's own unpin
  // echo — the write that CAUSED the park — leaves the park alone. Threads
  // without a park are never fetched. A foreign pin+unpin cycle landing
  // entirely inside one reconcile's fresh-read latency is the residual
  // race: milliseconds, versus the previous gap's "until whenever".
  const parkIdsRef = useRef(parkIds);
  parkIdsRef.current = parkIds;
  const clearParkPinRef = useRef(clearParkPin);
  clearParkPinRef.current = clearParkPin;
  useEffect(() => {
    let disposed = false;
    try {
      const unsubscribe = sdk.subscribe({
        event: "thread:changed",
        callback: (event) => {
          const threadId = pinStateChangeFromEvent(event);
          if (threadId === null || !parkIdsRef.current.has(threadId)) return;
          void sdk.threads
            .get({ threadId })
            .then(
              (row) => {
                if (disposed) return;
                if (row.pinnedAt !== null) clearParkPinRef.current(threadId);
              },
              () => {}, // A thread deleted while parked is a dead park; parks refetch prunes it.
            );
        },
      });
      return () => {
        disposed = true;
        unsubscribe();
      };
    } catch {
      // Embedded contexts (screenshot harness) have no subscribe; parks live
      // until their own gesture consumes them.
      return undefined;
    }
  }, [sdk]);

  // The surfaced read-write listener: `read-state-changed` reaches here for
  // a mark-unread landing from any surface — the native thread menu is the
  // case this exists for, and our own pane/menu gestures' echoes converge
  // idempotently. The drag exit's own echo is what the suppression token
  // is for: consumed, never decided-on. The direction is decided by a
  // fresh read, keyed on the single-writer fact (lib/pin-park): only the
  // deliberate mark-unread route writes `lastReadAt = null`; ambient
  // attention-after-last-read unread never publishes and never nulls, so
  // a park never fires on ordinary thread noise.
  useEffect(() => {
    let disposed = false;
    try {
      const unsubscribe = sdk.subscribe({
        event: "thread:changed",
        callback: (event) => {
          const threadId = readStateChangeFromEvent(event);
          if (threadId === null) return;
          if (unreadEchoSuppressRef.current.has(threadId)) {
            unreadEchoSuppressRef.current = new Set([
              ...unreadEchoSuppressRef.current,
            ].filter((id) => id !== threadId));
            return;
          }
          void sdk.threads
            .get({ threadId })
            .then(
              (row) => {
                if (disposed) return;
                // Deliberately marked unread, from any surface: the state
                // truth applies, whatever the actor.
                if (row.lastReadAt === null) {
                  applyUnreadStateEffects(threadId);
                }
              },
              () => {}, // Deleted while processing: nothing to react to.
            );
        },
      });
      return () => {
        disposed = true;
        unsubscribe();
      };
    } catch {
      // Embedded contexts (screenshot harness) have no subscribe; the
      // gestures carry the effects alone.
      return undefined;
    }
  }, [applyUnreadStateEffects, sdk]);

  // The one-step browser-tab reveal (issue #17): bb's reveal only opens
  // the side panel when the OWNING thread is already focused, and answers
  // {ok:true} even when it no-ops silently — unusable from the board, where
  // the owning thread is by definition not focused. The orchestrator
  // (lib/browser-reveal) discovers first, focuses the thread, settles, then
  // reveals in a single pass. Outcomes the operator must hear about (a
  // thread with no controlled tab, a listing failure) land on the board
  // banner; success says nothing, the side panel IS it.
  const runBrowserReveal = useCallback(
    // Param surface narrowed to the facts the orchestrator consumes, so both
    // entry points (card menu, pane open menu) can hand the thread straight
    // through whatever shape they hold — PluginSidebarThread and the pane's
    // ThreadPaneThread both satisfy it.
    async (thread: { id: string; displayTitle: string }) => {
      setBrowserNotice(null);
      const ports = buildBrowserRevealPorts(sdk, navigate);
      let result: BrowserRevealResult;
      try {
        result = await revealThreadBrowserTabs(ports, thread.id);
      } catch (error) {
        setBrowserNotice({ message: browserReachFailure(error) });
        return;
      }
      if (result.discovered.length === 0) {
        setBrowserNotice({
          message: `No controlled browser tab belongs to "${thread.displayTitle}" — start one with bb browser-automation.`,
        });
        return;
      }
      // No completion banner on purpose: bb gives no observable success
      // signal (list_tabs' `presentation` is a recorded creation
      // attribute, not live visibility — 2026-10-06 poll evidence), so
      // the plugin claims nothing; the opened side panel IS the
      // feedback.
    },
    [navigate, sdk],
  );

  const menuActionsFor = useCallback(
    (thread: PluginSidebarThread): readonly CardMenuAction[] => {
      const isThreadDone = doneIds.has(thread.id);
      const isThreadSnoozed = snoozedIds.has(thread.id);
      const isThreadKept = doneAgeSource.kept(thread.id);
      // Zoom to family (issue #170): the entry pays off only when the card's
      // family is more than itself — it renders nested child rows, or is
      // itself a nested row of one. A lone top-level card stays unscoped.
      const inFamily =
        (familyIndex.childrenByParent.get(thread.id)?.length ?? 0) > 0 ||
        familyIndex.parentOf.has(thread.id);
      // Current intent: any state-changing gesture on a snoozed card lifts
      // the snooze first — the wake recipe (read → unread later) would fire
      // under a read/pin/done/archive write that has already superseded it.
      const liftSnooze = () => {
        if (snoozedIds.has(thread.id)) clearSnooze(thread.id);
      };
      // app.tsx keeps the side effects; lib/card-menu owns the order,
      // labels, icons and dividers (the grouping contract the card-menu
      // tests pin). Bodies are the pre-extraction run code, verbatim.
      // Attention contract: these actions move (or re-lane) the card —
      // release its pin first so the gesture's placement lands; the
      // recapture pass re-pins the settled placement while attention holds.
      return cardMenuActions(
        {
          thread,
          isDone: isThreadDone,
          isSnoozed: isThreadSnoozed,
          isKept: isThreadKept,
          grouped: groupAssignments[thread.id] !== undefined,
          inFamily,
          // Clear error (issue #157): offer only on attention the error arms
          // carry — threadState attention minus a pending interaction, and
          // not already acknowledged.
          canClearError:
            threadState(thread, errorAckIds) === "attention" &&
            !thread.hasPendingInteraction &&
            !errorAckIds.has(thread.id),
        },
        {
          revealBrowserTabs: () => {
            // Discover → focus → reveal → verify happens in
            // lib/browser-reveal; the board banner reports anything the
            // operator must hear about — even a throw, so the click never
            // reads as one the board ignored.
            runBrowserReveal(thread).catch((error) => {
              setBrowserNotice({ message: browserReachFailure(error) });
            });
          },
          openInBrowser: () => {
            // A raw open on purpose: on the desktop app bb's main-process
            // window guard denies the popup and funnels the http(s) URL to
            // the user's system browser (shell.openExternal), which is the
            // destination "Open in browser" names. openUrl() was tried for
            // this and lands in the app's in-app browser panel instead.
            const url = new URL(thread.href, window.location.origin).toString();
            void window.open(url, "_blank", "noopener");
          },
          openNewChild: () => openNewChildThread(thread.id),
          zoomToFamily: () => {
            // Zoom to family (issue #170): the Parent view scoped to the
            // card's OWN family root — a nested row's write names the
            // family's owner, never a sub-child of it. Two persisted
            // writes, the same way the View chip and the filter menu's
            // picks write their state.
            persistGroupBy("parent");
            persistFilter({
              ...filter,
              familyRootId: familyRootIdOf(thread.id, familyIndex),
            });
          },
          togglePinned: () => {
            liftSnooze();
            // Live intent beats the parked value: a park this gesture's
            // write supersedes must not resurrect on a later Mark Not Done
            // or Mark Unread.
            clearParkPin(thread.id);
            // Arm the reveal claim first, then ask the host: the applied
            // pin (and the card's relocation into or out of the Pinned
            // lane) lands in a later commit, so the claim's consumption
            // effect timing is what makes the reveal land AFTER the move.
            pendingStateClaimsRef.current.set(thread.id, {
              field: "isPinned",
              value: !thread.isPinned,
            });
            void actions.setPinned(thread.id, !thread.isPinned);
          },
          toggleRead: () => {
            liftSnooze();
            // Arm the reveal claim first — setRead also rides the host
            // bridge, and the requested observable state is the toggle's
            // flipped value (the applied result), not the arg passed
            // through.
            pendingStateClaimsRef.current.set(thread.id, {
              field: "isUnread",
              value: !thread.isUnread,
            });
            // Marking unread carries the state-truth effects (a parked pin
            // returns; a Done card un-does); marking read leaves the park in
            // place — a card read now that the operator marks unread later
            // still finds its pin.
            if (thread.isUnread) {
              void actions.setRead(thread.id, true);
            } else {
              applyUnreadStateEffects(thread.id);
              void actions.setRead(thread.id, false);
            }
          },
          clearError: () => {
            // Optimistic local ack: the card settles out of Needs you in the
            // same commit (dot, accent, lane). The RPC records it (metadata
            // "errorAck") so the ack survives reloads, and its publish
            // refetches every other open board. bb's own thread view keeps
            // the error; only the board's attention claim lifts (issue #157).
            setErrorAckIds((current) => new Set(current).add(thread.id));
            rpc.call("error_ack_set", { threadId: thread.id, acked: true }).catch(() => {});
            requestReveal(thread.id);
          },
          toggleDone: () => {
            liftSnooze();
            setDoneIds((current) => {
              const next = new Set(current);
              if (isThreadDone) next.delete(thread.id);
              else next.add(thread.id);
              return next;
            });
            rpc.call("done_set", { threadId: thread.id, done: !isThreadDone }).catch(() => {});
            // Local and optimistic: the card relocates to the Done lane (or
            // back out of it) in the same commit as this batch, so the
            // one-shot reveal can fire now — Board's layout effect
            // processes it after the move, minimally (an already-visible
            // destination lane scrolls nothing).
            requestReveal(thread.id);
            if (!isThreadDone) {
              // Done implies read: a Done card must not still claim unread
              // (and a later Mark Not Done hands the card back read).
              if (thread.isUnread) {
                void actions.setRead(thread.id, true);
              }
              // The same lane-exit rule the drops compose: marking a pinned
              // card done parks its pin as it leaves the Pinned lane.
              exitPinnedLane(thread.id);
            } else {
              // Mark Not Done is the undo; a parked pin comes back with the
              // card.
              restoreParkedPin(thread.id);
            }
          },
          clearSnooze: () => clearSnooze(thread.id),
          openSnoozePicker: () => setSnoozeDialogFor(thread.id),
          openGroupPicker: () => setGroupDialogFor(thread.id),
          makeTopLevel: () => {
            // The drop-onto gesture's undo: detach from the family.
            // Failure mirrors the neighbors — silent — because bb's
            // own action errors ride the host toast, and a missed
            // detach write leaves the card exactly as it rendered.
            void rpc
              .call("thread_reparent", { threadId: thread.id, parentThreadId: null })
              .catch(() => {});
          },
          toggleSweepKeep: () => {
            const nextKeep = !isThreadKept;
            setDoneExtras((current) => ({
              ...current,
              [thread.id]: { ...current[thread.id], keep: nextKeep },
            }));
            rpc
              .call("sweep_keep_set", { threadId: thread.id, keep: nextKeep })
              .catch(() => {
                // Roll the optimistic update back when the server
                // rejects; the board must not show a keep the server
                // never recorded.
                setDoneExtras((current) => ({
                  ...current,
                  [thread.id]: { ...current[thread.id], keep: !nextKeep },
                }));
              });
          },
          archive: () => {
            liftSnooze();
            if (thread.isArchived) {
              sdk.threads.unarchive({ threadId: thread.id }).catch(() => {});
            } else {
              actions.archive(thread.id);
            }
          },
          requestDelete: () => actions.requestDelete(thread.id),
        },
      ).map((action) => ({
        ...action,
        run: () => {
          releaseAttentionFor(new Set([thread.id]));
          action.run();
        },
      }));
    },
    [actions, applyUnreadStateEffects, clearParkPin, clearSnooze, doneAgeSource, doneIds, exitPinnedLane, familyIndex, filter, groupAssignments, openNewChildThread, pendingStateClaimsRef, persistFilter, persistGroupBy, releaseAttentionFor, requestReveal, restoreParkedPin, runBrowserReveal, rpc, setBrowserNotice, setDoneExtras, setDoneIds, setGroupDialogFor, setSnoozeDialogFor, snoozedIds, sdk],
  );

  if (sidebarStatus === "loading" && threads.length === 0) {
    return (
      <div className="p-4">
        <EmptyState>Loading threads…</EmptyState>
      </div>
    );
  }
  if (sidebarStatus === "error") {
    return (
      <div className="p-4">
        <EmptyState>Could not load threads. Reload the panel to retry.</EmptyState>
      </div>
    );
  }

  const activeWallpaper = wallpaperLayerOf(wallpaper);
  return (
    <JiraBoardContext.Provider value={jiraBoardValue}>
    <WallpaperActiveProvider active={activeWallpaper !== null}>
    {/* Publishes whether the compact pane covers the board, so the board can
        skip the card spotlight's whole-board recede while it cannot be seen
        (issue #310). */}
    <PaneSheetCoverageProvider>
    <div
      // Always relative: the panel-scoped pane sheet (a narrow panel on a
      // desktop window) anchors to this root, and so do the wallpaper
      // layers when a wallpaper is active. The ref feeds the paint's
      // window-frame measurement.
      ref={panelRef}
      className="relative flex h-full min-h-0"
      data-focus-board-panel=""
    >
      {activeWallpaper === null ? null : (
        // The wallpaper paints on a clipped child, not the root, so a zoom
        // > 1 can scale the image past the panel edge without ever
        // scrolling or resizing the board. The paint anchors to the window's
        // box (issue #201): the crop derives from the window's ratio, and a
        // thread pane toggle or sidebar drag only carves the porthole.
        <WallpaperPaintLayer layer={activeWallpaper} dark={darkScheme} panelRef={panelRef} />
      )}
      {activeWallpaper === null ? null : (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0"
          style={{
            backgroundColor: "var(--background)",
            opacity: activeWallpaper.dim,
          }}
        />
      )}
      <div
        className={
          (activeWallpaper === null ? "" : "relative z-10 ") +
          "flex h-full min-h-0 min-w-0 flex-1 flex-col"
        }
      >
        <BoardToolbar
          groupBy={groupBy}
          onGroupByChange={persistGroupBy}
          filter={filter}
          onFilterChange={persistFilter}
          search={search}
          onSearchChange={persistSearch}
          projectIds={filterOptions.projectIds}
          providerIds={filterOptions.providerIds}
          groupOptions={filterOptions.groupOptions}
          familyScopeLabel={familyScopeLabel}
          projects={projects}
          providers={providers}
          onCreateProject={createProject}
          totalCount={boardCount}
          onClearFilters={() => {
            persistFilter({ projects: new Set(), providers: new Set(), states: new Set(), groups: new Set() });
            persistSearch("");
          }}
          anyFilterActive={anyFilterActive}
          onNewThread={openNewThread}
          whatsNewUnseen={whatsNewUnseen}
          onOpenSettings={openSettings}
          searchInputRef={searchInputRef}
          nestChildren={nestChildren}
          onNestChildrenChange={persistNestChildren}
          nestingLocked={isParentGroupBy}
        />
        {groupBy === "parent" ? (
          <ParentLaneBoard
            lanes={parentLanes ?? []}
            activeThreadId={openThreadId}
            doneIds={doneIds}
            errorAckIds={errorAckIds}
            dimmedIds={dimmedIds}
            childrenByParent={parentLaneChildrenByParent}
            projectNameFor={projectNameFor}
            repoBaseFor={repoBaseFor}
            statusFor={statusFor}
            pulseRateFor={pulseRateFor}
            linkedIssuesFor={(threadId) => linksByThread[threadId]}
            validatedHrefs={validatedHrefs}
            parentLaneOrder={parentLaneOrder}
            onParentLaneOrderChange={persistParentLaneOrder}
            onOpenThread={openThreadCard}
            onClosePane={closeThreadPane}
            onNewTask={openNewThread}
            menuActionsFor={menuActionsFor}
            snoozeFor={snoozeFor}
            onAttentionEnter={attentionEnter}
            onAttentionLeave={attentionLeave}
            sweepCandidatesFor={parentLaneSweepCandidatesFor}
            armedSweep={armedSweep}
            sweepRun={sweepRun}
            sweepNotice={sweepNotice}
            onDismissSweepNotice={clearSweepNotice}
            onSweepUndo={undoSweepFor}
            onSweepToggle={toggleSweepSelectionFor}
            onSweepRangeSelect={addSweepSelectionFor}
            sweepBlockedIds={sweepBlockedIds}
            onSweepArm={armParentLaneSweepFor}
            onSweepConfirm={confirmSweepFor}
            onSweepCancel={cancelSweepFor}
          />
        ) : boardCount === 0 ? (
          <div className="p-4">
            <EmptyState>
              {emptyBecauseFiltered
                ? "No threads match the current group, filter, and search."
                : "No threads to show yet."}
            </EmptyState>
          </div>
        ) : (
          <Board
            columns={boardColumns}
            groupBy={groupBy}
            activeThreadId={openThreadId}
            cardTransport={cardTransport}
            motionPref={motionFollow ? "system" : "manual"}
            motionPacing={motionPacing}
            laneDirection={laneDirection}
            doneIds={doneIds}
            errorAckIds={errorAckIds}
            nestedChildrenByParent={nestedChildrenByParent}
            childCountByParent={assembly?.childCountByParent ?? new Map()}
            doneChildrenByParent={assembly?.doneChildrenByParent ?? new Map()}
            groupBoxOf={groupBoxPlan.groupBoxOf}
            highlightedGroupId={highlightedGroupId}
            onHighlightGroup={setHighlightedGroupId}
            onJoinGroup={(droppedId, groupId) => {
              // User-initiated: joining a lane moves the card; the pin
              // releases for the gesture.
              releaseAttentionFor(new Set([droppedId]));
              setThreadGroup(droppedId, groupId);
            }}
            onRenameGroup={renameGroup}
            onDeleteGroup={deleteGroup}
            onNewThreadInGroup={openNewThreadInGroup}
            onZoomToGroup={zoomToGroup}
            collapsedFamilyIds={collapsedFamilies}
            onFamilyCollapsedChange={setFamilyCollapsed}
            hideIdleFamilyIds={hideIdleFamilies}
            onFamilyHideIdleChange={setFamilyHideIdle}
            collapsedGroupIds={collapsedGroups}
            onGroupCollapsedChange={setGroupCollapsed}
            dimmedIds={dimmedIds}
            projectNameFor={projectNameFor}
            repoBaseFor={repoBaseFor}
            statusFor={statusFor}
            pulseRateFor={pulseRateFor}
            linkedIssuesFor={(threadId) => linksByThread[threadId]}
            validatedHrefs={validatedHrefs}
            onOpenThread={openThreadCard}
            onClosePane={closeThreadPane}
            onNewTask={openNewThread}
            snoozeFor={snoozeFor}
            onAttentionEnter={attentionEnter}
            onAttentionLeave={attentionLeave}
            onHideLane={groupBy === "project" || groupBy === "group" ? hideLane : undefined}
            sweepCandidatesFor={sweepCandidatesFor}
            armedSweep={armedSweep}
            sweepRun={sweepRun}
            sweepNotice={sweepNotice}
            onDismissSweepNotice={clearSweepNotice}
            rankSaveError={rankSaveError}
            onDismissRankSaveError={() => setRankSaveError(null)}
            familyStateSaveError={familyStateSaveError}
            onDismissFamilyStateSaveError={() => setFamilyStateSaveError(null)}
            browserNotice={browserNotice}
            onDismissBrowserNotice={clearBrowserNotice}
            onSweepUndo={undoSweepFor}
            onSweepToggle={toggleSweepSelectionFor}
            onSweepRangeSelect={addSweepSelectionFor}
            sweepBlockedIds={sweepBlockedIds}
            onSweepArm={armSweepFor}
            onSweepDisarm={disarmSweep}
            onSweepConfirm={confirmSweepFor}
            onSweepCancel={cancelSweepFor}
            onDropDone={(threadId) => {
              // User-initiated: the pin releases for this gesture's move.
              releaseAttentionFor(new Set([threadId]));
              const thread = threads.find((candidate) => candidate.id === threadId);
              const next = new Set(doneIds);
              next.add(threadId);
              setDoneIds(next);
              rpc.call("done_set", { threadId, done: true }).catch(() => {});
              // Done implies read: the card must not land in Done still
              // claiming unread (or come back from Mark Not Done unread).
              if (thread !== undefined && thread.isUnread) {
                void actions.setRead(threadId, true);
              }
              exitPinnedLane(threadId);
            }}
            onDropUnread={(threadId) => {
              releaseAttentionFor(new Set([threadId]));
              const thread = threads.find((candidate) => candidate.id === threadId);
              if (thread === undefined) return;
              if (thread.isPinned) {
                // The exit: unpin + park, and register the echo suppression
                // BEFORE the gesture's own read write lands — the fresh park
                // must not be restored by the very gesture that parked it.
                unreadEchoSuppressRef.current = new Set(
                  unreadEchoSuppressRef.current,
                ).add(threadId);
                exitPinnedLane(threadId);
              } else {
                // Marking unread on an unpinned card is the attention
                // signal: state-truth effects apply — a parked pin rides
                // the mark back into Pinned, and a Done card un-does.
                applyUnreadStateEffects(threadId);
              }
              if (!thread.isUnread) {
                // The read flip rides the host bridge: arm the claim the
                // same way the menu's toggleRead does — reveal intent, and
                // the attention recapture's in-flight guard.
                pendingStateClaimsRef.current.set(threadId, { field: "isUnread", value: true });
                void actions.setRead(threadId, false);
              }
            }}
            // Drop on Pinned pins, unless the card is already pinned: a
            // pinned card's drop is a same-lane reorder (claimed by the card
            // or lane handler) and never reaches this path.
            onDropPinned={(threadId) => {
              releaseAttentionFor(new Set([threadId]));
              const thread = threads.find((candidate) => candidate.id === threadId);
              if (thread !== undefined && !thread.isPinned) {
                void actions.setPinned(threadId, true);
              }
            }}
            rankStore={ranks}
            rawParentOf={familyIndex.rawParentOf}
            onReparent={(childId, parentThreadId) => {
              // User-initiated: a re-rooting re-places both ends; release
              // their pins so the gesture's placement lands.
              const touched = parentThreadId === null
                ? new Set([childId])
                : new Set([childId, parentThreadId]);
              releaseAttentionFor(touched);
              // The host owns the write (threads.update → thread:changed →
              // the sidebar hook refetches → nesting re-derives). The board
              // surfaces rejections; the guard re-checked fresh rows
              // server-side, so a rejection means stale UI data.
              return rpc.call("thread_reparent", { threadId: childId, parentThreadId }).then(
                () => undefined,
              );
            }}
            onRankMove={(columnKey, threadId, beforeId, toEnd, visibleIds, unitIds) => {
              // User-initiated movement: strip the affected column's pins
              // first, so the gesture's snap lands and the recapture pass
              // re-pins the settled order.
              releaseAttentionFor(new Set(visibleIds));
              setRankSaveError(null);
              // Optimistic: the card (or whole box, unitIds) snaps to its
              // slot immediately, and the rank-changed refetch confirms. A
              // rejected write settles back to the stored order on the next
              // refetch rather than sticking.
              setRanks((prev) => ({
                ...prev,
                [columnKey]:
                  unitIds !== undefined && unitIds.length > 1
                    ? applyUnitMoveVisible(
                        orderForColumn(prev, columnKey),
                        visibleIds,
                        unitIds,
                        beforeId,
                        toEnd,
                      )
                    : applyMoveVisible(
                        orderForColumn(prev, columnKey),
                        visibleIds,
                        threadId,
                        beforeId,
                        toEnd,
                      ),
              }));
              rpc
                .call("rank_move", {
                  columnKey,
                  threadId,
                  beforeId,
                  toEnd,
                  visibleIds: [...visibleIds],
                  // Omit the member entirely when there is no unit: a literal
                  // member set to `undefined` is an own property whose value
                  // JSON has no equivalent, and the host's input validation
                  // walks it as a JSON value and rejects — every solo drag
                  // was refused at the bridge with "$input.unitIds is not a
                  // JSON value" (issue #240). A spread writes nothing when
                  // the unit is absent.
                  ...(unitIds !== undefined && unitIds.length > 1
                    ? { unitIds: [...unitIds] }
                    : {}),
                })
                .catch((error: unknown) => {
                  // Fail loud (issue #232): a rejected write used to revert
                  // the landing silently.
                  setRankSaveError(
                    error instanceof Error ? error.message : "the host rejected the reorder.",
                  );
                  refetchRanks();
                });
            }}
            menuActionsFor={menuActionsFor}
            reveal={revealRequest}
          />
        )}
      </div>
      {openThread === null ? null : (
        <ThreadPane
          thread={openThread}
          isArchived={openThreadIsArchived}
          isDone={doneIds.has(openThreadId ?? "")}
          snoozeWakeAt={openThreadId === null ? null : snoozeFor(openThreadId)}
          onToggleDone={(done) => {
            if (openThreadId === null) return;
            // User-initiated: release this card's pin so the move lands.
            releaseAttentionFor(new Set([openThreadId]));
            // Current intent: a state change lifts any snooze first.
            if (snoozedIds.has(openThreadId)) clearSnooze(openThreadId);
            setDoneIds((current) => {
              const next = new Set(current);
              if (done) next.add(openThreadId);
              else next.delete(openThreadId);
              return next;
            });
            rpc.call("done_set", { threadId: openThreadId, done }).catch(() => {});
          }}
          onToggleArchived={() => {
            if (openThreadId === null) return;
            if (openThreadIsArchived) {
              sdk.threads.unarchive({ threadId: openThreadId }).catch(() => {});
            } else {
              actions.archive(openThreadId);
            }
          }}
          onTogglePinned={() => {
            if (openThreadId === null || openThreadActive === null) return;
            // User-initiated: release this card's pin so the move lands.
            releaseAttentionFor(new Set([openThreadId]));
            // Same semantics as the card menu's pin: a state change lifts any
            // snooze first, and a live intent beats the parked value.
            if (snoozedIds.has(openThreadId)) clearSnooze(openThreadId);
            clearParkPin(openThreadId);
            // Arm the reveal claim first, then ask the host: the applied pin
            // (and the card's relocation into or out of the Pinned lane) lands
            // in a later commit, so the claim's consumption effect timing is
            // what makes the reveal land AFTER the move.
            pendingStateClaimsRef.current.set(openThreadId, {
              field: "isPinned",
              value: !openThreadActive.isPinned,
            });
            void actions.setPinned(openThreadId, !openThreadActive.isPinned);
          }}
          snoozeMenuItems={snoozeMenuActions({
            snoozed: snoozedIds.has(openThread.id),
            clearSnooze: () => clearSnooze(openThread.id),
            openPicker: () => setSnoozeDialogFor(openThread.id),
          })}
          onNewChildThread={() => openNewChildThread(openThread.id)}
          onRevealBrowserTab={() => {
            // The card menu's same gesture (app.tsx menuActionsFor), wired to
            // the open thread; outcome reporting rides the board banner, the
            // single home both entry points share.
            runBrowserReveal(openThread).catch((error) => {
              setBrowserNotice({ message: browserReachFailure(error) });
            });
          }}
          onToggleUnread={() => {
            if (openThreadId === null || openThreadActive === null) return;
            // User-initiated: release this card's pin so the move lands.
            releaseAttentionFor(new Set([openThreadId]));
            // Current intent: a state change lifts any snooze first.
            if (snoozedIds.has(openThreadId)) clearSnooze(openThreadId);
            // Arm the reveal claim first, the card menu's toggleRead way —
            // and with it the attention recapture's in-flight guard (the
            // strip above must not be re-pinned from the pre-gesture board
            // while the flip rides the host bridge).
            pendingStateClaimsRef.current.set(openThreadId, {
              field: "isUnread",
              value: !openThreadActive.isUnread,
            });
            if (openThreadActive.isUnread) {
              void actions.setRead(openThreadId, true);
            } else {
              // Same state-truth effects as every other mark-unread path:
              // a parked pin returns, a Done card un-does.
              applyUnreadStateEffects(openThreadId);
              void actions.setRead(openThreadId, false);
            }
          }}
          onRename={(title) => actions.rename(openThread.id, title)}
          onMaximize={() => navigate.toThread(openThread.id)}
          onClose={closeThreadPane}
          escapeSuppressed={newThreadOpen}
          escStopsRunningThread={escStopsRunningThread}
          referenceMentions={referenceMentions}
        />
      )}
      <NewThreadModal
        open={newThreadOpen}
        onOpenChange={onNewThreadOpenChange}
        defaultProjectId={newThreadProjectId}
        defaultEnvironment={newThreadEnvironmentSeed}
        defaultProviderId={newThreadGroupSeed?.providerId}
        defaultModel={newThreadGroupSeed?.model}
        focusRequest={composerFocusRequest}
        parentThreadId={newThreadParentId ?? undefined}
        parentThreadTitle={newThreadParentTitle}
        spawnParentTitle={newThreadNest?.spawnParentTitle}
        // The preset parent's group name, when it has a membership: the
        // dialog announces the child's inheritance before the prompt is
        // spent (a plain root spawn or an ungrouped parent hides the hint).
        parentGroupName={
          newThreadParentId !== null
            ? (groupRegistry[groupAssignments[newThreadParentId] ?? ""]?.name ?? undefined)
            : undefined
        }
        groupName={
          newThreadGroupId === null
            ? undefined
            : (groupRegistry[newThreadGroupId]?.name ?? newThreadGroupId)
        }
        // A group preset cannot follow to the main view either: the main
        // view spawns the thread but the group tag write would be lost —
        // the promise the dialog made ("Will be tagged into…") breaks.
        onMaximize={
          newThreadParentId === null && newThreadGroupId === null && newThreadJira === null ? maximizeNewThread : undefined
        }
        rememberEnvironment={rememberSpawnEnvironment}
        initialPrompt={newThreadJira?.prompt}
        pluginMetadata={newThreadJira?.pluginMetadata}
        onSpawned={
          newThreadJira === null
            ? handleComposerSpawnedThread
            : (thread) => {
                // Links the board chip and moves a To Do ticket to In Progress.
                jiraRpc
                  .call("jira_column_action", { action: "started", key: newThreadJira.key, threadId: thread.id })
                  .then(refetchJira, () => {});
                handleComposerSpawnedThread(thread);
              }
        }
      />
      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        tab={settingsTab}
        onTabChange={handleTabChange}
        entries={whatsNewEntries}
        escStopsRunningThread={settingValues?.escStopsRunningThread}
        newThreadShortcutKey={settingValues?.newThreadShortcutKey}
        sweep={{
          doneArchiveValue: settingValues?.doneArchiveValue,
          doneArchiveUnit: settingValues?.doneArchiveUnit,
          idleArchiveValue: settingValues?.idleArchiveValue,
          idleArchiveUnit: settingValues?.idleArchiveUnit,
        }}
        onSetSweep={setSweepThreshold}
        jiraEnabled={jiraState.enabled}
        onSetEscStopsRunningThread={setEscStopsRunningThread}
        onSetNewThreadShortcutKey={setNewThreadShortcutKey}
        cardTransport={cardTransport}
        follow={motionFollow}
        motionPacing={motionPacing}
        laneDirection={laneDirection}
        wallpaper={wallpaper}
        onSetCardTransport={persistCardTransport}
        onSetMotionFollow={(value) => persistMotion(value, motionPacing)}
        onSetMotionPacing={(value) => persistMotion(motionFollow, value)}
        onSetLaneDirection={persistLaneDirection}
        onWallpaperChange={persistWallpaper}
      />
      {snoozeDialogFor === null ? null : (() => {
        const dialogThread = threads.find((candidate) => candidate.id === snoozeDialogFor);
        if (dialogThread === undefined) {
          // The thread left the board while the picker was open: close quietly.
          setSnoozeDialogFor(null);
          return null;
        }
        return (
          <SnoozeDialog
            threadTitle={dialogThread.displayTitle}
            currentWakeAt={snoozeFor(dialogThread.id)}
            onConfirm={(wakeAt) => {
              snoozeUntil(dialogThread.id, wakeAt);
              setSnoozeDialogFor(null);
            }}
            onRemove={() => {
              clearSnooze(dialogThread.id);
              setSnoozeDialogFor(null);
            }}
            onCancel={() => setSnoozeDialogFor(null)}
          />
        );
      })()}
      {groupDialogFor === null ? null : (() => {
        const dialogThread = threads.find((candidate) => candidate.id === groupDialogFor);
        if (dialogThread === undefined) {
          setGroupDialogFor(null);
          return null;
        }
        return (
          <GroupDialog
            threadTitle={dialogThread.displayTitle}
            groups={Object.entries(groupRegistry).map(([id, group]) => ({ id, name: group.name }))}
            currentGroupId={groupAssignments[dialogThread.id] ?? null}
            onPick={(groupId) => {
              setThreadGroup(dialogThread.id, groupId);
              setGroupDialogFor(null);
            }}
            onCreate={(name) => {
              createAndAssignGroup(dialogThread.id, name);
              setGroupDialogFor(null);
            }}
            onRemove={() => {
              setThreadGroup(dialogThread.id, null);
              setGroupDialogFor(null);
            }}
            onRename={renameGroup}
            onDelete={deleteGroup}
            onCancel={() => setGroupDialogFor(null)}
          />
        );
      })()}
    </div>
    </PaneSheetCoverageProvider>
    </WallpaperActiveProvider>
    </JiraBoardContext.Provider>
  );
}

export default definePluginApp((app) => {
  // The brand mark joins the host's app-wide icon registry under the name
  // "FocusBoard", so every host-rendered surface that takes a `BbIconName`
  // — the sidebar nav row and the pane's title-bar tab — can draw the same
  // mark the manifest's branding.icon shows on the Tools pages, instead of
  // the Columns2 placeholder this registration used to hardcode.
  app.experimental_icons.register({
    name: "FocusBoard",
    component: FocusBoardAppIcon,
  });
  app.slots.navPanel({
    id: "board",
    title: "Focus Board",
    icon: "FocusBoard",
    path: PANEL_PATH,
    // The pane's thread arrives through the `subPath` prop (`t/<id>`), so
    // the open pane participates in browser history — bb's back arrow
    // reopens the pane state the user left, and deep links restore it.
    component: BoardPage,
  });
  // A gear icon in the sidebar footer (beside the built-in Settings and
  // bug-report buttons) that jumps to this plugin's detail page in Tools,
  // where its declarative settings — all six, plus the mirrored look prefs
  // once the configuration-page section lands — render. It takes the
  // "configuration" noun on purpose: the board's own gear opens the settings
  // modal, and two gears named settings with two destinations was the
  // ambiguity the sync design killed (docs/plans settings-surface-sync).
  // bb's sidebar entry context menu is host-owned with no plugin extension
  // point, so this footer gear is the plugin's own shortcut to the
  // configuration panel.
  app.slots.sidebarFooterAction({
    id: "open-settings",
    title: "Focus Board configuration",
    icon: "Settings",
    run: (context) => context.openSettings(),
  });
  // The configuration page (the footer gear's destination) also hosts the
  // Appearance rows as a plugin-rendered section beside the declared
  // settings: same controls, same localStorage truth, no second store (the
  // sync design's D3). The section reads once at mount; a board instance is
  // never mounted on this page, so the next board visit applies an edit.
  app.slots.settingsSection({
    id: "appearance",
    title: "Appearance",
    description:
      "Card animations, motion, and wallpaper. These follow this browser, not bb's settings store.",
    component: AppearanceSettingsSection,
  });
  // The host paints its own ExternalLink glyph inside linkified anchors
  // rendered in this panel's pane (ThreadChat's markdown) — an atomic
  // inline that can wrap onto its own line at wrap widths. Fix it where
  // it is ours, in the app shell, by fusing glyph and last character
  // (components/host-link-glue.ts). The host's own main-thread windows
  // stay untouched here; that is filed upstream.
  app.contentScripts.register({
    id: "host-link-glue",
    mount: (context) => installHostLinkGlue(context),
  });
});
