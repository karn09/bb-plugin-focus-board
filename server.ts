// bb-plugin-focus-board — a BB plugin backend entry.
//
// The board reads bb's live thread view through the frontend sidebar hooks.
// Server state is: (1) the set of threads the user marked "Done" — one record
// per thread in the board's plugin-metadata namespace (key "done" →
// { doneAt: ISO-8601, keep? }), exposed over RPC and broadcast over realtime
// so every open board updates; (2) per-thread sweep keep flags in their own
// KV store (a long-idle thread that was never marked Done can be protected
// too); (3) the sweep thresholds, from plugin settings.
//
// Plugin metadata writes emit no thread realtime event, so the explicit
// done-changed publish stays.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { createThreadPulseTracker } from "./lib/thread-pulse";
import {
  PluginCliError,
  cliCommand,
  defineCli,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DONE_METADATA_KEY,
  doneAtToEpochMs,
  parseDoneRecord,
  stampDone,
  type DoneRecord,
} from "./lib/done-metadata";
import {
  ERROR_ACK_METADATA_KEY,
  parseErrorAckRecord,
  stampErrorAck,
  type ErrorAckRecord,
} from "./lib/error-ack-metadata";
import {
  LINK_METADATA_KEY,
  clearLinkedIssues,
  linkHref,
  makeExternalLink,
  parseGithubItemUrl,
  parseLinkedIssues,
  stampLinkedIssues,
  type ThreadLink,
} from "./lib/link-metadata";
import {
  ARCHIVE_UNITS,
  DEFAULT_ARCHIVE_UNIT,
  DEFAULT_ARCHIVE_VALUE,
  archiveThresholdMs,
} from "./lib/duration";
import {
  PIN_PARK_METADATA_KEY,
  parsePinParkRecord,
  stampPinPark,
  type PinParkRecord,
} from "./lib/pin-park";
import {
  SNOOZE_METADATA_KEY,
  parseSnoozeRecord,
  parseWhenArg,
  snoozeWakeAtMs,
  stampSnooze,
  type SnoozeRecord,
} from "./lib/snooze";
import { reparentRefusal } from "./lib/reparent";
import {
  GROUP_METADATA_KEY,
  GROUPS_KV_KEY,
  createGroupRecord,
  groupsRowFromStore,
  normalizeGroupName,
  parseGroupMember,
  parseGroupsStore,
  pruneEmptyGroups,
  type GroupRecord,
} from "./lib/group-metadata";
import {
  FAMILY_STATE_KEYS,
  FAMILY_STATE_KV_KEY,
  familyStateRowFromStore,
  mergeFamilyStateIds,
  parseFamilyStateStore,
  sameFamilyState,
  toggleFamilyStateId,
  type FamilyStateStore,
} from "./lib/family-state";
import { RANK_KV_KEY } from "./lib/rank";
import {
  applyRankMoveFractions,
  fractionRowFromStore,
  ordersFromFractionStore,
  parseFractionRankStore,
  type FractionRankStore,
} from "./lib/rank-fractions";
import {
  sweepCliEligible,
  type SweepEligible,
  type SweepFact,
} from "./lib/sweep-cli";
import { readGitHubStatuses } from "./lib/tracker-status";
import { createTrackerFreshnessJudge } from "./lib/tracker-refresh";
import { resolveRepoSlug } from "./lib/tickets";
import { validateTrackerUrls } from "./lib/tracker-validate";
import { resolveWithinRoot } from "./lib/workspace-paths";
import {
	createWorkspaceOpenTargetsCache,
	openWorkspaceInTarget,
	probeLocalDaemon,
	resolveWorkspaceOpenState,
	daemonPortsFromSystemConfig,
	type HostDaemonProbe,
	type WorkspaceOpenState,
} from "./lib/workspace-open";
import {
  autotitleTargets,
  buildAutotitlePrompt,
  cleanGeneratedTitle,
  promptTextFromHistory,
  resolveTitleSelection,
  resolveTitleTarget,
  type AutotitleHistoryEntry,
} from "./lib/autotitle";
import {
  assistantTextFromTimeline,
  buildAutotitleProbePrompt,
  firstUserPromptFileFromTimeline,
  firstUserPromptFromTimeline,
  probeSettled,
  type AutotitleTimelineRow,
} from "./lib/autotitle-thread-model";
import {
  attachmentPromptTarget,
  readAttachmentPromptText,
} from "./lib/autotitle-attachment";
import type { JsonValue } from "@get-bb/plugin-sdk";

/**
 * A rank store column key: a bare lane name ("pinned", "done") or
 * `${groupBy}:${columnId}` with a host id (project, provider). The shape
 * guards reject the two things that are never legitimate but are dangerous
 * as a computed object key on the KV store write (`__proto__` reassigns
 * the store object's prototype) and control characters (invisible
 * pollution of the KV row and realtime payloads). Everything real passes:
 * host ids, colons, dots.
 */
const COLUMN_KEY_SCHEMA = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!__proto__$)[^\x00-\x1f\x7f]+$/, "not a column key");

/**
 * One board-linked tracker item, exactly the lib/link-metadata ThreadLink
 * round-trip. The github variant's tracker is optional so records written
 * before the external variant existed still pass the output contract; new
 * writes always carry it.
 */
const GITHUB_LINK_RECORD = z.object({
  tracker: z.literal("github").optional(),
  repo: z.string().min(1),
  issue: z.number().int().positive(),
  kind: z.enum(["issue", "pull"]),
  href: z.string().refine((value) => /^https:\/\/github\.com\//.test(value), "GitHub URL"),
  createdAt: z.string(),
  source: z.enum(["agent", "operator", "auto"]),
});

/** Non-GitHub tracker item (Jira, Linear, Forgejo, anything with a URL). */
const EXTERNAL_LINK_RECORD = z.object({
  tracker: z.literal("external"),
  url: z.string().startsWith("https://"),
  hostname: z.string().min(1),
  label: z.string().min(1).max(80).optional(),
  createdAt: z.string(),
  source: z.enum(["agent", "operator", "auto"]),
});

const LINK_RECORD_SCHEMA = z.union([GITHUB_LINK_RECORD, EXTERNAL_LINK_RECORD]);

export const rpcContract = defineRpcContract({
  done_list: {
    input: z.null(),
    output: z.object({
      doneIds: z.array(z.string()),
      records: z.record(
        z.string(),
        z.object({ doneAt: z.string().optional(), keep: z.boolean().optional() }),
      ),
    }),
  },
  done_set: {
    input: z.object({ threadId: z.string().min(1), done: z.boolean() }),
    output: z.object({ done: z.boolean() }),
  },
  /**
   * Board-linked GitHub items (issue #13): per-thread plugin metadata key
   * "linkedIssues" → ThreadLink[], first entry primary (lib/link-metadata).
   * The builtin GitHub plugin persists its own thread↔issue links in bb.db
   * rows under another plugin's namespace, which focus-board cannot read
   * (no cross-plugin surface in BbPluginApi), so the board keeps its own
   * record and renders chips from title/branch text refs merged with these.
   */
  link_list: {
    input: z.null(),
    output: z.object({ links: z.record(z.string(), z.array(LINK_RECORD_SCHEMA)) }),
  },
  link_set: {
    input: z
      .object({
        threadId: z.string().min(1),
        // Exactly one of: repo+number (GitHub form), url (GitHub or
        // external). `kind` applies to the number form only; `label` to the
        // external form only.
        repo: z.string().min(1).optional(),
        number: z.number().int().positive().optional(),
        kind: z.enum(["issue", "pull"]).optional(),
        url: z.string().startsWith("https://", "https url").optional(),
        label: z.string().min(1).max(80).optional(),
        source: z.enum(["agent", "operator", "auto"]),
      })
      .superRefine((input, ctx) => {
        const hasNumber = input.number !== undefined;
        const hasUrl = input.url !== undefined;
        if (hasNumber === hasUrl) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "give exactly one of url or number",
            path: hasUrl ? ["url"] : ["number"],
          });
        }
        if (hasNumber && input.repo === undefined) {
          // Allowed: the handler resolves the repo from the thread's project
          // remote. Nothing to check here; the comment keeps the contract
          // readable.
        }
        if (input.repo !== undefined && hasUrl) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "repo applies to the number form only",
            path: ["repo"],
          });
        }
        if (input.kind !== undefined && hasUrl) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "kind applies to the number form only (the URL carries its own)",
            path: ["kind"],
          });
        }
        if (input.label !== undefined && hasNumber) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "label applies to the external-url form only",
            path: ["label"],
          });
        }
      }),
    output: z.object({ threadId: z.string(), link: LINK_RECORD_SCHEMA }),
  },
  link_clear: {
    input: z.object({
      threadId: z.string().min(1),
      number: z.number().int().positive().optional(),
    }),
    output: z.object({ threadId: z.string(), cleared: z.boolean() }),
  },
  // Parked-pin record store: the lane-exit unpin writes a park marker here
  // (see lib/pin-park.ts), and the state writes that bring the card back to
  // the operator — Mark Not Done, Mark Unread — read it to restore the pin.
  // A dumb record store on purpose: the composition (who unpins, who
  // restores) lives with the sidebar-action caller, where the writes stream.
  pin_parks_list: {
    input: z.null(),
    output: z.object({
      parks: z.record(z.string(), z.object({ parkedAt: z.string() })),
    }),
  },
  pin_park_set: {
    input: z.object({ threadId: z.string().min(1), parked: z.boolean() }),
    output: z.object({ threadId: z.string(), parked: z.boolean() }),
  },
  /**
   * Clear error (issue #157): per-thread plugin metadata key "errorAck" →
   * { ackedAt } (lib/error-ack-metadata). The operator's acknowledgment of
   * an errored card: the board stops claiming attention for that thread's
   * error signals. The pending-interaction arm is never ackable — a wait
   * for the operator needs a real answer — so the metadata only ever rides
   * beside the error arms of `threadState()`.
   */
  error_acks_list: {
    input: z.null(),
    output: z.object({
      ackIds: z.array(z.string()),
      records: z.record(z.string(), z.object({ ackedAt: z.string() })),
    }),
  },
  error_ack_set: {
    input: z.object({ threadId: z.string().min(1), acked: z.boolean() }),
    output: z.object({ threadId: z.string(), acked: z.boolean() }),
  },
  /**
   * Snooze: read now, unread later. The record map rides off the live
   * thread list (no metadata scan in the SDK); a snooze on a thread that
   * has left the list is dormant until it returns, and its record is
   * dropped by the wake when the thread is gone.
   */
  snooze_list: {
    input: z.null(),
    output: z.object({
      snoozes: z.record(
        z.string(),
        z.object({ wakeAt: z.string(), setAt: z.string() }),
      ),
    }),
  },
  // (Re-)snooze a thread until `wakeAt` (epoch-parseable; past times are
  // rejected by the handler — the contract cannot inject `now`).
  snooze_set: {
    input: z.object({
      threadId: z.string().min(1),
      wakeAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
    }),
    output: z.object({
      threadId: z.string().min(1),
      wakeAt: z.string(),
    }),
  },
  snooze_clear: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ threadId: z.string().min(1), cleared: z.boolean() }),
  },
  tracker_status: {
    input: z.object({
      repo: z.string().min(1),
      // Batch cap: one board view's visible refs stay well under 500; the
      // cap bounds the SQL IN-list built in readGitHubStatuses (SQLite's
      // default parameter limit is 999) and rejects runaway input.
      numbers: z.array(z.number().int().positive()).max(500),
    }),
    output: z.object({
      statuses: z.record(z.number().int(), z.object({ kind: z.string(), state: z.string() })),
    }),
  },
  /**
   * Text-ref validation (the chip rule, issue #13 follow-up): a #N ref or
   * GitHub URL found in text only chips when the item exists. The GitHub
   * plugin's sqlite cache is authoritative for GitHub items; an HTTP
   * existence check covers cache misses and forgejo items (no cache).
   * Store links (link_set / link tool) are trusted by construction and skip
   * this method entirely.
   */
  tracker_validate: {
    input: z.object({
      urls: z.array(z.string().startsWith("https://", "https url")).max(100),
    }),
    output: z.object({
      results: z.record(
        z.string(),
        z.object({
          confirmed: z.boolean(),
          kind: z.string().optional(),
          state: z.string().optional(),
        }),
      ),
    }),
  },

  // ✨ auto-rename: generate a thread title from its first user prompt with
  // whatever AI service bb's thread-title task is set to (Settings → AI
  // services). bb has no plugin-facing invocation for its AI services, so
  // the title rides the cross-plugin RPC bridge into the selected service's
  // own `complete` method; lib/autotitle.ts owns the pure pieces.
  thread_autotitle: {
    input: z.object({
      threadId: z.string().min(1),
      // Override target from the fallback modal: generate with an
      // alternative service instead of the failing selected one. Both or
      // neither — a half-given pair is refused in the handler.
      pluginId: z.string().min(1).optional(),
      serviceId: z.string().min(1).optional(),
      // Generate with the thread's own provider/model instead (the hidden
      // probe path). Exclusive with the service override.
      useThreadModel: z.boolean().optional(),
    }),
    output: z.object({ title: z.string() }),
  },

  // The fallback modal's menu: every registered service that can serve a
  // thread title (with readiness), the current selection, and whether the
  // thread's own model is probeable.
  thread_autotitle_services: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({
      selected: z
        .object({ pluginId: z.string(), serviceId: z.string() })
        .nullable(),
      services: z.array(
        z.object({
          pluginId: z.string(),
          serviceId: z.string(),
          displayName: z.string(),
          ready: z.boolean(),
          message: z.string().nullable(),
          // ✨ bridge classification: whether the service's plugin answers
          // the `complete` RPC at all (probed with invalid input, cached).
          bridge: z.boolean(),
          bridgeReason: z.string().nullable(),
        }),
      ),
      threadModel: z.object({
        available: z.boolean(),
        reason: z.string().nullable(),
      }),
    }),
  },

  // Existence check behind the thread pane's inline-code file links: the
  // pane only decorates code spans whose path really exists in the
  // thread's workspace (the host linkifier is string-only and will paint
  // dead links). Paths are workspace-relative and resolved against the
  // environment root here; the check runs on the environment's own host.
  workspace_files_exist: {
    input: z.object({
      threadId: z.string().min(1),
      // One visible pane's candidate paths stay well under this cap; it
      // bounds each RPC fan-out to the host daemon.
      paths: z.array(z.string().min(1)).max(200),
    }),
    output: z.object({ existence: z.record(z.string(), z.boolean()) }),
  },

  // Workspace-open discovery for the pane header's open menu: which local
  // apps can open the thread's workspace folder. The plugin server asks
  // the loopback host daemon (the same authority bb's own thread header
  // uses), so the verdict also covers the remote-browser case — the app
  // opens where the workspace lives. Unavailable always carries a reason.
  workspace_open_targets: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({
      status: z.enum(["available", "unavailable"]),
      reason: z.string().nullable(),
      root: z.string().nullable(),
      targets: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          kind: z.string().nullable(),
          icon: z
            .object({ kind: z.string() })
            .passthrough()
            .nullable(),
          capabilities: z.object({
            openDirectory: z.boolean(),
            openFile: z.boolean(),
            openFileAtLine: z.boolean(),
            openFileAtColumn: z.boolean().nullable(),
          }),
        }),
      ),
    }),
  },
  // Open the thread's workspace folder in one of the discovered targets.
  // Errors come back as { ok: false, message } — the menu shows them
  // inline rather than dying silently.
  workspace_open_in_target: {
    input: z.object({
      threadId: z.string().min(1),
      targetId: z.string().min(1),
    }),
    output: z.object({ ok: z.boolean(), message: z.string().nullable() }),
  },

  sweep_config_get: {
    input: z.null(),
    /**
     * Thresholds resolved to exact epoch ms from the operator's value+unit
     * settings (lib/duration owns the conversion). The board stays
     * unit-ignorant; the CLI reads the raw settings for display.
     */
    output: z.object({
      doneArchiveMs: z.number().int().min(1),
      idleArchiveMs: z.number().int().min(1),
    }),
  },
  sweep_keep_set: {
    input: z.object({ threadId: z.string().min(1), keep: z.boolean() }),
    output: z.object({ threadId: z.string().min(1), keep: z.boolean() }),
  },

  /**
   * Re-parenting: drop a card onto a card (nest it), or detach a card back
   * to top level (`parentThreadId: null`). The handler re-checks
   * lib/reparent's rules against its own fresh thread rows — the board's map
   * is stale the moment any other surface moves a family — and a loop write
   * (a card under its own child) would corrupt bb's own sidebar tree, so a
   * refused gesture throws and the board says why on screen.
   */
  thread_reparent: {
    input: z.object({
      threadId: z.string().min(1),
      parentThreadId: z.string().min(1).nullable(),
    }),
    output: z.object({
      threadId: z.string().min(1),
      parentThreadId: z.string().min(1).nullable(),
    }),
  },

  rank_list: {
    input: z.null(),
    output: z.object({ orders: z.record(z.string(), z.array(z.string())) }),
  },
  /**
   * A single move, not a whole-column write: two boards open on the same
   * column each lose only their own move, instead of the second write
   * clobbering every rank the first one established. Concurrent moves are
   * serialized server-side (withKvWriteLock), so an interleave can never
   * revert the other writer's column.
   */
  rank_move: {
    input: z.object({
      columnKey: COLUMN_KEY_SCHEMA,
      threadId: z.string().min(1),
      /** The card to land in front of; null means the top of the column. */
      beforeId: z.string().nullable(),
      /** Drop below the last ranked card instead of at an anchor. */
      toEnd: z.boolean(),
      /**
       * The column's displayed order at drop time (used only to name and
       * order the UNRANKED remainder: which cards sit above the drop point
       * without a rank, and a unit move's membership). Ranked cards take
       * their positions from the server's stored fractions — a stale view
       * cannot rewrite them, so two windows' drags in the same lane both
       * survive.
       */
      visibleIds: z.array(z.string()),
      /**
       * The ids of a family box's members moving WITH `threadId` as one
       * unit (the box's drag contract). Present (non-empty) → the move is
       * a unit move: the ids land contiguously, all ranked together.
       * `threadId` must be one of them (fail loud otherwise — a mismatch
       * is a client bug, not data to paper over).
       */
      unitIds: z.array(z.string().min(1)).optional(),
    }),
    output: z.object({ columnKey: COLUMN_KEY_SCHEMA, order: z.array(z.string()) }),
  },

  /**
   * Feature groups (the family boxes): a registry row of named groups
   * (`focus-board:groups`) plus per-thread assignment metadata (key
   * "group"). The registry carries ONLY names/creation stamps;
   * membership always derives from the thread metadata, so the
   * "exists while assigned" rule is a read, not a synchronizer.
   */
  groups_list: {
    input: z.null(),
    output: z.object({
      groups: z.record(
        z.string(),
        z.object({ name: z.string(), createdAt: z.string() }),
      ),
      /** Live thread id → groupId; archived members report through GC only. */
      memberships: z.record(z.string(), z.string()),
    }),
  },
  group_create: {
    input: z.object({ name: z.string().min(1).max(200) }),
    output: z.object({
      group: z.object({ id: z.string().min(1), name: z.string(), createdAt: z.string() }),
    }),
  },
  group_rename: {
    input: z.object({ groupId: z.string().min(1), name: z.string().min(1).max(200) }),
    output: z.object({
      group: z.object({ id: z.string().min(1), name: z.string(), createdAt: z.string() }),
    }),
  },
  /**
   * Assign or clear a thread's group (null clears). The write GCs the
   * registry afterward: a group whose last member (live OR archived — an
   * archived member still holds its assignment) is gone is deleted, which
   * is the whole "exists only while assigned" lifecycle.
   */
  group_set: {
    input: z.object({ threadId: z.string().min(1), groupId: z.string().min(1).nullable() }),
    output: z.object({ threadId: z.string().min(1), groupId: z.string().min(1).nullable() }),
  },
  /**
   * Delete a group outright: the registry record goes AND every member's
   * "group" metadata clears (live AND archived rows) — without the sweep the
   * dead id would survive as orphaned per-thread metadata forever. The GC
   * path (prune-on-last-unassign) covers drift; this covers a deliberate
   * operator delete from the picker.
   */
  group_delete: {
    input: z.object({ groupId: z.string().min(1) }),
    output: z.object({ groupId: z.string().min(1) }),
  },
  /**
   * Family fold + idle-hide state, moved off browser localStorage so the two
   * sets follow across every window AND every machine (lib/family-state).
   * ONE plugin-wide KV row, key "focus-board:family-state" →
   * { collapsedFamilies: string[], hideIdleChildren: string[] }, exactly the
   * shape of the plugin's other board-global stores (the groups registry,
   * the done index, the rank orders, the keep flags). The row holds PARENT
   * thread ids plus Done-projection keys `done:<parent id>`, which is why a
   * per-thread metadata surface does not fit: the key space is not thread
   * ids. An id absent from a list renders expanded / not-hidden (the
   * default), so a list only ever records deliberate toggles.
   */
  family_state_list: {
    input: z.null(),
    output: z.object({
      collapsedFamilies: z.array(z.string()),
      hideIdleChildren: z.array(z.string()),
    }),
  },
  /**
   * One deliberate toggle: add or remove one id in one of the two sets. A
   * single-id delta against the stored row (the shape the old localStorage
   * write guards used), applied under the server's KV write lock so a
   * concurrent toggle from another window is never erased by a stale
   * snapshot. A no-op toggle writes nothing and publishes nothing.
   */
  family_state_set: {
    input: z.object({
      key: z.enum(FAMILY_STATE_KEYS),
      // Parent thread ids and `done:<parent id>` projection keys; a generous
      // cap bounds the row entry without constraining any real id.
      id: z.string().min(1).max(200),
      on: z.boolean(),
    }),
    output: z.object({
      key: z.enum(FAMILY_STATE_KEYS),
      id: z.string(),
      on: z.boolean(),
    }),
  },
  /**
   * The one-time localStorage migration write: union the operator's stored
   * folds into the server row. Never removes, so it can only preserve state;
   * one atomic KV write, so a partial migration is impossible.
   */
  family_state_merge: {
    input: z.object({
      collapsedFamilies: z.array(z.string().min(1).max(200)).max(5000),
      hideIdleChildren: z.array(z.string().min(1).max(200)).max(5000),
    }),
    output: z.object({
      collapsedFamilies: z.array(z.string()),
      hideIdleChildren: z.array(z.string()),
    }),
  },
  /**
   * Token burn rates for the working dots' pulse (issue #279), in tokens per
   * second, read from the sampler's in-memory rings (lib/thread-pulse). A
   * thread absent from `rates` has no measurable rate yet: absence is the
   * honest "unknown", never a fabricated zero.
   *
   * The CALL is also the sampler's demand signal: it extends the lease that
   * keeps token sampling alive, so a board nobody is looking at costs no reads
   * at all (lib/thread-pulse, `beginDemand`).
   */
  pulse_rates: {
    input: z.null(),
    output: z.object({
      rates: z.record(z.string(), z.number()),
      generatedAt: z.number(),
    }),
  },
});

/**
 * The unit select's stored value is typed plain `string`; the descriptor's
 * enum schema guarantees membership at write time — re-parse to narrow the
 * type (and to fail loud if a foreign value ever lands in the store).
 */
const ARCHIVE_UNIT_SCHEMA = z.enum(ARCHIVE_UNITS);

/** Realtime signal after every done/keep write. Payload is { threadId, done }
 *  (was { count } before the metadata migration); consumers refetch on the
 *  event rather than reading the payload. */
const DONE_CHANGED = "done-changed";
/** Realtime signal after every snooze set/clear/wake. Payload is
 *  { threadId }; consumers refetch the record map. */
const SNOOZE_CHANGED = "snooze-changed";
/** Realtime signal after every error-ack set/clear. Payload is
 *  { threadId, acked }; consumers refetch the record map, the same refetch
 *  contract done-changed holds (a payload the consumer reads blind cannot
 *  desync a board that missed an earlier event). */
const ERROR_ACK_CHANGED = "error-ack-changed";
/** Realtime signal after every link set/clear. Payload is { threadIds };
 *  consumers refetch the record map. */
const LINK_CHANGED = "link-changed";
/** Realtime signal after a rank write. Payload names the column; boards
 *  refetch the whole store, so a stale payload cannot desync an order. */
const RANK_CHANGED = "rank-changed";
/** Realtime signal after any group write (create, rename, assign, clear,
 *  prune). Payload is { threadId }; consumers refetch the registry AND the
 *  membership map — one event covers both shapes because a prune touches
 *  neither thread's assignment yet moves every other member's label. */
const GROUP_CHANGED = "group-changed";
/** Realtime signal after any family-state write (a fold/idle toggle, or the
 *  one-time migration merge). Payload names the toggle { key, id, on } (the
 *  migration merge sends { key: null, id: null, on: null }); consumers
 *  refetch both sets, so a payload the consumer reads blind cannot desync a
 *  board that missed an earlier event. */
const FAMILY_STATE_CHANGED = "family-state-changed";
/** Legacy KV key written before the metadata migration. */
const LEGACY_DONE_KEY = "done-thread-ids";
/** Per-thread sweep keep flags, independent of Done marks. */
const KEEP_KEY = "sweep-keep-flags";
/**
 * Best-effort index of thread ids the board believes carry its `done`
 * metadata. The SDK has no metadata scan, so `bb focus-board done list`
 * and `sweep` use it to report marks on threads that have dropped out of
 * both the live and archived thread lists (deleted since their mark).
 * Metadata stays the source of truth; the index only widens reporting of
 * orphaned marks. Updated on every done write (board RPC, CLI, legacy
 * import).
 */
const DONE_INDEX_KV_KEY = "done-index";

// time ("mirror, don't integrate": read-only, degrade-to-empty access —
// see lib/tracker-status.ts).
const GITHUB_CACHE_DB = ".bb/plugins/github/data.db";

// The freshness layer over that cache (issue #187, reshaped by issue
// #236): a stateless trust-window judge that answers only what the cache
// can honestly vouch for — no probe, no server-side verdict store.
const trackerFreshness = createTrackerFreshnessJudge();

type KeepStore = Record<string, true>;

/**
 * The raw KV row shape for the keep store — the single encoding both
 * writeKept persists and readKept validates, so a written row round-trips.
 */
export function keepRowFromStore(store: KeepStore): Record<string, { keep: true }> {
  return Object.fromEntries(
    Object.keys(store).map((id) => [id, { keep: true as const }]),
  );
}

export function keptFromRow(row: unknown): KeepStore | null {
  if (row === null || row === undefined) return null;
  if (typeof row !== "object" || Array.isArray(row)) return null;
  const entries = Object.entries(row as Record<string, unknown>);
  const valid = entries.every(([id, record]) =>
    typeof id === "string" &&
    typeof record === "object" &&
    record !== null &&
    !Array.isArray(record) &&
    (record as { keep?: unknown }).keep === true &&
    Object.keys(record).length === 1,
  );
  if (!valid) return null;
  return Object.fromEntries(entries.map(([id]) => [id, true as const]));
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    // Each sweep threshold is a value+unit pair: the number is a count of
    // the unit setting next to it (hours | days | weeks). Both arms
    // default to 2 days — the operator-tuned aggressive default. The
    // integer caps keep the old per-arm ranges as a garbage rail (365 for
    // Done, 3650 for idle) in whatever unit is configured.
    doneArchiveValue: {
      type: "number",
      label: "Sweep: archive Done threads after",
      description:
        "How long a thread stays Done before the sweep offers to archive it — a count of the unit chosen below. Default 2 days.",
      experimental_schema: z.number().int().min(1).max(365),
      default: DEFAULT_ARCHIVE_VALUE,
    },
    doneArchiveUnit: {
      type: "select",
      label: "Sweep: Done archive unit",
      options: [...ARCHIVE_UNITS],
      experimental_schema: ARCHIVE_UNIT_SCHEMA,
      default: DEFAULT_ARCHIVE_UNIT,
    },
    idleArchiveValue: {
      type: "number",
      label: "Sweep: mark long-idle threads Done after",
      description:
        "How long a thread stays quiet before the sweep offers to mark it Done — a count of the unit chosen below. Default 2 days.",
      experimental_schema: z.number().int().min(1).max(3650),
      default: DEFAULT_ARCHIVE_VALUE,
    },
    idleArchiveUnit: {
      type: "select",
      label: "Sweep: idle threshold unit",
      options: [...ARCHIVE_UNITS],
      experimental_schema: ARCHIVE_UNIT_SCHEMA,
      default: DEFAULT_ARCHIVE_UNIT,
    },
    // Jira integration. Off by default; with it off the board behaves like upstream.
    jiraEnabled: {
      type: "boolean",
      label: "Jira: enable integration",
      description: "Link threads to Jira tickets and keep them in sync. Needs the companion script and an acli login.",
      default: false,
    },
    jiraProjects: {
      type: "string",
      label: "Jira: projects to search",
      description: "Comma-separated project keys. Default PT,SRE.",
      default: "PT,SRE",
    },
    jiraDefaultProject: {
      type: "string",
      label: "Jira: default project for new tickets",
      default: "SRE",
    },
    jiraNudgeDays: {
      type: "number",
      label: "Jira: nudge a quiet thread after (days)",
      experimental_schema: z.number().int().min(1).max(365),
      default: 2,
    },
    jiraDeepCheckDays: {
      type: "number",
      label: "Jira: deeper check after (days)",
      description: "Always kept above the nudge days.",
      experimental_schema: z.number().int().min(1).max(365),
      default: 5,
    },
    jiraStaleTicketDays: {
      type: "number",
      label: "Jira: stale ticket after (days)",
      experimental_schema: z.number().int().min(1).max(3650),
      default: 30,
    },
    jiraNudgeTurnsPerPass: {
      type: "number",
      label: "Jira: max nudge turns per scheduler pass",
      experimental_schema: z.number().int().min(1).max(50),
      default: 3,
    },
    jiraRefreshMinutes: {
      type: "number",
      label: "Jira: snapshot refresh (minutes)",
      experimental_schema: z.number().int().min(1).max(60),
      default: 2,
    },
    // The thread pane's Escape behavior. Rendered as a toggle in the
    // plugin detail page's configuration panel; the board reads it
    // reactively through the frontend `useSettings()` hook (explicit
    // stored false is off — loading/unavailable keeps the default).
    escStopsRunningThread: {
      type: "boolean",
      label: "Thread pane: Escape stops a running thread first",
      description:
        "While a thread is running, Escape interrupts its turn instead of closing the pane; the pane closes with Escape once nothing is running, and a rapid double-tap never closes it.",
      default: true,
    },
    // The overview board's New Thread composer shortcut. The board reads
    // it reactively through the frontend `useSettings()` hook
    // (components/preferences.ts) and the settings modal's Behavior tab
    // edits it: a single letter or digit (stored lowercase), default C;
    // an explicitly empty string turns the shortcut off. The schema only
    // keeps obvious garbage out of the write; a stale foreign value the
    // frontend falls back to the C default on (never trusts it).
    newThreadShortcutKey: {
      type: "string",
      label: "Board: New Thread composer shortcut",
      description:
        "A single letter or digit that opens the New Thread composer from the overview board when no pane is open. Default C; clear the field to turn the shortcut off.",
      experimental_schema: z
        .string()
        .regex(/^$|^[a-zA-Z0-9]$/, "Use a single letter or digit, or an empty string"),
      default: "C",
    },
    // Debug-mode scroll instrumentation for the pane's embedded chat
    // (docs/chat-click-jump-2026-09-29.md investigation). Ships OFF: the
    // committed default is off everywhere, so stable builds never
    // instrument; it is turned on in a developer environment through this
    // setting alone. While on, the pane wraps the transcript scroller's
    // scrollTop setter and logging session; the log reaches the browser
    // console and the `__focusBoardScrollDebug.dump()` window handle only
    // (see components/scroll-debug.ts) — the pane header carries no debug
    // button.
    scrollDebugInstrumentation: {
      type: "boolean",
      label: "Developer: instrument pane chat scrolling (debug)",
      description:
        "Logs the pane chat transcript's scroll writes with calling stacks, plus scroll/wheel/touch events, to the browser console with a __focusBoardScrollDebug.dump() window handle. Debug use only; keep off otherwise.",
      default: false,
    },
  });

  // Workspace-open state for the pane header's open menu. The local host
  // daemon is probed per call (cheap), while the per-root app discovery —
  // seconds on a cold daemon — is cached for the pane's lifetime here.
  const workspaceOpenTargetsCache = createWorkspaceOpenTargetsCache(5 * 60_000);

  async function requireLocalDaemon(): Promise<HostDaemonProbe | null> {
    const config = (await bb.sdk.system.config()) as {
      hostDaemonPort?: number | null;
      localHelperPorts?: number[] | null;
    };
    return probeLocalDaemon(daemonPortsFromSystemConfig(config), {
      fetchImpl: fetch,
      timeoutMs: 3_000,
    });
  }

  async function resolveThreadWorkspaceOpen(
    threadId: string,
  ): Promise<WorkspaceOpenState> {
    const thread = await bb.sdk.threads.get({ threadId });
    const environmentId =
      "environmentId" in thread ? thread.environmentId : null;
    if (environmentId === null) {
      return {
        status: "unavailable",
        reason: "This thread runs outside an environment, so it has no workspace to open.",
        root: null,
        targets: [],
      };
    }
    const environment = await bb.sdk.environments.get({ environmentId });
    return resolveWorkspaceOpenState({
      root: environment.path,
      environmentHostId: environment.hostId,
      systemConfig: (await bb.sdk.system.config()) as {
        hostDaemonPort?: number | null;
        localHelperPorts?: number[] | null;
      },
      deps: { fetchImpl: fetch, timeoutMs: 15_000 },
      targetsCache: workspaceOpenTargetsCache,
    });
  }

  async function readDoneRecord(
    threadId: string,
  ): Promise<DoneRecord | null> {
    // getPluginMetadata returns an untyped namespace record; cast to the
    // JsonValue contract parseDoneRecord validates.
    const namespace = await bb.sdk.threads.getPluginMetadata({ threadId });
    const value = (namespace as Record<string, JsonValue>)[DONE_METADATA_KEY];
    return parseDoneRecord(value);
  }

  /**
   * The 404 bb answers for a thread id the host no longer has — deleted
   * since a board-owned index (the done index) last saw it.
   * getPluginMetadata is the only per-thread reader, so this exact
   * rejection is what a stale index entry produces (issue #259).
   */
  function isThreadGoneError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /thread not found/i.test(message) || /\b404\b/.test(message);
  }

  /**
   * A thread's Done record as a scan reads it. "gone" is a reportable
   * state for a best-effort scan — the done index can outlive the thread
   * it names — while any rejection that is NOT the thread-gone 404
   * propagates, so a genuine infrastructure failure stays loud.
   */
  type DoneRecordScan =
    | { state: "record"; record: DoneRecord }
    | { state: "none" }
    | { state: "gone" };

  async function scanDoneRecord(threadId: string): Promise<DoneRecordScan> {
    let namespace: unknown;
    try {
      namespace = await bb.sdk.threads.getPluginMetadata({ threadId });
    } catch (error: unknown) {
      if (isThreadGoneError(error)) return { state: "gone" };
      throw error;
    }
    const value = (namespace as Record<string, JsonValue>)[DONE_METADATA_KEY];
    const record = parseDoneRecord(value);
    return record === null ? { state: "none" } : { state: "record", record };
  }

  async function readDoneIndex(): Promise<string[]> {
    const ids: unknown = await bb.storage.kv.get(DONE_INDEX_KV_KEY);
    if (!Array.isArray(ids)) return [];
    return ids.filter((id): id is string => typeof id === "string");
  }

  async function addToDoneIndex(threadId: string): Promise<void> {
    // One KV row read-merged per mark, so a mark on another thread (another
    // window, or the CLI) is erased by a stale-snapshot write unless the
    // cycle serializes — same rule as every other whole-row store.
    await withKvWriteLock(async () => {
      const ids = new Set(await readDoneIndex());
      if (ids.has(threadId)) return;
      ids.add(threadId);
      await bb.storage.kv.set(DONE_INDEX_KV_KEY, [...ids]);
    });
  }

  async function removeFromDoneIndex(threadId: string): Promise<void> {
    await withKvWriteLock(async () => {
      const ids = await readDoneIndex();
      if (!ids.includes(threadId)) return;
      await bb.storage.kv.set(
        DONE_INDEX_KV_KEY,
        ids.filter((id) => id !== threadId),
      );
    });
  }

  async function writeDoneRecord(threadId: string, done: boolean) {    const now = new Date();
    if (done) {
      const existing = await readDoneRecord(threadId);
      const record = stampDone(existing, now);
      await bb.sdk.threads.updatePluginMetadata({
        threadId,
        set: { [DONE_METADATA_KEY]: record },
      });
      await addToDoneIndex(threadId);
    } else {
      await bb.sdk.threads.updatePluginMetadata({
        threadId,
        remove: [DONE_METADATA_KEY],
      });
      await removeFromDoneIndex(threadId);
    }
  }

  async function readPinParkRecord(
    threadId: string,
  ): Promise<PinParkRecord | null> {
    // Same cast contract as readDoneRecord above: getPluginMetadata returns
    // an untyped namespace record; parsePinParkRecord validates the shape.
    const namespace = await bb.sdk.threads.getPluginMetadata({ threadId });
    const value = (namespace as Record<string, JsonValue>)[PIN_PARK_METADATA_KEY];
    return parsePinParkRecord(value);
  }

  /**
   * Park or clear the lane-exit pin marker. Parking refreshes the stamp —
   * a prior park never survives a newer gesture; clearing deletes the key.
   */
  async function writePinPark(threadId: string, parked: boolean): Promise<void> {
    if (parked) {
      const existing = await readPinParkRecord(threadId);
      const record = stampPinPark(existing, new Date());
      await bb.sdk.threads.updatePluginMetadata({
        threadId,
        set: { [PIN_PARK_METADATA_KEY]: record },
      });
    } else {
      await bb.sdk.threads.updatePluginMetadata({
        threadId,
        remove: [PIN_PARK_METADATA_KEY],
      });
    }
  }

  async function readErrorAckRecord(
    threadId: string,
  ): Promise<ErrorAckRecord | null> {
    // Same cast contract as readDoneRecord: getPluginMetadata returns an
    // untyped namespace record; parseErrorAckRecord validates the shape.
    const namespace = await bb.sdk.threads.getPluginMetadata({ threadId });
    const value = (namespace as Record<string, JsonValue>)[
      ERROR_ACK_METADATA_KEY
    ];
    return parseErrorAckRecord(value);
  }

  /**
   * Acknowledge or un-acknowledge a thread's error. Acknowledging stamps a
   * fresh record — a re-ack refreshes the stamping; clearing deletes the
   * key (a thread that never carried a record clears clean, the stale-ack
   * sweep's shape: the caller may sweep an id the store has already dropped).
   */
  async function writeErrorAck(threadId: string, acked: boolean): Promise<void> {
    if (acked) {
      const record = stampErrorAck(new Date());
      await bb.sdk.threads.updatePluginMetadata({
        threadId,
        set: { [ERROR_ACK_METADATA_KEY]: record },
      });
    } else {
      await bb.sdk.threads.updatePluginMetadata({
        threadId,
        remove: [ERROR_ACK_METADATA_KEY],
      });
    }
  }

  // --- Feature groups (the family boxes) ---

  async function readGroupsStore(): Promise<Readonly<Record<string, GroupRecord>>> {
    const row = await bb.storage.kv.get(GROUPS_KV_KEY);
    return parseGroupsStore(row);
  }

  async function writeGroupsStore(store: Readonly<Record<string, GroupRecord>>): Promise<void> {
    await bb.storage.kv.set(GROUPS_KV_KEY, groupsRowFromStore(store));
  }

  // --- Family fold + idle-hide state (lib/family-state) ---
  //
  // ONE plugin-wide KV row holding both deliberate-toggle sets. The board's
  // fold and idle-hide gestures, the cross-window/cross-machine convergence,
  // and the one-time localStorage migration all move through these two
  // helpers; the row is a whole-row read-merge-write like every other KV
  // store, so every writer serializes on withKvWriteLock.

  async function readFamilyState(): Promise<FamilyStateStore> {
    // get returns an untyped row; parseFamilyStateStore validates it and
    // throws on a present-but-malformed row (fail loud, never coerce).
    return parseFamilyStateStore(await bb.storage.kv.get(FAMILY_STATE_KV_KEY));
  }

  async function writeFamilyState(store: FamilyStateStore): Promise<void> {
    await bb.storage.kv.set(FAMILY_STATE_KV_KEY, familyStateRowFromStore(store));
  }

  async function readGroupAssignment(
    threadId: string,
  ): Promise<{ groupId: string } | null> {
    // Same cast contract as readDoneRecord: getPluginMetadata returns an
    // untyped namespace record; parseGroupMember validates the shape.
    const namespace = await bb.sdk.threads.getPluginMetadata({ threadId });
    const value = (namespace as Record<string, JsonValue>)[GROUP_METADATA_KEY];
    return parseGroupMember(value);
  }

  async function writeGroupAssignment(threadId: string, groupId: string | null): Promise<void> {
    if (groupId === null) {
      await bb.sdk.threads.updatePluginMetadata({
        threadId,
        remove: [GROUP_METADATA_KEY],
      });
      return;
    }
    await bb.sdk.threads.updatePluginMetadata({
      threadId,
      set: { [GROUP_METADATA_KEY]: { groupId } },
    });
  }

  /**
   * groupId → assigned-thread count across LIVE and ARCHIVED rows: an
   * archived member still carries its assignment metadata, so it still
   * keeps the group's record alive (the group must reappear with the
   * thread if it is ever unarchived). getPluginMetadata per row, like
   * every other scan here.
   */
  async function countAllGroupMembers(): Promise<Map<string, number>> {
    const [live, archived] = await Promise.all([
      bb.sdk.threads.list({}),
      bb.sdk.threads.list({ archived: true, limit: 200 }),
    ]);
    const counts = new Map<string, number>();
    for (const row of [...live, ...archived]) {
      const record = await readGroupAssignment(row.id);
      if (record === null) continue;
      counts.set(record.groupId, (counts.get(record.groupId) ?? 0) + 1);
    }
    return counts;
  }

  async function pruneGroupsToMembers(): Promise<void> {
    // The registry is one KV row rewritten whole: the prune runs under the
    // KV write lock so a group created (or renamed) by another writer during
    // the member scan survives the write-back.
    await withKvWriteLock(async () => {
      const store = await readGroupsStore();
      const counts = await countAllGroupMembers();
      const pruned = pruneEmptyGroups(store, counts);
      if (Object.keys(pruned).length === Object.keys(store).length) return;
      await writeGroupsStore(pruned);
    });
  }

  function unknownGroupError(groupId: string): PluginCliError {
    return new PluginCliError(
      `group ${groupId} does not exist`,
      { code: "invalid_value", hint: "Assign against a group from groups_list." },
    );
  }

  // --- Feature-group writes shared by every surface ---
  //
  // The RPC contract, the `bb focus-board group` CLI commands (issue #84),
  // and the focus_board_group_set agent tool all run these five flows; the
  // registry, the per-thread metadata, and the group-changed signal move in
  // exactly one place each.

  /**
   * Resolve a group reference coming from operator or agent input: an exact
   * registry id wins, then a unique exact-name match. Duplicate names are
   * legal state (group_create does not enforce uniqueness), so an ambiguous
   * name fails loud naming the ids instead of silently picking one.
   */
  async function resolveGroupRef(
    ref: string,
  ): Promise<{ id: string; name: string; createdAt: string }> {
    const store = await readGroupsStore();
    const direct = store[ref];
    if (direct !== undefined) return { id: ref, ...direct };
    const matches = Object.entries(store).filter(
      ([, record]) => record.name === ref,
    );
    if (matches.length === 1) {
      const [id, record] = matches[0] as [string, GroupRecord];
      return { id, ...record };
    }
    if (matches.length > 1) {
      const ids = matches.map(([id]) => id).sort();
      throw new PluginCliError(
        `group name ${JSON.stringify(ref)} matches ${matches.length} groups: ${ids.join(", ")}`,
        {
          code: "invalid_value",
          hint: "Duplicate names are ambiguous; pass the group id instead (list shows every id).",
        },
      );
    }
    throw new PluginCliError(
      `group ${JSON.stringify(ref)} does not exist`,
      { code: "invalid_value", hint: "List groups with `bb focus-board group list`." },
    );
  }

  /**
   * Create (idempotent): a group with the exact same name already exists →
   * return its record unchanged (created false); several duplicates resolve
   * to the earliest creation stamp, ties broken by id, so a repeated call
   * always lands on the same group deterministically. Otherwise a fresh
   * uuid record is written and the group-changed signal publishes.
   */
  async function createGroupNamed(
    name: string,
  ): Promise<{ id: string; record: GroupRecord; created: boolean }> {
    const settled = normalizeGroupName(name);
    if (settled === null) {
      throw new PluginCliError(
        `group name must be 1-80 non-blank characters, got ${JSON.stringify(name)}`,
        { code: "invalid_value" },
      );
    }
    return withKvWriteLock(async () => {
      const store = await readGroupsStore();
      const matches = Object.entries(store)
        .filter(([, record]) => record.name === settled)
        .sort(([idA, recA], [idB, recB]) =>
          recA.createdAt === recB.createdAt
            ? idA.localeCompare(idB)
            : recA.createdAt.localeCompare(recB.createdAt),
        );
      if (matches.length > 0) {
        const [id, record] = matches[0] as [string, GroupRecord];
        return { id, record, created: false };
      }
      const id = crypto.randomUUID();
      const record = createGroupRecord(settled, new Date());
      await writeGroupsStore({ ...store, [id]: record });
      bb.realtime.publish(GROUP_CHANGED, { threadId: null });
      return { id, record, created: true };
    });
  }

  async function renameGroupById(groupId: string, name: string): Promise<GroupRecord> {
    // The registry is one KV row rewritten whole: the read-merge write runs
    // under the KV write lock so another writer's concurrent create or
    // rename is not erased by this write's stale snapshot.
    return withKvWriteLock(async () => {
      const store = await readGroupsStore();
      if (store[groupId] === undefined) throw unknownGroupError(groupId);
      const settled = normalizeGroupName(name);
      if (settled === null) {
        throw new PluginCliError(
          `group name must be 1-80 non-blank characters, got ${JSON.stringify(name)}`,
          { code: "invalid_value" },
        );
      }
      const record = { ...store[groupId], name: settled };
      await writeGroupsStore({ ...store, [groupId]: record });
      bb.realtime.publish(GROUP_CHANGED, { threadId: null });
      return record;
    });
  }

  /**
   * Assign or clear one thread's group (null clears). Returns what it
   * replaced (from, and the name as it read BEFORE the write — the GC this
   * write triggers can remove the record the pointer just left) for CLI
   * and tool outputs to name; the RPC contract keeps its bare
   * { threadId, groupId } pair. The GC runs after the write because the
   * assignment this cleared may be the group's last.
   */
  async function setThreadGroup(
    threadId: string,
    groupId: string | null,
  ): Promise<{
    threadId: string;
    groupId: string | null;
    from: string | null;
    fromName: string | null;
  }> {
    const current = await readGroupAssignment(threadId);
    const from = current?.groupId ?? null;
    const store = await readGroupsStore();
    if (groupId !== null && store[groupId] === undefined) {
      throw unknownGroupError(groupId);
    }
    const fromName =
      from === null ? null : store[from]?.name ?? `unknown group ${from}`;
    // Idempotent at the core: the value already held is settled — no
    // rewrite, no GC scan, no group-changed signal (a re-run of any
    // surface reports the settled call instead of re-publishing).
    if (from === groupId) {
      return { threadId, groupId, from, fromName };
    }
    await writeGroupAssignment(threadId, groupId);
    await pruneGroupsToMembers();
    bb.realtime.publish(GROUP_CHANGED, { threadId });
    return { threadId, groupId, from, fromName };
  }

  /**
   * Delete a group outright (NOT idempotent: an unknown id or name is
   * refused, a typo must not "delete" nothing successfully). Strip the
   * assignment from every member first: live AND archived rows (an
   * archived member keeps its metadata, so it would outlive the record as
   * an orphan pointing at a group groups_list can never name). One signal
   * carries both halves (assignment clears + row removal); the realtime
   * surface refetches everything group-shaped from it.
   */
  async function deleteGroup(
    groupId: string,
  ): Promise<{ groupId: string; cleared: string[] }> {
    // The registry is one KV row rewritten whole: the whole delete — the
    // store read, the member scan, the write-back — runs under the KV write
    // lock so another writer's concurrent create or rename is not erased.
    return withKvWriteLock(async () => {
      const store = await readGroupsStore();
      if (store[groupId] === undefined) throw unknownGroupError(groupId);
      const [liveRows, archivedRows] = await Promise.all([
        bb.sdk.threads.list({}),
        bb.sdk.threads.list({ archived: true, limit: 200 }),
      ]);
      const cleared: string[] = [];
      for (const row of [...liveRows, ...archivedRows]) {
        const record = await readGroupAssignment(row.id);
        if (record?.groupId !== groupId) continue;
        await writeGroupAssignment(row.id, null);
        cleared.push(row.id);
      }
      const { [groupId]: _removed, ...rest } = store;
      await writeGroupsStore(rest);
      bb.realtime.publish(GROUP_CHANGED, { threadId: cleared[cleared.length - 1] ?? null });
      return { groupId, cleared };
    });
  }

  // Linked GitHub items (issue #13): the chip feed that works when neither
  // the title nor the branch name carries a text ticket ref.

  async function readLinkedIssues(threadId: string): Promise<ThreadLink[] | null> {
    // Same cast contract as readDoneRecord above: getPluginMetadata returns
    // an untyped namespace record; parseLinkedIssues validates the shape.
    const namespace = await bb.sdk.threads.getPluginMetadata({ threadId });
    const value = (namespace as Record<string, JsonValue>)[LINK_METADATA_KEY];
    return parseLinkedIssues(value);
  }

  async function writeLinkedIssues(threadId: string, links: ThreadLink[] | null): Promise<void> {
    if (links === null) {
      await bb.sdk.threads.updatePluginMetadata({
        threadId,
        remove: [LINK_METADATA_KEY],
      });
      return;
    }
    await bb.sdk.threads.updatePluginMetadata({
      threadId,
      set: { [LINK_METADATA_KEY]: links },
    });
  }

  async function publishLinksChanged(threadIds: string[]): Promise<void> {
    bb.realtime.publish(LINK_CHANGED, { threadIds });
  }

  /**
   * Resolve the repo slug a link targets: an explicit `owner/repo` argument
   * wins, else the thread's project remote (fail loud when the project has
   * no GitHub remote — never link against a guessed repo).
   */
  async function resolveLinkRepo(threadId: string, repoArg: string | undefined): Promise<string> {
    if (repoArg !== undefined) return repoArg;
    const thread = await bb.sdk.threads.get({ threadId });
    const project = await bb.sdk.projects.get({
      projectId: thread.projectId,
    });
    const slug = resolveRepoSlug(project.gitRemoteUrl);
    if (slug === null) {
      throw new PluginCliError(
        `cannot resolve a GitHub repo for thread ${threadId}`,
        {
          code: "invalid_value",
          hint: `Project ${project.name} has no GitHub remote. Pass --repo owner/repo explicitly.`,
        },
      );
    }
    return slug;
  }

  /**
   * Legacy KV "done-thread-ids" held either a plain string[] (main's
   * original shape) or a per-thread record map with epoch-ms doneAt and an
   * optional keep flag (the sweep sibling's stopgap). Import both into
   * per-thread metadata, then delete the key: metadata is the only store
   * from here on. Checks each thread's existing record first, so a
   * partial import converges on the next read and the key is deleted only
   * once every entry is imported. Runs before both done_list and done_set:
   * a done=false written while the legacy value is still present must not
   * be resurrected by a later import.
   */
  async function importLegacyDone(): Promise<void> {
    const legacy: unknown = await bb.storage.kv.get(LEGACY_DONE_KEY);
    if (legacy === undefined || legacy === null) return;
    const keepFlag = (keep: unknown) =>
      typeof keep === "boolean" && keep ? { keep: true } : {};
    if (Array.isArray(legacy)) {
      // Main's shape: bare thread ids with no age data — stamp at import.
      const iso = new Date().toISOString();
      for (const id of legacy) {
        if (typeof id !== "string") {
          throw new Error(`legacy done ids: non-string entry ${JSON.stringify(id)}`);
        }
        await importOne(id, { doneAt: iso });
      }
    } else if (typeof legacy === "object") {
      // Sweep sibling's shape: record map with epoch-ms doneAt, keep flag.
      for (const [threadId, entry] of Object.entries(
        legacy as Record<string, unknown>,
      )) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          throw new Error(
            `legacy done records: malformed entry for ${JSON.stringify(threadId)}`,
          );
        }
        const record = entry as { doneAt?: unknown; keep?: unknown };
        if (
          !(
            (typeof record.doneAt === "number" &&
              Number.isFinite(record.doneAt)) ||
            (typeof record.doneAt === "string" &&
              !Number.isNaN(Date.parse(record.doneAt)))
          )
        ) {
          throw new Error(
            `legacy done records: invalid doneAt for ${JSON.stringify(threadId)}: ${JSON.stringify(record.doneAt)}`,
          );
        }
        const imported: DoneRecord =
          typeof record.doneAt === "number"
            ? {
                doneAt: new Date(record.doneAt).toISOString(),
                ...keepFlag(record.keep),
              }
            : // Epoch-free shape already; keep the ISO string as written,
              // carry keep only when true (DoneRecord's optional keep).
              { doneAt: record.doneAt, ...keepFlag(record.keep) };
        await importOne(threadId, imported);
      }
    } else {
      throw new Error(
        `legacy done store: unexpected shape ${JSON.stringify(legacy)}`,
      );
    }
    await bb.storage.kv.delete(LEGACY_DONE_KEY);
  }

  async function importOne(threadId: string, record: DoneRecord): Promise<void> {
    const existing = await readDoneRecord(threadId);
    if (existing !== null) {
      // Idempotent: never clobber live state; make sure the index knows.
      await addToDoneIndex(threadId);
      return;
    }
    await bb.sdk.threads.updatePluginMetadata({
      threadId,
      set: { [DONE_METADATA_KEY]: record },
    });
    await addToDoneIndex(threadId);
  }

  async function listDoneRecords(): Promise<{
    doneIds: string[];
    records: Record<string, { doneAt?: string; keep?: boolean }>;
  }> {
    await importLegacyDone();
    const live = await bb.sdk.threads.list({});
    const doneIds: string[] = [];
    const records: Record<string, { doneAt?: string; keep?: boolean }> = {};
    for (const thread of live) {
      const record = await readDoneRecord(thread.id);
      if (record !== null) {
        doneIds.push(thread.id);
        records[thread.id] = record;
      }
    }
    return { doneIds: doneIds.sort(), records };
  }

  async function readKept(): Promise<KeepStore> {
    const raw: unknown = await bb.storage.kv.get<unknown>(KEEP_KEY);
    const kept = keptFromRow(raw);
    if (kept === null) {
      if (raw !== null && raw !== undefined) {
        bb.log.warn(`Sweep keep store under "${KEEP_KEY}" failed validation; resetting to empty.`);
      }
      return {};
    }
    return kept;
  }

  async function writeKept(store: KeepStore): Promise<void> {
    // Persist the exact row shape readKept validates, so a written row
    // round-trips instead of failing validation and being wiped.
    await bb.storage.kv.set(KEEP_KEY, keepRowFromStore(store));
  }

  async function readRanks(): Promise<FractionRankStore> {
    return parseFractionRankStore(await bb.storage.kv.get<unknown>(RANK_KV_KEY));
  }

  async function writeRanks(store: FractionRankStore): Promise<void> {
    await bb.storage.kv.set(RANK_KV_KEY, fractionRowFromStore(store));
  }

  /**
   * Every whole-row KV store the plugin owns (rank orders, the done index,
   * the sweep keep flags, the groups registry) is a read-merge-write cycle
   * over one KV row, and the SDK's KV has no compare-and-swap: two writers
   * interleaving between one writer's read and its write let the later
   * write — computed from the ORIGINAL row — silently erase the first
   * writer's change (a pinned write came back undone under a gated
   * interleave — proven red by tests/rank-concurrent.test.ts before the
   * lock existed; tests/board-kv-concurrent.test.ts pins the same
   * guarantee for the other three rows). Every cycle therefore runs
   * serialized on this in-process queue: all writers are board RPCs and CLI
   * commands in this one server process. The queue never rejects, so one
   * failed write cannot wedge the writers behind it.
   */
  let kvWriteChain: Promise<unknown> = Promise.resolve();
  function withKvWriteLock<T>(task: () => Promise<T>): Promise<T> {
    const run = kvWriteChain.then(task, task);
    kvWriteChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // --- Snooze: read now, unread later (docs/plans/2026-10-02-snooze.md) ---
  //
  // The record rides per-thread plugin metadata (key "snooze"), the same
  // store the Done and pin-park records use. The WAKE is the server's own
  // job: a setTimeout per snoozed thread re-checked against the fresh
  // record at fire time, re-armed at plugin load so a daemon restart
  // catches misses, and cleared on dispose. The wake itself is mark-unread
  // through bb's own write — every open board sees the resulting
  // read-state-changed event and applies its existing unread state truth
  // (parked pin returns, Done un-does) without any snooze-specific code.

  async function readSnoozeRecord(
    threadId: string,
  ): Promise<SnoozeRecord | null> {
    // Same cast contract as readDoneRecord above: getPluginMetadata returns
    // an untyped namespace record; parseSnoozeRecord validates the shape.
    const namespace = await bb.sdk.threads.getPluginMetadata({ threadId });
    const value = (namespace as Record<string, JsonValue>)[SNOOZE_METADATA_KEY];
    return parseSnoozeRecord(value);
  }

  /** Node's setTimeout ceiling (~24.8 days in ms); longer wakes re-arm. */
  const MAX_WAKE_TIMEOUT_MS = 0x7fffffff;

  const wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Kill a thread's pending wake timer, if any (clear is the only killer). */
  function clearWakeTimer(threadId: string): void {
    const timer = wakeTimers.get(threadId);
    if (timer === undefined) return;
    clearTimeout(timer);
    wakeTimers.delete(threadId);
  }

  /**
   * The wake itself. Guards in order: the record must still exist (a
   * clear or a newer set owns this timer slot otherwise) and must still
   * carry THIS wake time (a re-snooze leaves the replaced timer stale
   * until its tick no-ops). A thread genuinely read since the snooze began
   * — "read" strictly later than the mark the set gesture itself caused —
   * consumes the snooze quietly: a reminder the operator already visited
   * must not re-alert them. A thread the SDK cannot resolve is treated the
   * same way (record drop, no unread mark).
   */
  async function fireWake(threadId: string, wakeAtMs: number): Promise<void> {
    // Self-catching end-to-end (audit 2026-10-05 finding 1): this runs on
    // setTimeout inside the bb server process, so any rejection here — a
    // record corrupted between read and wake, a failed metadata remove —
    // must land in the log, never as an unhandled rejection. The record
    // is left in place on failure: corrupt state stays fail-loud (the
    // board's snooze_list surfaces it), never coerced into silence.
    try {
      const record = await readSnoozeRecord(threadId);
      if (record === null) return; // cleared: nothing to wake
      const stamp = snoozeWakeAtMs(record);
      if (stamp === null || stamp !== wakeAtMs) return; // replaced; newer arm owns it
      let readSinceSet = false;
      let threadResolvable = true;
      try {
        const row = await bb.sdk.threads.get({ threadId });
        const lastReadAt = row.lastReadAt;
        readSinceSet = lastReadAt !== null && lastReadAt > Date.parse(record.setAt);
      } catch {
        threadResolvable = false;
      }
      if (!readSinceSet && threadResolvable) {
        try {
          await bb.sdk.threads.markUnread({ threadId });
        } catch (error) {
          // The unread write is the feature; failing it is logged, not
          // swallowed — but the snooze still consumed (no retry loop), so
          // the board at least stops dimming and the record cannot haunt
          // a later session.
          bb.log.warn(
            `snooze wake: markUnread failed for ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      await bb.sdk.threads.updatePluginMetadata({
        threadId,
        remove: [SNOOZE_METADATA_KEY],
      });
      bb.realtime.publish(SNOOZE_CHANGED, { threadId });
    } catch (error) {
      bb.log.warn(
        `snooze wake: failed for ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Arm (or replace) a thread's wake. A due-now wake fires with no timer
   * slot at all; a longer-than-ceiling wake sleeps full slots and re-arms
   * until the target is reachable. Every timer slot re-checks the fresh
   * record before acting, so a stale slot is always a no-op.
   */
  function armWakeAt(threadId: string, wakeAtMs: number): void {
    clearWakeTimer(threadId);
    const lag = wakeAtMs - Date.now();
    if (lag <= 0) {
      void fireWake(threadId, wakeAtMs);
      return;
    }
    const tick = (): void => {
      const remaining = wakeAtMs - Date.now();
      if (remaining > MAX_WAKE_TIMEOUT_MS) {
        // Longer than a slot can hold: sleep the slot and re-arm.
        wakeTimers.set(threadId, setTimeout(tick, MAX_WAKE_TIMEOUT_MS));
        return;
      }
      wakeTimers.delete(threadId);
      void fireWake(threadId, wakeAtMs);
    };
    wakeTimers.set(
      threadId,
      setTimeout(tick, Math.min(lag, MAX_WAKE_TIMEOUT_MS)),
    );
  }

  /**
   * Snooze a thread until wakeAt: mark read NOW (the card stops shouting),
   * stamp the record with setAt anchored at the read mark itself — the one
   * instant the wake's read-detection can compare against without racing
   * this gesture's own write — arm the wake, publish, return the record.
   * When the SDK cannot confirm the read mark, the wall clock remains the
   * anchor (it is strictly after the mark, so the wake comparison stays safe).
   */
  async function writeSnooze(
    threadId: string,
    wakeAt: Date,
  ): Promise<SnoozeRecord> {
    let anchor = new Date();
    try {
      await bb.sdk.threads.markRead({ threadId });
      const row = await bb.sdk.threads.get({ threadId });
      if (row.lastReadAt !== null) anchor = new Date(row.lastReadAt);
    } catch {
      // Best-effort anchoring; the record write below is the loud part.
    }
    const record = stampSnooze(anchor, wakeAt);
    await bb.sdk.threads.updatePluginMetadata({
      threadId,
      set: { [SNOOZE_METADATA_KEY]: record },
    });
    armWakeAt(threadId, wakeAt.getTime());
    bb.realtime.publish(SNOOZE_CHANGED, { threadId });
    return record;
  }

  /** Clear a snooze (idempotent): record gone, timer dead, signal out. */
  async function clearSnooze(threadId: string): Promise<boolean> {
    const existing = await readSnoozeRecord(threadId);
    if (existing === null) return false;
    await bb.sdk.threads.updatePluginMetadata({
      threadId,
      remove: [SNOOZE_METADATA_KEY],
    });
    clearWakeTimer(threadId);
    bb.realtime.publish(SNOOZE_CHANGED, { threadId });
    return true;
  }

  /**
   * The load-time wake scan: arm every snoozed live thread; past-due
   * records fire immediately ("arm" with lag ≤ 0 is a direct fire). Best-
   * effort with a log line, so one corrupted thread's record scan failure
   * cannot take the plugin down at load — the records themselves still
   * parse fail-loud per thread, and one corrupt row is skipped with a
   * warn (audit 2026-10-05 finding 2): it can never strand the wake set
   * behind it.
   */
  async function armAllSnoozes(): Promise<void> {
    const rows = await bb.sdk.threads.list({});
    for (const row of rows) {
      try {
        const record = await readSnoozeRecord(row.id);
        if (record === null) continue;
        const wakeAtMs = snoozeWakeAtMs(record);
        if (wakeAtMs === null) continue; // Unparseable stamps never wake.
        armWakeAt(row.id, wakeAtMs);
      } catch (error) {
        bb.log.warn(
          `snooze wake scan: skipping ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // ---- ✨ auto-rename's thread-model probe (useThreadModel path) ----
  // bb exposes no direct completion API for a thread's model; the route is
  // a hidden probe thread the plugin spawns on the same provider/model pair
  // (cloned with explicit provenance so bb actually honors it), reads the
  // reply off the timeline, and deletes. Helpers live here in `bb` scope.

  const PROBE_POLL_MS = 1000;
  // 120s: an acp-opencode provider turn can cold-start past 45s (observed
  // live — the earlier cap turned healthy probes into timeouts).
  const PROBE_TIMEOUT_MS = 120_000;

  const probeDelay = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  // ---- ✨ bridge classification (thread_autotitle_services) ----
  // Only plugins implementing a `complete` RPC method can serve the ✨ at
  // all (the openrouter-inference fork does; bb's builtin cloud and
  // provider-codex do not — ready-but-unbridged services 404 on pick, the
  // "errors on all providers" shape). The capability probe calls `complete`
  // with a deliberately invalid prompt: without the method bb answers 404;
  // with it, the target contract's own validation rejects the input — and a
  // non-string prompt can never reach a model, so the probe is free.
  const BRIDGE_TTL_MS = 60_000;
  const bridgeStatus = new Map<string, { at: number; ok: boolean; reason: string | null }>();

  async function probeCompleteBridge(
    pluginId: string,
  ): Promise<{ ok: boolean; reason: string | null }> {
    try {
      await bb.sdk.plugins.callRpc({
        pluginId,
        method: "complete",
        input: { prompt: 1 } as never,
        outputSchema: z.object({ text: z.string() }).passthrough(),
        signal: AbortSignal.timeout(5_000),
      });
      return { ok: true, reason: null };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // This exact shape is what bb answers for a method the plugin lacks;
      // anything else is the target contract refusing the bad prompt —
      // proof the method exists.
      if (/no rpc method|\b404\b|not found/i.test(message)) {
        return {
          ok: false,
          reason: `${pluginId} does not expose the complete bridge focus-board calls (only plugins implementing one can serve the ✨)`,
        };
      }
      return { ok: true, reason: null };
    }
  }

  async function serviceBridgeState(
    pluginId: string,
  ): Promise<{ ok: boolean; reason: string | null }> {
    const cached = bridgeStatus.get(pluginId);
    if (cached !== undefined && Date.now() - cached.at < BRIDGE_TTL_MS) {
      return cached;
    }
    const fresh = await probeCompleteBridge(pluginId);
    bridgeStatus.set(pluginId, { at: Date.now(), ...fresh });
    return fresh;
  }

  /**
   * How a title probe spawns, in a 2-tier fallback chain — bb's
   * defaultExecutionOptions can return null live (its route fails
   * capability validation on empty input) even for threads that run fine,
   * so the chain keeps the probe meaningful:
   * 1. a resolved provider/model pair → clone both explicitly;
   * 2. nothing → a plain hidden child inherits bb's own spawn default
   *    chain (project remembered default → global), exactly what a new
   *    thread in the project gets.
   *
   * The old middle tier cloned the providerId alone, letting bb resolve
   * the model against the provider's catalog default — which here is an
   * openrouter model, the metered fall-through the metered gate had to
   * reject live (409 on a vikunja-pwa-fork title probe). Inheriting rides
   * the same core-resolved chain any new thread gets, so the probe never
   * lands on a catalog default the project's remembered default would
   * have avoided.
   */
  type ProbeSpawnPlan =
    | { spawnable: true; kind: "pair"; providerId: string; model: string }
    | { spawnable: true; kind: "inherit" }
    | { spawnable: false; reason: string };

  /**
   * The source thread row the plan carries back with it: `projectId` gates
   * the inherit tier, and `environmentId` rides along because both callers
   * need it for the spawn (the probe reuses the source thread's
   * environment) — so the callers never re-fetch the row themselves.
   */
  type ProbeSourceRow = {
    projectId?: unknown;
    environmentId?: unknown;
  };

  async function probeSpawnPlan(
    threadId: string,
  ): Promise<{ plan: ProbeSpawnPlan; source: ProbeSourceRow }> {
    const execution = (await bb.sdk.threads.defaultExecutionOptions({
      threadId,
    })) as unknown as { providerId?: unknown; model?: unknown } | null;
    // The single source-row fetch per probe invocation: every tier returns
    // it alongside the plan so callers validate/spawn from this one read.
    const source = (await bb.sdk.threads.get({ threadId })) as unknown as ProbeSourceRow;
    if (
      execution !== null &&
      typeof execution.providerId === "string" &&
      typeof execution.model === "string"
    ) {
      return {
        plan: {
          spawnable: true,
          kind: "pair",
          providerId: execution.providerId,
          model: execution.model,
        },
        source,
      };
    }
    if (typeof source?.projectId === "string") {
      return { plan: { spawnable: true, kind: "inherit" }, source };
    }
    return {
      plan: {
        spawnable: false,
        reason:
          "This thread has no resolved provider/model and no project to inherit a default model from",
      },
      source,
    };
  }

  /**
   * The thread's ORIGINATING prompt, the input the title should summarize.
   * Two live-found reasons make prompt history the FALLBACK, not the
   * source: bb's history carries composer turns only (spawn inputs never
   * land there) and pages newest-first. The source thread's timeline's
   * oldest user conversation row is the honest first read — but bb serves
   * the timeline in segment windows (the newest first), so the read walks
   * the older cursors and only trusts the result when the walk reached the
   * thread's beginning; a capped walk that never reaches the bottom uses
   * the paged history instead (a mid-thread row would mislabel the task).
   */
  const ORIGINATING_PROMPT_MAX_PAGES = 40;
  async function threadOriginatingPrompt(threadId: string): Promise<string | null> {
    const collected: AutotitleTimelineRow[] = [];
    let cursor: { anchorId: string; anchorSeq: number } | null = null;
    let reachedBeginning = false;
    for (let page = 0; page < ORIGINATING_PROMPT_MAX_PAGES; page += 1) {
      const timeline = (await bb.sdk.threads.timeline({
        threadId,
        // bb's sequence-anchored first read: afterSequence "0" = events
        // strictly above 0 (the bound is a string, like limit). The
        // parameterless call serves bb's latest-rows cache — live it
        // returned only seq 9066-10188 of a 10k-sequence thread, putting
        // the user's newest message in "first".
        afterSequence: "0",
        ...(cursor === null
          ? {}
          : { beforeAnchorId: cursor.anchorId, beforeAnchorSeq: String(cursor.anchorSeq) }),
      })) as {
        rows?: unknown;
        timelinePage?: {
          hasOlderRows?: boolean;
          olderCursor?: { anchorId: string; anchorSeq: number } | null;
        } | null;
      };
      collected.push(...((timeline.rows ?? []) as AutotitleTimelineRow[]));
      const page1 = timeline.timelinePage;
      if (page1 === undefined || page1 === null) {
        reachedBeginning = true; // no pager info: treat the page as complete
        break;
      }
      if (page1.hasOlderRows === true && page1.olderCursor != null) {
        cursor = page1.olderCursor;
        continue;
      }
      reachedBeginning = true;
      break;
    }
    const fromTimeline = reachedBeginning
      ? firstUserPromptFromTimeline(collected)
      : null;
    if (fromTimeline !== null) return fromTimeline;
    // The pasted-opener tier: a thread that opens with a composer paste
    // carries a user row with EMPTY text whose content lives in the stored
    // attachment the row's attachments.localFilePaths names (found live on
    // thr_eid3vv6gzt — every ✨ option failed "has no prompt text" before
    // any service or probe was called). The file is read out of bb's own
    // attachments store, resolved with bb.server.experimental_dataDir (a
    // plugin that guesses ~/.bb would read the wrong server's files), and
    // every refusal names the file or path it is about.
    const storedPath = firstUserPromptFileFromTimeline(collected);
    if (storedPath !== null) {
      const source = (await bb.sdk.threads.get({ threadId })) as unknown as {
        projectId?: unknown;
      };
      const projectId =
        typeof source?.projectId === "string" ? source.projectId : null;
      if (projectId === null) {
        throw new Error(
          `thread_autotitle: thread ${threadId} opens with the stored paste ${storedPath}, but the thread has no project to read its attachments from`,
        );
      }
      const target = attachmentPromptTarget(
        bb.server.experimental_dataDir,
        projectId,
        storedPath,
      );
      if (target === null) {
        throw new Error(
          `thread_autotitle: thread ${threadId} opens with the stored paste ${storedPath}, which escapes the project's attachments store`,
        );
      }
      const read = await readAttachmentPromptText(target);
      if (!read.ok) {
        throw new Error(
          `thread_autotitle: thread ${threadId} opens with the stored paste ${storedPath}, which could not be read as prompt text: ${read.reason}`,
        );
      }
      return read.text;
    }
    const history = (await bb.sdk.threads.promptHistory({
      threadId,
      // bb pages prompt history newest-first and types limit as a string;
      // the default page drops the thread's originating prompt on long
      // threads, so ask big and sort oldest-first locally
      // (promptTextFromHistory does).
      limit: "200",
    })) as unknown as readonly AutotitleHistoryEntry[];
    return promptTextFromHistory(history);
  }

  /** Can this thread's own model generate a title? Used by the fallback modal's menu. */
  async function threadModelAvailability(
    threadId: string,
  ): Promise<{ available: boolean; reason: string | null }> {
    try {
      const { plan, source } = await probeSpawnPlan(threadId);
      if (!plan.spawnable) return { available: false, reason: plan.reason };
      if (typeof source?.projectId !== "string") {
        return {
          available: false,
          reason: "This thread has no project to spawn a title probe into",
        };
      }
      if (typeof source?.environmentId !== "string") {
        return {
          available: false,
          reason: "This thread has no environment to spawn a title probe into",
        };
      }
      return { available: true, reason: null };
    } catch (error: unknown) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Generate a title with the source thread's own provider/model: spawn a
   * hidden probe thread in the same project/environment, wait for it to
   * settle, read the last assistant line off its timeline, clean it into a
   * title. The probe is always deleted — best-effort, a delete failure is
   * only logged so it can never fail the rename itself.
   */
  async function probeThreadModelTitle(threadId: string): Promise<string> {
    const { plan, source } = await probeSpawnPlan(threadId);
    if (!plan.spawnable) {
      throw new Error(`thread_autotitle: ${plan.reason}`);
    }
    if (typeof source?.projectId !== "string") {
      throw new Error(
        `thread_autotitle: thread ${threadId} has no project to spawn a title probe into`,
      );
    }
    if (typeof source?.environmentId !== "string") {
      throw new Error(
        `thread_autotitle: thread ${threadId} has no environment to spawn a title probe into`,
      );
    }
    const threadPrompt = await threadOriginatingPrompt(threadId);
    if (threadPrompt === null) {
      throw new Error(
        `thread_autotitle: thread ${threadId} has no prompt text to title from`,
      );
    }
    // Per-tier spawn args: the pair clones both fields explicitly, the
    // inherit tier passes nothing and rides bb's own spawn default chain.
    const executionArgs: Record<string, unknown> =
      plan.kind === "pair"
        ? {
            providerId: plan.providerId,
            model: plan.model,
            executionInputSources: { providerId: "explicit", model: "explicit" },
          }
        : {};
    const execution =
      plan.kind === "pair"
        ? { providerId: plan.providerId, model: plan.model }
        : { providerId: "bb default chain", model: "bb default chain" };
    // Security residual (audit 2026-10-05, finding 3): bb's spawn contract
    // has no tools-disabled or readonly option — CreateThreadRequest's
    // permissionMode union is accept-edits|auto|full|workspace-write — so
    // the "No tools" guardrail below is promptual only. The probe's payload
    // is untrusted thread content, and an instruction-ignoring model could
    // act with the environment's ordinary tool access. Accepted for 1.0:
    // the probe is hidden, deleted on every path, and capped at one turn.
    const probe = (await bb.sdk.threads.spawn({
      projectId: source.projectId,
      environment: {
        type: "reuse" as const,
        environmentId: source.environmentId,
      },
      ...executionArgs,
      visibility: "hidden",
      title: "✨ title probe (auto-deleted)",
      prompt: buildAutotitleProbePrompt(threadPrompt),
    })) as unknown as { id?: unknown };
    if (typeof probe?.id !== "string") {
      throw new Error(
        "thread_autotitle: failed to spawn the title probe thread",
      );
    }
    const probeId = probe.id;
    // A failing probe turn may still be mid-run; stopping first keeps the
    // delete from racing bb's own teardown.
    const stopProbe = async () => {
      try {
        await bb.sdk.threads.stop({ threadId: probeId });
      } catch (error: unknown) {
        bb.log.warn(
          `title probe stop failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    const deleteProbe = async () => {
      try {
        await bb.sdk.threads.delete({
          threadId: probeId,
          childThreadsConfirmed: true,
        });
      } catch (error: unknown) {
        bb.log.warn(
          `title probe delete failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    try {
      for (;;) {
        const row = (await bb.sdk.threads.get({
          threadId: probeId,
        })) as unknown as { status?: unknown };
        if (probeSettled(String(row?.status))) {
          if (row?.status !== "idle") {
            throw new Error(
              `thread_autotitle: the title probe turn failed on ${execution.providerId}/${execution.model}`,
            );
          }
          break;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `thread_autotitle: the title probe turn did not finish within ${PROBE_TIMEOUT_MS / 1000}s on ${execution.providerId}/${execution.model}`,
          );
        }
        await probeDelay(PROBE_POLL_MS);
      }
      const timeline = (await bb.sdk.threads.timeline({
        threadId: probeId,
      })) as unknown as { rows?: readonly AutotitleTimelineRow[] };
      const reply = assistantTextFromTimeline(timeline.rows ?? []);
      if (reply === null) {
        throw new Error(
          `thread_autotitle: the title probe wrote no assistant reply on ${execution.providerId}/${execution.model}`,
        );
      }
      const title = cleanGeneratedTitle(reply);
      if (title === null) {
        throw new Error(
          `thread_autotitle: the title probe reply had no usable title on ${execution.providerId}/${execution.model}`,
        );
      }
      return title;
    } catch (error: unknown) {
      // A failing turn may still be mid-run: stop it so the delete below
      // (finally) does not race bb's own teardown.
      await stopProbe();
      throw error;
    } finally {
      await deleteProbe();
    }
  }

  /**
   * The ✨ diagnostic menu the fallback modal serves (thread_autotitle_services)
   * and the autotitle CLI prints: the selection, every registered
   * thread-title service bridge-classified, and the thread's probe
   * availability. One builder so the modal and the CLI cannot drift.
   */
  async function autotitleServicesMenu(threadId: string) {
    const state = (await bb.sdk.system.aiServices()) as Parameters<
      typeof resolveTitleTarget
    >[0];
    const selected = resolveTitleSelection(state);
    const threadModel = await threadModelAvailability(threadId);
    return {
      selected: selected.ok
        ? { pluginId: selected.pluginId, serviceId: selected.serviceId }
        : null,
      services: await Promise.all(
        autotitleTargets(state).map(async (target) => {
          if (!target.ready) {
            // A not-ready service is already blocked by its own message;
            // no need to spend a probe on it.
            return { ...target, bridge: false, bridgeReason: null };
          }
          const bridge = await serviceBridgeState(target.pluginId);
          return { ...target, bridge: bridge.ok, bridgeReason: bridge.reason };
        }),
      ),
      threadModel,
    };
  }

  // The working dot's rate sampler (issue #279). Nothing here runs until a
  // board asks for rates: the subscription is created on the first
  // `pulse_rates` call, and the sampler itself reads no thread's context until
  // the demand lease is open (lib/thread-pulse). A plugin whose board nobody
  // has open costs one registered function and no events.
  const pulse = createThreadPulseTracker({
    readUsedTokens: async (threadId) => {
      const context = await bb.sdk.threads.context({ threadId });
      return context.usage?.usedTokens ?? null;
    },
    onSampleError: (threadId, error) => {
      bb.log.warn(
        `pulse sample failed for ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
  let pulseSubscribed = false;
  const ensurePulseSubscribed = (): void => {
    if (pulseSubscribed) return;
    pulseSubscribed = true;
    // A thread-changed event carries the event types it was raised for; only
    // the two token-usage types can have moved the used-token count, and
    // `noteEvent` drops everything else on the first comparison.
    const unsubscribe = bb.sdk.subscribe({
      event: "thread:changed",
      callback: (event) => {
        if (event.id === undefined) return;
        void pulse.noteEvent(event.id, event.metadata?.eventTypes);
      },
    });
    bb.onDispose(unsubscribe);
  };

  bb.rpc.register(rpcContract, {
    pulse_rates: async () => {
      // The call IS the sampler's demand signal (issue #279): it opens the
      // lease that lets the sampler read a thread's context at all, so a board
      // nobody is looking at costs no reads.
      ensurePulseSubscribed();
      pulse.beginDemand();
      return { rates: pulse.rates(), generatedAt: Date.now() };
    },
    done_list: async () => {
      const [{ doneIds, records }, kept] = await Promise.all([
        listDoneRecords(),
        readKept(),
      ]);
      // Keep flags for threads never marked Done still ride to the client —
      // the idle arm honors them (the sweep's per-arm kept() lookups read
      // this one merged map).
      for (const id of Object.keys(kept)) {
        if (records[id] === undefined) records[id] = { keep: true };
        else records[id] = { ...records[id], keep: true };
      }
      return { doneIds, records };
    },
    done_set: async ({ threadId, done }) => {
      // Consume any legacy KV state before the first metadata write, or a
      // later import could resurrect state this write just changed.
      await importLegacyDone();
      await writeDoneRecord(threadId, done);
      bb.realtime.publish(DONE_CHANGED, { threadId, done });
      return { done };
    },
    link_list: async () => {
      // The live list only, like pin_parks_list: a link on an archived
      // thread has no chip to drive (the card is not on the board).
      const rows = await bb.sdk.threads.list({});
      const links: Record<string, ThreadLink[]> = {};
      for (const row of rows) {
        const record = await readLinkedIssues(row.id);
        if (record !== null && record.length > 0) links[row.id] = record;
      }
      return { links };
    },
    link_set: async ({ threadId, repo, number, kind, url, label, source }) => {
      const now = new Date();
      const ghItem = url === undefined ? null : parseGithubItemUrl(url);
      let link: ThreadLink;
      if (url !== undefined && ghItem === null) {
        // Non-GitHub https URL → external tracker item; the hostname derives
        // from the URL (never from caller input).
        link = makeExternalLink(url, label, source, now);
      } else {
        // GitHub item: URL form parsed above, number form resolved against
        // the thread's project remote (or the explicit repo).
        const resolved =
          ghItem !== null
            ? ghItem
            : {
                repo: await resolveLinkRepo(threadId, repo),
                issue: number!,
                kind: kind ?? "issue",
              };
        link = {
          tracker: "github",
          repo: resolved.repo,
          issue: resolved.issue,
          kind: resolved.kind,
          href: linkHref(resolved.repo, resolved.kind, resolved.issue),
          createdAt: now.toISOString(),
          source,
        };
      }
      await writeLinkedIssues(threadId, stampLinkedIssues(await readLinkedIssues(threadId), link));
      await publishLinksChanged([threadId]);
      return { threadId, link };
    },
    link_clear: async ({ threadId, number }) => {
      const existing = await readLinkedIssues(threadId);
      await writeLinkedIssues(threadId, clearLinkedIssues(existing, number));
      await publishLinksChanged([threadId]);
      return { threadId, cleared: true };
    },
    pin_parks_list: async () => {
      // The live list only: a park on an archived thread has no consumer —
      // un-archiving returns the thread through done state, not a pin — and
      // the SDK scan the done CLI lacks is not needed here.
      const rows = await bb.sdk.threads.list({});
      const parks: Record<string, PinParkRecord> = {};
      for (const row of rows) {
        const record = await readPinParkRecord(row.id);
        if (record !== null) parks[row.id] = record;
      }
      return { parks };
    },
    pin_park_set: async ({ threadId, parked }) => {
      await writePinPark(threadId, parked);
      return { threadId, parked };
    },
    error_acks_list: async () => {
      // The live list only, like pin_parks_list: an ack on an archived
      // thread has no card to drive (the card is not on the board). The
      // record stays dormant in metadata and re-arms if the thread returns
      // still errored; the client's stale sweep drops it after any turn
      // that leaves the error status, so a later error is never masked.
      const rows = await bb.sdk.threads.list({});
      const records: Record<string, ErrorAckRecord> = {};
      for (const row of rows) {
        const record = await readErrorAckRecord(row.id);
        if (record !== null) records[row.id] = record;
      }
      return { ackIds: Object.keys(records).sort(), records };
    },
    error_ack_set: async ({ threadId, acked }) => {
      await writeErrorAck(threadId, acked);
      bb.realtime.publish(ERROR_ACK_CHANGED, { threadId, acked });
      return { threadId, acked };
    },
    snooze_list: async () => {
      // The live list only, like pin_parks_list: a snooze record on an
      // archived thread has no board consumer (snoozed cards never leave
      // their column), and the wake scan below reads the same list.
      const rows = await bb.sdk.threads.list({});
      const snoozes: Record<string, SnoozeRecord> = {};
      for (const row of rows) {
        const record = await readSnoozeRecord(row.id);
        if (record !== null) snoozes[row.id] = record;
      }
      return { snoozes };
    },
    snooze_set: async ({ threadId, wakeAt }) => {
      const wakeMs = Date.parse(wakeAt);
      if (wakeMs <= Date.now()) {
        throw new PluginCliError(
          `wake time must be in the future, got ${wakeAt}`,
          {
            code: "invalid_value",
            hint: "Give an epoch-parseable timestamp strictly later than now.",
          },
        );
      }
      const record = await writeSnooze(threadId, new Date(wakeMs));
      return { threadId, wakeAt: record.wakeAt };
    },
    snooze_clear: async ({ threadId }) => {
      const cleared = await clearSnooze(threadId);
      return { threadId, cleared };
    },
    thread_autotitle: async ({ threadId, pluginId, serviceId, useThreadModel }) => {
      if (
        useThreadModel === true &&
        (pluginId !== undefined || serviceId !== undefined)
      ) {
        throw new Error(
          "thread_autotitle: useThreadModel and a pluginId/serviceId override are mutually exclusive",
        );
      }
      if (useThreadModel === true) {
        return { title: await probeThreadModelTitle(threadId) };
      }
      const servicesState = (await bb.sdk.system.aiServices()) as Parameters<
        typeof resolveTitleTarget
      >[0];
      const resolved = resolveTitleTarget(
        servicesState,
        pluginId === undefined && serviceId === undefined
          ? undefined
          : { pluginId, serviceId },
      );
      // Selection reason (not set to a plugin service) or override refusal
      // (unregistered, wrong task, not ready) both fail loud with the fix.
      if (!resolved.ok) throw new Error(resolved.reason);
      const selection = resolved;
      const threadPrompt = await threadOriginatingPrompt(threadId);
      if (threadPrompt === null) {
        throw new Error(
          `thread_autotitle: thread ${threadId} has no prompt text to title from`,
        );
      }
      // Any plugin service bb routes titles to must answer the same shape;
      // this is the bridge method the openrouter-inference fork serves.
      const reply = (await bb.sdk.plugins.callRpc({
        pluginId: selection.pluginId,
        method: "complete",
        input: { prompt: buildAutotitlePrompt(threadPrompt) },
        outputSchema: z.object({ text: z.string() }).passthrough(),
        // Above the provider plugin's own 30s completion budget: a slow,
        // healthy completion must abort in the provider, not in this bridge.
        signal: AbortSignal.timeout(35_000),
      })) as { text?: unknown };
      if (typeof reply?.text !== "string") {
        throw new Error(
          `thread_autotitle: AI service ${selection.pluginId} returned no text reply`,
        );
      }
      const title = cleanGeneratedTitle(reply.text);
      if (title === null) {
        throw new Error(
          `thread_autotitle: AI service ${selection.pluginId} returned no usable title`,
        );
      }
      return { title };
    },
    thread_autotitle_services: async ({ threadId }) => autotitleServicesMenu(threadId),
    tracker_status: async ({ repo, numbers }) => {
      const home = process.env.HOME ?? "";
      if (home === "") return { statuses: {} };
      const cached = readGitHubStatuses(`${home}/${GITHUB_CACHE_DB}`, repo, numbers, bb.log);
      // The freshness layer (issue #187, issue #236): paint only trustworthy
      // verdicts. A stale OPEN row is simply absent — the chip renders
      // unsure-plain — and nothing behind this reply re-checks it, so the
      // handler stays a pure read over bb's own cache.
      const decisions = trackerFreshness.decide(numbers, cached);
      return {
        statuses: Object.fromEntries(
          Object.entries(decisions.statuses).map(([number, status]) => [
            number,
            { kind: status.kind, state: status.state },
          ]),
        ),
      };
    },
    tracker_validate: async ({ urls }) => {
      const home = process.env.HOME ?? "";
      const results = await validateTrackerUrls(urls, {
        // Same shape as every other fetchImpl pass-through here (the daemon
        // client at requireLocalDaemon, openWorkspaceInTarget): the direct
        // `fetch` reference, not a re-invoked wrapper.
        fetchImpl: fetch,
        // No HOME (or no cache file): the lookup degrades to {} and the URL
        // falls through to the HTTP check, exactly the tracker_status rule.
        githubCacheStatuses:
          home === ""
            ? () => ({})
            : (repo, numbers) =>
                readGitHubStatuses(`${home}/${GITHUB_CACHE_DB}`, repo, numbers, bb.log),
        kvGet: async (key) => {
          // Cached outcome read; garbage in the KV slot reads as absent (the
          // cache is an optimization, never a correctness source here).
          const raw = (await bb.storage.kv.get(key)) as unknown;
          if (
            typeof raw !== "object" ||
            raw === null ||
            typeof (raw as { ok?: unknown }).ok !== "boolean" ||
            typeof (raw as { at?: unknown }).at !== "number"
          ) {
            return undefined;
          }
          return raw as { ok: boolean; at: number };
        },
        kvSet: async (key, value) => {
          await bb.storage.kv.set(key, value);
        },
        now: () => Date.now(),
      });
      return { results };
    },
    workspace_files_exist: async ({ threadId, paths }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      const environmentId = "environmentId" in thread ? thread.environmentId : null;
      if (environmentId === null) return { existence: {} };
      const environment = await bb.sdk.environments.get({ environmentId });
      const root = environment.path;
      // A workspaceless environment has no files to verify against.
      if (root === null) return { existence: {} };
      // Dedupe first, then re-validate the untrusted relative paths; the
      // ones that escape the workspace (absolute, `~`, `..` escapes) are
      // reported missing instead of stat-ed on the host.
      const unique = [...new Set(paths)];
      const relative: string[] = [];
      const absolute: string[] = [];
      for (const path of unique) {
        const resolved = resolveWithinRoot(root, path);
        if (resolved === null) continue;
        relative.push(path);
        absolute.push(resolved);
      }
      if (absolute.length === 0) return { existence: {} };
      // The check runs on the environment's own host, so workspaces on
      // other machines verify correctly too.
      const result = await bb.sdk.hosts.pathsExist({
        hostId: environment.hostId,
        paths: absolute,
      });
      const out: Record<string, boolean> = {};
      for (const [index, path] of relative.entries()) {
        const verdict = result.existence[absolute[index]];
        if (typeof verdict === "boolean") out[path] = verdict;
      }
      return { existence: out };
    },
    workspace_open_targets: async ({ threadId }) => {
      const state = await resolveThreadWorkspaceOpen(threadId);
      return state;
    },
    workspace_open_in_target: async ({ threadId, targetId }) => {
      const state = await resolveThreadWorkspaceOpen(threadId);
      if (
        state.status !== "available" ||
        state.root === null ||
        !state.targets.some((target) => target.id === targetId)
      ) {
        return {
          ok: false,
          message: state.reason ?? "This workspace cannot be opened here.",
        };
      }
      try {
        const daemon = await requireLocalDaemon();
        if (daemon === null) {
          return { ok: false, message: "Local host daemon is unavailable." };
        }
        await openWorkspaceInTarget(daemon.port, state.root, targetId, {
          fetchImpl: fetch,
          timeoutMs: 10_000,
        });
        return { ok: true, message: null };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    sweep_config_get: async () => {
      const values = await settings.get();
      return {
        doneArchiveMs: archiveThresholdMs(
          values.doneArchiveValue,
          ARCHIVE_UNIT_SCHEMA.parse(values.doneArchiveUnit),
        ),
        idleArchiveMs: archiveThresholdMs(
          values.idleArchiveValue,
          ARCHIVE_UNIT_SCHEMA.parse(values.idleArchiveUnit),
        ),
      };
    },
    sweep_keep_set: async ({ threadId, keep }) => {
      // The keep flag applies to BOTH sweep arms (Done and long-idle), so it
      // is stored independently of Done marks: a long-idle thread that was
      // never marked Done can be protected too. The whole-row read-merge
      // write runs under the KV write lock: a concurrent keep on another
      // thread must not be erased by this write's stale snapshot.
      let changed = false;
      await withKvWriteLock(async () => {
        const kept = await readKept();
        if (keep) {
          if (kept[threadId] === true) return;
          await writeKept({ ...kept, [threadId]: true });
        } else {
          if (kept[threadId] !== true) return;
          const { [threadId]: _removed, ...rest } = kept;
          await writeKept(rest);
        }
        changed = true;
      });
      // An idempotent toggle writes nothing and signals nothing, like before.
      if (!changed) return { threadId, keep };
      // Keep changes feed the same refetch signal the board already
      // subscribes to; payload consumers refetch, so done:false is a dummy.
      bb.realtime.publish(DONE_CHANGED, { threadId, done: false });
      return { threadId, keep };
    },
    rank_list: async () => {
      // The wire projection: clients read ordered id lists, never fractions
      // (lib/rank-fractions.ts). A legacy list row converts here in the read
      // view — the stored row itself converts when a rank write lands.
      const store = await readRanks();
      return { orders: ordersFromFractionStore(store) };
    },
    thread_reparent: async ({ threadId, parentThreadId }) => {
      // Validate against fresh rows, not the board's map — a family some
      // other surface moved between the dragover and the drop must not get
      // a second write on top. (list({}) returns live rows; an archived id
      // reads as a missing one, which refuses too.)
      const rows = await bb.sdk.threads.list({});
      // list({}) returns live rows; archivedAt is the row's archive stamp.
      const live = rows.map((row) => ({
        id: row.id,
        parentThreadId: row.parentThreadId,
        isArchived: (row as { archivedAt?: number | null }).archivedAt != null,
      }));
      const refusal = reparentRefusal(live, threadId, parentThreadId);
      if (refusal !== null) throw new PluginCliError(refusal);
      await bb.sdk.threads.update({ threadId, parentThreadId });
      return { threadId, parentThreadId };
    },
    rank_move: ({ columnKey, threadId, beforeId, toEnd, visibleIds, unitIds }) =>
      withKvWriteLock(async () => {
        const store = await readRanks();
        // The unit membership check fires here first so the RPC can carry
        // its PluginCliError code; the shared move op re-checks and throws
        // a plain Error as a backstop.
        if (unitIds !== undefined && unitIds.length > 0 && !unitIds.includes(threadId)) {
          throw new PluginCliError(
            `rank_move: dragged id ${threadId} is not part of the unit (${unitIds.join(", ")})`,
            { code: "invalid_value" },
          );
        }
        // Anchor-fresh (lib/rank-fractions.ts): a ranked card the gesture
        // did not aim at keeps its stored fraction, so the only change
        // expressible is the moved card's fragment plus the densify mints.
        // Skip the write (and the refetch) when the derived ranked order is
        // unchanged — a re-drop that lands where the card already sits, or
        // a stale drop the fresh state already satisfies, is a no-op.
        const result = applyRankMoveFractions(store, {
          columnKey,
          threadId,
          beforeId,
          toEnd,
          visibleIds,
          unitIds,
        });
        if (!result.unchanged) {
          await writeRanks(result.next);
          bb.realtime.publish(RANK_CHANGED, { columnKey });
        }
        return { columnKey, order: result.order };
      }),
    groups_list: async () => {
      // Live rows only, like the other list scans: an archived member has
      // no card to box, and unarchive brings the assignment back with it.
      const [store, rows] = await Promise.all([
        readGroupsStore(),
        bb.sdk.threads.list({}),
      ]);
      const memberships: Record<string, string> = {};
      for (const row of rows) {
        const record = await readGroupAssignment(row.id);
        // A record pointing at a group the registry lost (a manual KV edit)
        // is orphaned data — skip it rather than box with a nameless label
        // (planGroupBoxes ignores unknown ids on the client too).
        if (record !== null && store[record.groupId] !== undefined) {
          memberships[row.id] = record.groupId;
        }
      }
      return { groups: groupsRowFromStore(store), memberships };
    },
    group_create: async ({ name }) => {
      const { id, record } = await createGroupNamed(name);
      return { group: { id, ...record } };
    },
    group_rename: async ({ groupId, name }) => {
      const record = await renameGroupById(groupId, name);
      return { group: { id: groupId, ...record } };
    },
    group_set: async ({ threadId, groupId }) => {
      await setThreadGroup(threadId, groupId);
      return { threadId, groupId };
    },
    group_delete: async ({ groupId }) => {
      await deleteGroup(groupId);
      return { groupId };
    },
    family_state_list: async () => {
      // The read the board hydrates from on mount and on every signal: one
      // row, no thread scan.
      const store = await readFamilyState();
      return familyStateRowFromStore(store);
    },
    family_state_set: async ({ key, id, on }) =>
      // The whole read-merge-write runs under the KV write lock: two windows
      // folding different families at once both survive instead of the later
      // write erasing the first from a stale snapshot.
      withKvWriteLock(async () => {
        const store = await readFamilyState();
        const next = toggleFamilyStateId(store, key, id, on);
        // A no-op toggle (the id already in the requested state) writes
        // nothing and signals nothing, like every other idempotent write.
        if (next === store) return { key, id, on };
        await writeFamilyState(next);
        bb.realtime.publish(FAMILY_STATE_CHANGED, { key, id, on });
        return { key, id, on };
      }),
    family_state_merge: async (incoming) =>
      // The one-time localStorage migration: union, never replace, so a
      // migration cannot erase a fold a newer window wrote.
      withKvWriteLock(async () => {
        const store = await readFamilyState();
        const next = mergeFamilyStateIds(store, incoming);
        if (sameFamilyState(store, next)) return familyStateRowFromStore(store);
        await writeFamilyState(next);
        bb.realtime.publish(FAMILY_STATE_CHANGED, { key: null, id: null, on: null });
        return familyStateRowFromStore(next);
      }),
  });

  // --- CLI: bb focus-board ---
  //
  // Manages plugin-owned state only (the standing rule from the CLI
  // musing): done list/mark/clear over the board's own metadata, and the
  // sweep over the board's own eligibility rules and settings. It never
  // re-spells `bb thread` commands, and it no longer carries config
  // commands: the declared settings already edit through
  // `bb plugin config focus-board` and the board settings modal's Behavior
  // tab, and a second threshold door was one more copy to keep true.

  /** The SDK's thread row shape, as returned by `threads.list`. */
  type ThreadRow = Awaited<ReturnType<typeof bb.sdk.threads.list>>[number];

  /**
   * Every thread the board can currently see: the live list plus the
   * archived list. Ids from the board's own done index whose threads are
   * gone from both (deleted) round out the candidate set so `done list`
   * still reports their surviving marks.
   */
  async function listCandidateThreads(): Promise<{
    rows: ThreadRow[];
    liveIds: Set<string>;
  }> {
    const [live, archivedRows] = await Promise.all([
      bb.sdk.threads.list({}),
      bb.sdk.threads.list({ archived: true, limit: 200 }),
    ]);
    const byId = new Map<string, ThreadRow>();
    for (const thread of [...live, ...archivedRows]) byId.set(thread.id, thread);
    const liveIds = new Set(live.map((thread) => thread.id));
    return { rows: [...byId.values()], liveIds };
  }

  /** Index ids whose Done marks the live/archived lists cannot show. */
  async function listIndexOnlyIds(): Promise<string[]> {
    const [candidates, indexIds] = await Promise.all([
      listCandidateThreads(),
      readDoneIndex(),
    ]);
    const known = new Set(candidates.rows.map((row) => row.id));
    return indexIds.filter((id) => !known.has(id));
  }

  const doneList = cliCommand({
    summary: "List threads marked Done in the board's own metadata",
    options: {
      json: { type: "boolean", description: "Emit machine-readable JSON" },
    },
    async run(_input) {
      await importLegacyDone();
      const { rows: candidates, liveIds } = await listCandidateThreads();
      const kept = await readKept();
      const seen = new Set<string>();
      const records: Array<{
        id: string;
        title: string | null;
        doneAt: string | null;
        keep: boolean;
        inLiveList: boolean;
        // True for an index id whose thread is gone (deleted since its
        // mark): the index named it, but there is no surviving record to
        // read, so it is reported rather than dropped or crashed on.
        stale: boolean;
      }> = [];
      // Live + archived threads first, then the board's index-only ids
      // (threads deleted since their mark): the index is the only way to
      // see those, because the SDK has no metadata scan.
      for (const thread of candidates) {
        seen.add(thread.id);
        const scanned = await scanDoneRecord(thread.id);
        if (scanned.state !== "record") continue;
        records.push({
          id: thread.id,
          title: thread.title ?? thread.titleFallback,
          doneAt: scanned.record.doneAt,
          keep: scanned.record.keep === true || kept[thread.id] === true,
          inLiveList: liveIds.has(thread.id),
          stale: false,
        });
      }
      for (const threadId of await listIndexOnlyIds()) {
        if (seen.has(threadId)) continue;
        seen.add(threadId);
        const scanned = await scanDoneRecord(threadId);
        if (scanned.state === "none") continue;
        // A gone id still prints: the index holds it, so the operator
        // learns the entry outlived its thread instead of losing the
        // listing to a 404.
        const record = scanned.state === "record" ? scanned.record : null;
        records.push({
          id: threadId,
          title: null,
          doneAt: record?.doneAt ?? null,
          keep: record?.keep === true || kept[threadId] === true,
          inLiveList: false,
          stale: record === null,
        });
      }
      const stdout = _input.options.json
        ? JSON.stringify(records, null, 2) + "\n"
        : records.length === 0
          ? "No threads are marked Done.\n"
          : records
              .map((row) => {
                const flags = [
                  row.keep ? "keep" : null,
                  row.inLiveList ? null : "not in the live thread list",
                  row.stale ? "thread deleted" : null,
                ]
                  .filter((flag) => flag !== null)
                  .join(", ");
                const suffix = flags.length > 0 ? ` (${flags})` : "";
                return `${row.id}\t${row.doneAt ?? "(unknown)"}\t${row.title ?? "(untitled)"}${suffix}`;
              })
              .join("\n") + "\n";
      return { exitCode: 0, stdout };
    },
  });

  const doneMark = cliCommand({
    summary: "Mark threads Done (stamps doneAt, idempotent)",
    positionals: [
      {
        name: "thread-id",
        description: "Thread id(s) to mark Done",
        required: true,
        variadic: true,
      },
    ],
    options: {
      json: { type: "boolean", description: "Emit machine-readable JSON" },
    },
    async run(input) {
      await importLegacyDone();
      const marked: string[] = [];
      for (const threadId of input.positionals["thread-id"]) {
        await writeDoneRecord(threadId, true);
        bb.realtime.publish(DONE_CHANGED, { threadId, done: true });
        marked.push(threadId);
      }
      const stdout = input.options.json
        ? JSON.stringify({ marked }, null, 2) + "\n"
        : marked.map((id) => `marked ${id}`).join("\n") + "\n";
      return { exitCode: 0, stdout };
    },
  });

  const doneClear = cliCommand({
    summary: "Clear the Done mark from threads (idempotent)",
    description:
      "Clearing the Done mark does not touch the sweep keep flag; a kept thread stays kept until 'Allow sweep' clears it.",
    positionals: [
      {
        name: "thread-id",
        description: "Thread id(s) to clear",
        required: true,
        variadic: true,
      },
    ],
    options: {
      json: { type: "boolean", description: "Emit machine-readable JSON" },
    },
    async run(input) {
      await importLegacyDone();
      const cleared: string[] = [];
      for (const threadId of input.positionals["thread-id"]) {
        await writeDoneRecord(threadId, false);
        bb.realtime.publish(DONE_CHANGED, { threadId, done: false });
        cleared.push(threadId);
      }
      const stdout = input.options.json
        ? JSON.stringify({ cleared }, null, 2) + "\n"
        : cleared.map((id) => `cleared ${id}`).join("\n") + "\n";
      return { exitCode: 0, stdout };
    },
  });

  // Board-linked GitHub items: list/set/clear over the linkedIssues
  // metadata key. The CLI is the operator's fallback when no agent tool is
  // in the session (issue #13's repro had no agent-side surface at all).
  const groupList = cliCommand({
    summary: "List feature groups (family boxes) with their assigned threads",
    options: {
      json: { type: "boolean", description: "Emit machine-readable JSON" },
    },
    async run(_input) {
      const [store, { rows: candidates, liveIds }] = await Promise.all([
        readGroupsStore(),
        listCandidateThreads(),
      ]);
      // Registry-defined groups first, then any orphaned assignment (a
      // thread whose metadata points at a group the registry lost — a
      // manual KV edit's survivor; the board renders none of these).
      const membersByGroup = new Map<string, ThreadRow[]>();
      const orphaned: Array<{ id: string; groupId: string; title: string | null }> = [];
      for (const thread of candidates) {
        const record = await readGroupAssignment(thread.id);
        if (record === null) continue;
        if (store[record.groupId] === undefined) {
          orphaned.push({
            id: thread.id,
            groupId: record.groupId,
            title: thread.title ?? thread.titleFallback,
          });
          continue;
        }
        const members = membersByGroup.get(record.groupId);
        if (members === undefined) membersByGroup.set(record.groupId, [thread]);
        else members.push(thread);
      }
      const rows = Object.entries(store).map(([id, record]) => ({
        id,
        name: record.name,
        createdAt: record.createdAt,
        members: (membersByGroup.get(id) ?? []).map((thread) => ({
          id: thread.id,
          title: thread.title ?? thread.titleFallback,
          inLiveList: liveIds.has(thread.id),
        })),
      }));
      const stdout = _input.options.json
        ? JSON.stringify({ groups: rows, orphaned }, null, 2) + "\n"
        : rows.length === 0
          ? "No feature groups exist.\n"
          : rows
              .map((row) => {
                const members = row.members
                  .map((member) => {
                    const suffix = member.inLiveList ? "" : " (archived)";
                    return `    ${member.id}\t${member.title ?? "(untitled)"}${suffix}`;
                  })
                  .join("\n");
                const note =
                  row.members.length < 2 ? "  — box withheld: fewer than two members" : "";
                return `${row.id}\t${row.name}\t${row.members.length} member(s)${note}\n${members}`;
              })
              .join("\n") +
          (orphaned.length > 0
            ? "\n\nOrphaned assignments (group record missing; never rendered):\n" +
              orphaned
                .map((row) => `  ${row.id}\t→ ${row.groupId}\t${row.title ?? "(untitled)"}`)
                .join("\n")
            : "") +
          "\n";
      return { exitCode: 0, stdout };
    },
  });

  // Issue #84: the group CLI grows beyond its read-only list. Every
  // command accepts a group id or its exact name, both of which fail loud
  // on anything they cannot resolve uniquely. Idempotency follows
  // `done mark`: re-running converges (create/add/remove/move report the
  // unchanged call instead of erroring) EXCEPT delete, which refuses an
  // unknown group so a typo cannot "delete" nothing and print success.
  const groupCreate = cliCommand({
    summary: "Create a feature group (idempotent: an existing exact name returns it)",
    positionals: [
      {
        name: "name",
        description: "New group name (1-80 non-blank characters)",
        required: true,
      },
    ],
    options: {
      json: { type: "boolean", description: "Emit machine-readable JSON" },
    },
    async run(input) {
      const { id, record, created } = await createGroupNamed(
        input.positionals["name"] as string,
      );
      const stdout = input.options.json
        ? JSON.stringify({ group: { id, ...record }, created }, null, 2) + "\n"
        : created
          ? `created ${id}\t${record.name}\n`
          : `already exists ${id}\t${record.name}\n`;
      return { exitCode: 0, stdout };
    },
  });

  const groupRename = cliCommand({
    summary: "Rename a feature group",
    description:
      "The first positional accepts the group id or its exact current name; the second is the new name (1-80 non-blank characters). Renames propagate through the registry, so every member shows the new name at once.",
    positionals: [
      {
        name: "group",
        description: "Group id or exact current name",
        required: true,
      },
      {
        name: "name",
        description: "New name",
        required: true,
      },
    ],
    options: {
      json: { type: "boolean", description: "Emit machine-readable JSON" },
    },
    async run(input) {
      const resolved = await resolveGroupRef(input.positionals["group"] as string);
      const record = await renameGroupById(
        resolved.id,
        input.positionals["name"] as string,
      );
      const stdout = input.options.json
        ? JSON.stringify({ group: { id: resolved.id, ...record } }, null, 2) + "\n"
        : `renamed ${resolved.id}\t${record.name}\n`;
      return { exitCode: 0, stdout };
    },
  });

  const groupDelete = cliCommand({
    summary: "Delete a feature group; every member's assignment clears with it",
    description:
      "Strips the group key from every member (live and archived) and removes the registry record. Refuses an unknown group so a typo cannot report a successful delete of nothing.",
    positionals: [
      {
        name: "group",
        description: "Group id or exact name",
        required: true,
      },
    ],
    options: {
      json: { type: "boolean", description: "Emit machine-readable JSON" },
    },
    async run(input) {
      const resolved = await resolveGroupRef(input.positionals["group"] as string);
      const { cleared } = await deleteGroup(resolved.id);
      const stdout = input.options.json
        ? JSON.stringify(
            { deleted: { id: resolved.id, name: resolved.name }, cleared },
            null,
            2,
          ) + "\n"
        : `deleted ${resolved.id}\t${resolved.name}${
            cleared.length > 0
              ? `\n  cleared ${cleared.length} member assignment(s)\n`
              : "\n"
          }`;
      return { exitCode: 0, stdout };
    },
  });

  const groupAdd = cliCommand({
    summary: "Assign threads to a feature group (idempotent; never moves between groups)",
    description:
      "A thread already in this group is left alone (reported as already). A thread already in a DIFFERENT group refuses the whole batch — use `group move` to change a thread's group. Group membership is per-thread: assigning never touches parent/child lineage, and a parent sits in a different group from its children without any cascade.",
    positionals: [
      {
        name: "group",
        description: "Group id or exact name",
        required: true,
      },
      {
        name: "thread-id",
        description: "Thread id(s) to assign",
        required: true,
        variadic: true,
      },
    ],
    options: {
      json: { type: "boolean", description: "Emit machine-readable JSON" },
    },
    async run(input) {
      const resolved = await resolveGroupRef(input.positionals["group"] as string);
      const threadIds = input.positionals["thread-id"] as string[];
      // Pre-pass before any write: a batch with a thread in another group
      // is refused whole (fail loud, no partial assignment).
      const store = await readGroupsStore();
      const conflicts: string[] = [];
      for (const threadId of threadIds) {
        const current = await readGroupAssignment(threadId);
        if (current === null || current.groupId === resolved.id) continue;
        const holder = store[current.groupId];
        conflicts.push(
          `${threadId} (in ${holder !== undefined ? JSON.stringify(holder.name) : "an unknown group"} ${current.groupId})`,
        );
      }
      if (conflicts.length > 0) {
        throw new PluginCliError(
          `${conflicts.length} thread(s) already sit in other groups: ${conflicts.join(", ")}`,
          {
            code: "invalid_value",
            hint: "Use `bb focus-board group move <thread...> --to <group>` to change a thread's group.",
          },
        );
      }
      const added: string[] = [];
      const already: string[] = [];
      for (const threadId of threadIds) {
        if ((await readGroupAssignment(threadId))?.groupId === resolved.id) {
          already.push(threadId);
          continue;
        }
        await setThreadGroup(threadId, resolved.id);
        added.push(threadId);
      }
      const stdout = input.options.json
        ? JSON.stringify({ added, already }, null, 2) + "\n"
        : added.map((id) => `added ${id}`).join("\n") +
            already.map((id) => `already ${id}`).join("\n") +
            "\n";
      return { exitCode: 0, stdout };
    },
  });

  const groupRemove = cliCommand({
    summary: "Remove threads from their group (idempotent)",
    description:
      "An unassigned thread is a no-op. A group emptied by this write loses its registry record — the only-exists-while-assigned lifecycle the board's own writes run. Membership is per-thread, so no parent or child moves with it.",
    positionals: [
      {
        name: "thread-id",
        description: "Thread id(s) to remove from their group",
        required: true,
        variadic: true,
      },
    ],
    options: {
      json: { type: "boolean", description: "Emit machine-readable JSON" },
    },
    async run(input) {
      const removed: Array<{ threadId: string; groupId: string | null; fromName: string | null }> = [];
      for (const threadId of input.positionals["thread-id"] as string[]) {
        const { from, fromName } = await setThreadGroup(threadId, null);
        removed.push({ threadId, groupId: from, fromName });
      }
      const stdout = input.options.json
        ? JSON.stringify(
            {
              removed: removed.map(({ threadId, groupId }) => ({ threadId, groupId })),
            },
            null,
            2,
          ) + "\n"
        : removed
            .map((row) =>
              row.groupId === null
                ? `removed ${row.threadId} (was not in a group)`
                : `removed ${row.threadId} (was in ${JSON.stringify(row.fromName ?? `unknown group ${row.groupId}`)})`,
            )
            .join("\n") + "\n";
      return { exitCode: 0, stdout };
    },
  });

  const groupMove = cliCommand({
    summary: "Move threads into a feature group, replacing any current group",
    description:
      "The explicit mover: a thread in another group, or unassigned, relocates to the target; a thread already in the target is unchanged. The target accepts the group id or its exact name, passed with --to.",
    positionals: [
      {
        name: "thread-id",
        description: "Thread id(s) to move",
        required: true,
        variadic: true,
      },
    ],
    options: {
      to: {
        type: "string",
        description: "Target group (id or exact name)",
        required: true,
      },
      json: { type: "boolean", description: "Emit machine-readable JSON" },
    },
    async run(input) {
      const resolved = await resolveGroupRef(input.options.to);
      const moved: Array<{ threadId: string; from: string | null; fromName: string | null }> = [];
      const unchanged: string[] = [];
      for (const threadId of input.positionals["thread-id"] as string[]) {
        const current = await readGroupAssignment(threadId);
        if (current?.groupId === resolved.id) {
          unchanged.push(threadId);
          continue;
        }
        const { from, fromName } = await setThreadGroup(threadId, resolved.id);
        moved.push({ threadId, from, fromName });
      }
      const stdout = input.options.json
        ? JSON.stringify(
            {
              moved: moved.map(({ threadId, from }) => ({ threadId, from })),
              unchanged,
            },
            null,
            2,
          ) + "\n"
        : moved
            .map((row) =>
              row.from === null
                ? `moved ${row.threadId} (was not in a group)`
                : `moved ${row.threadId} (from ${JSON.stringify(row.fromName ?? `unknown group ${row.from}`)})`,
            )
            .concat(unchanged.map((id) => `unchanged ${id} (already in ${resolved.name})`))
            .join("\n") + "\n";
      return { exitCode: 0, stdout };
    },
  });

  const linkList = cliCommand({
    summary: "List threads with linked tracker items (GitHub issues/PRs, externals)",
    options: {
      json: { type: "boolean", description: "Emit machine-readable JSON" },
    },
    async run(_input) {
      const { rows: candidates } = await listCandidateThreads();
      const rows: Array<{
        id: string;
        title: string | null;
        links: ThreadLink[];
      }> = [];
      for (const thread of candidates) {
        const links = await readLinkedIssues(thread.id);
        if (links === null || links.length === 0) continue;
        rows.push({
          id: thread.id,
          title: thread.title ?? thread.titleFallback,
          links,
        });
      }
      const stdout = _input.options.json
        ? JSON.stringify(rows, null, 2) + "\n"
        : rows.length === 0
          ? "No threads carry linked tracker items.\n"
          : rows
              .map(
                (row) =>
                  `${row.id}\t${row.links
                    .map((link) =>
                      link.tracker === "external"
                        ? `${link.label ?? link.hostname} (${link.url})`
                        : `${link.repo}#${link.issue}${link.kind === "pull" ? " (pull)" : ""}`,
                    )
                    .join(", ")}\t${row.title ?? "(untitled)"}`,
              )
              .join("\n") + "\n";
      return { exitCode: 0, stdout };
    },
  });

  const linkSet = cliCommand({
    summary: "Link a thread to a tracker item (GitHub issue/PR, or any https URL)",
    description:
      "Give a full GitHub issue/PR URL (status dot included), a bare number (resolved against the thread's project remote, or an explicit --repo owner/repo; --pull marks a pull request), or any other https URL (external tracker item; --label sets the chip text).",
    positionals: [
      {
        name: "thread-id",
        description: "Thread to link",
        required: true,
      },
      {
        name: "number-or-url",
        description: "GitHub issue/PR URL, a bare issue number, or any https URL",
        required: true,
      },
    ],
    options: {
      repo: {
        type: "string",
        description: "Explicit owner/repo slug (bare-number form only)",
      },
      pull: {
        type: "boolean",
        description: "The number is a pull request, not an issue",
      },
      label: {
        type: "string",
        description: "Chip text for an external URL link (1-80 chars)",
      },
      json: { type: "boolean", description: "Emit machine-readable JSON" },
    },
    async run(input) {
      const [threadId, target] = [
        input.positionals["thread-id"] as string,
        input.positionals["number-or-url"] as string,
      ];
      const now = new Date();
      const ghParsed = parseGithubItemUrl(target);
      let link: ThreadLink;
      if (ghParsed !== null) {
        link = {
          tracker: "github",
          repo: ghParsed.repo,
          issue: ghParsed.issue,
          kind: ghParsed.kind,
          href: linkHref(ghParsed.repo, ghParsed.kind, ghParsed.issue),
          createdAt: now.toISOString(),
          source: "operator",
        };
      } else if (/^https:\/\//.test(target)) {
        link = makeExternalLink(target, input.options.label, "operator", now);
      } else {
        const number = Number(/^#?(\d+)$/.exec(target)?.[1]);
        if (!(Number.isInteger(number) && number > 0)) {
          throw new PluginCliError(`invalid issue, PR, or URL '${target}'`, {
            code: "invalid_value",
            hint: "Pass a full https URL, or a positive integer (#12 or 12).",
          });
        }
        const repo = await resolveLinkRepo(threadId, input.options.repo);
        const kind = input.options.pull === true ? "pull" : "issue";
        link = {
          tracker: "github",
          repo,
          issue: number,
          kind,
          href: linkHref(repo, kind, number),
          createdAt: now.toISOString(),
          source: "operator",
        };
      }
      await writeLinkedIssues(
        threadId,
        stampLinkedIssues(await readLinkedIssues(threadId), link),
      );
      await publishLinksChanged([threadId]);
      const stdout = input.options.json
        ? JSON.stringify({ threadId, link }, null, 2) + "\n"
        : `linked ${threadId} → ${link.tracker === "external" ? link.url : linkHref(link.repo, link.kind, link.issue)}\n`;
      return { exitCode: 0, stdout };
    },
  });

  const linkClear = cliCommand({
    summary: "Clear a thread's linked GitHub issues/PRs",
    description:
      "With issue/PR numbers, clears exactly those links; without, clears every link on the thread. Idempotent either way.",
    positionals: [
      {
        name: "thread-id",
        description: "Thread to unlink",
        required: true,
      },
      {
        name: "number",
        description: "Issue/PR numbers to clear (all links when omitted)",
        variadic: true,
      },
    ],
    options: {
      json: { type: "boolean", description: "Emit machine-readable JSON" },
    },
    async run(input) {
      const threadId = input.positionals["thread-id"] as string;
      const numbers = (input.positionals["number"] ?? []).map((raw) => {
        const parsed = Number(/^#?(\d+)$/.exec(raw)?.[1]);
        if (!(Number.isInteger(parsed) && parsed > 0)) {
          throw new PluginCliError(`invalid issue or PR '${raw}'`, {
            code: "invalid_value",
            hint: "Pass positive integers (#12 or 12), or none to clear everything.",
          });
        }
        return parsed;
      });
      let links = await readLinkedIssues(threadId);
      if (numbers.length === 0) {
        links = null;
      } else {
        for (const number of numbers) links = clearLinkedIssues(links, number);
      }
      await writeLinkedIssues(threadId, links);
      await publishLinksChanged([threadId]);
      const stdout = input.options.json
        ? JSON.stringify({ threadId, cleared: numbers }, null, 2) + "\n"
        : `cleared links on ${threadId}\n`;
      return { exitCode: 0, stdout };
    },
  });

  const sweep = cliCommand({
    summary:
      "Show (or with --confirm, sweep) Done-past-threshold and long-idle threads",
    description:
      "Without --confirm this is a dry-run: it prints the eligible set and exits 1 without touching anything. With --confirm, Done-past-threshold threads are archived and long-idle threads are marked Done (the fresh doneAt stamp starts the Done arm's archive clock, so a swept idle thread resurfaces in the Done sweep).",
    options: {
      confirm: {
        type: "boolean",
        description:
          "Sweep the resolved eligible set: archive Done threads, mark long-idle threads Done",
      },
      ids: {
        type: "string",
        repeatable: true,
        split: ",",
        description:
          "Restrict the sweep to these thread ids (frozen-list semantics)",
      },
      json: { type: "boolean", description: "Emit machine-readable JSON" },
    },
    async run(input) {
      await importLegacyDone();
      const confirm = input.options.confirm === true;
      const ids = input.options.ids ?? [];
      const values = await settings.get();
      const thresholds = {
        doneArchiveMs: archiveThresholdMs(
          values.doneArchiveValue,
          ARCHIVE_UNIT_SCHEMA.parse(values.doneArchiveUnit),
        ),
        idleArchiveMs: archiveThresholdMs(
          values.idleArchiveValue,
          ARCHIVE_UNIT_SCHEMA.parse(values.idleArchiveUnit),
        ),
      };
      const { rows: candidates, liveIds } = await listCandidateThreads();
      const byId = new Map(candidates.map((row) => [row.id, row]));
      const kept = await readKept();

      // Sweep-family contract: a live (non-archived) thread row that names a
      // parent makes that parent never sweep-eligible, in either arm.
      const liveChildParentIds = new Set<string>();
      for (const row of candidates) {
        if (row.archivedAt === null && row.parentThreadId !== null && liveIds.has(row.id)) {
          liveChildParentIds.add(row.parentThreadId);
        }
      }

      const facts: SweepFact[] = await Promise.all(
        candidates.map(async (thread) => {
          const record = await readDoneRecord(thread.id);
          const snoozeRecord = await readSnoozeRecord(thread.id);
          return {
            id: thread.id,
            archived: thread.archivedAt !== null,
            pinned: thread.pinnedAt !== null,
            updatedAt: thread.updatedAt,
            doneAt:
              record === null
                ? null
                : doneAtToEpochMs(record.doneAt),
            keep: record?.keep === true || kept[thread.id] === true,
            snoozed: snoozeRecord !== null,
            status: thread.status,
            unread:
              thread.lastReadAt === null
                ? thread.latestAttentionAt > 0
                : thread.latestAttentionAt > thread.lastReadAt,
            hasLiveChildren: liveChildParentIds.has(thread.id),
          };
        }),
      );
      let eligible = sweepCliEligible(facts, thresholds, Date.now());
      if (ids.length > 0) {
        const idSet = new Set(ids);
        if (confirm) {
          // Frozen-list semantics: archive exactly the named ids that are
          // still live, even if they are not otherwise eligible, and never
          // archive anything else.
          eligible = facts
            .filter((fact) => idSet.has(fact.id) && !fact.archived)
            .map((fact) => ({
              id: fact.id,
              reason: fact.doneAt !== null ? ("done" as const) : ("idle" as const),
            }));
        } else {
          eligible = eligible.filter((entry) => idSet.has(entry.id));
        }
      }

      const describe = (entry: SweepEligible): string =>
        entry.reason === "done"
          ? `done longer than ${values.doneArchiveValue} ${values.doneArchiveUnit}`
          : `idle longer than ${values.idleArchiveValue} ${values.idleArchiveUnit}`;
      const titleOf = (id: string): string | null => {
        const thread = byId.get(id);
        return thread?.title ?? thread?.titleFallback ?? null;
      };

      if (!confirm) {
        const lines = eligible.map(
          (entry) =>
            `${entry.id}\t${describe(entry)}\t${titleOf(entry.id) ?? "(untitled)"}`,
        );
        const stdout = input.options.json
          ? JSON.stringify(
              {
                eligible: eligible.map((entry) => ({
                  id: entry.id,
                  reason: entry.reason,
                  title: titleOf(entry.id),
                })),
                count: eligible.length,
              },
              null,
              2,
            ) + "\n"
          : eligible.length === 0
            ? "No threads are sweep-eligible.\n"
            : `${lines.join("\n")}\n${eligible.length} thread(s) eligible; re-run with --confirm to sweep (Done threads archive; long-idle threads are marked Done).\n`;
        return { exitCode: 1, stdout };
      }

      const results: Array<{ id: string; action: "archived" | "marked-done" }> = [];
      for (const entry of eligible) {
        // The sweep's staged exit: Done-age threads archive; long-idle
        // threads are marked Done (operator decision 2026-10-01) — the
        // fresh doneAt stamp starts the Done arm's archive clock, so a
        // swept idle thread resurfaces in the Done sweep instead of
        // vanishing while it was never done.
        if (entry.reason === "idle") {
          await writeDoneRecord(entry.id, true);
          bb.realtime.publish(DONE_CHANGED, { threadId: entry.id, done: true });
          results.push({ id: entry.id, action: "marked-done" });
        } else {
          await bb.sdk.threads.archive({ threadId: entry.id });
          results.push({ id: entry.id, action: "archived" });
        }
      }
      const archivedIds = results
        .filter((result) => result.action === "archived")
        .map((result) => ({ id: result.id }));
      const markedDoneIds = results
        .filter((result) => result.action === "marked-done")
        .map((result) => ({ id: result.id }));
      const stdout = input.options.json
        ? JSON.stringify(
            {
              archived: archivedIds,
              markedDone: markedDoneIds,
              count: results.length,
            },
            null,
            2,
          ) + "\n"
        : results.length === 0
          ? "Nothing to sweep.\n"
          : results
              .map((result) =>
                result.action === "marked-done"
                  ? `marked Done ${result.id}`
                  : `archived ${result.id}`,
              )
              .join("\n") + "\n";
      return { exitCode: 0, stdout };
    },
  });

  // --- Snooze CLI: bb focus-board snooze ---
  //
  // Mirrors the done commands (board-owned state only; set is read-now +
  // record + arm wake, clear kills the timer). `snooze set` takes the wake
  // time FIRST so the thread ids can stay variadic at the end, matching
  // `done mark`'s shape.

  const snoozeList = cliCommand({
    summary: "List snoozed threads with their wake times",
    options: {
      json: { type: "boolean", description: "Emit machine-readable JSON" },
    },
    async run(input) {
      const rows = await bb.sdk.threads.list({});
      const records: Array<{
        id: string;
        title: string | null;
        wakeAt: string;
        overdue: boolean;
      }> = [];
      for (const thread of rows) {
        const record = await readSnoozeRecord(thread.id);
        if (record === null) continue;
        const wakeAtMs = snoozeWakeAtMs(record);
        records.push({
          id: thread.id,
          title: thread.title ?? thread.titleFallback,
          wakeAt: record.wakeAt,
          overdue: wakeAtMs === null ? false : wakeAtMs <= Date.now(),
        });
      }
      records.sort((a, b) => a.wakeAt.localeCompare(b.wakeAt));
      const stdout = input.options.json
        ? JSON.stringify(records, null, 2) + "\n"
        : records.length === 0
          ? "No threads are snoozed.\n"
          : records
              .map(
                (row) =>
                  `${row.id}\t${row.wakeAt}${row.overdue ? "\t(overdue)" : ""}\t${row.title ?? "(untitled)"}`,
              )
              .join("\n") + "\n";
      return { exitCode: 0, stdout };
    },
  });

  const snoozeSet = cliCommand({
    summary:
      "Snooze threads until <when>: marks read now, unread again at the wake",
    description:
      "<when> is a future epoch-parseable timestamp or a relative duration (+30m, +4h, +1d, +2w). The wake is server-armed: it fires after daemon restarts too.",
    positionals: [
      {
        name: "when",
        description: "+<N>m|h|d|w or a future ISO/parsable timestamp",
        required: true,
      },
      {
        name: "thread-id",
        description: "Thread id(s) to snooze",
        required: true,
        variadic: true,
      },
    ],
    options: {
      json: { type: "boolean", description: "Emit machine-readable JSON" },
    },
    async run(input) {
      const when = parseWhenArg(input.positionals.when, new Date());
      if (when === null) {
        throw new PluginCliError(
          `invalid wake time '${input.positionals.when}'`,
          {
            code: "invalid_value",
            hint: "Use +<N>m|h|d|w or a future timestamp (e.g. 2026-10-03T09:00).",
          },
        );
      }
      const snoozed: Array<{ id: string; wakeAt: string }> = [];
      for (const threadId of input.positionals["thread-id"]) {
        const record = await writeSnooze(threadId, when);
        snoozed.push({ id: threadId, wakeAt: record.wakeAt });
      }
      const stdout = input.options.json
        ? JSON.stringify({ snoozed }, null, 2) + "\n"
        : snoozed
            .map((entry) => `snoozed ${entry.id} until ${entry.wakeAt}`)
            .join("\n") + "\n";
      return { exitCode: 0, stdout };
    },
  });

  const snoozeClear = cliCommand({
    summary: "Cancel a snooze (keeps the thread's current read state)",
    positionals: [
      {
        name: "thread-id",
        description: "Thread id(s) to unsnooze",
        required: true,
        variadic: true,
      },
    ],
    options: {
      json: { type: "boolean", description: "Emit machine-readable JSON" },
    },
    async run(input) {
      const cleared: Array<{ id: string; cleared: boolean }> = [];
      for (const threadId of input.positionals["thread-id"]) {
        cleared.push({
          id: threadId,
          cleared: await clearSnooze(threadId),
        });
      }
      const stdout = input.options.json
        ? JSON.stringify({ cleared }, null, 2) + "\n"
        : cleared
            .map((entry) =>
              entry.cleared ? `cleared snooze ${entry.id}` : `not snoozed ${entry.id}`,
            )
            .join("\n") + "\n";
      return { exitCode: 0, stdout };
    },
  });

  // --- ✨ auto-rename diagnostics: bb focus-board autotitle ---
  //
  // The fallback modal owns the browser truth but cannot be observed from
  // the outside; these two commands print the same state (availability,
  // selection, bridge classification) and run the probe end-to-end, so the
  // live verdict is one CLI call away.

  const autotitleAvailability = cliCommand({
    summary:
      "Report the ✨ auto-rename menu for a thread: selection, bridges, thread-model probe availability",
    positionals: [
      {
        name: "thread-id",
        description: "Thread to report on",
        required: true,
      },
    ],
    options: {
      json: { type: "boolean", description: "Emit machine-readable JSON" },
    },
    async run(input) {
      const menu = await autotitleServicesMenu(input.positionals["thread-id"]);
      if (input.options.json) {
        return { exitCode: 0, stdout: JSON.stringify(menu, null, 2) + "\n" };
      }
      const lines: string[] = [];
      lines.push(
        menu.threadModel.available
          ? "thread model probe: available"
          : `thread model probe: not available — ${menu.threadModel.reason ?? "unknown reason"}`,
      );
      lines.push(
        menu.selected === null
          ? "selected service: none (task not set to a plugin service)"
          : `selected service: ${menu.selected.pluginId}/${menu.selected.serviceId}`,
      );
      for (const service of menu.services) {
        const at = `${service.displayName} (${service.pluginId}/${service.serviceId})`;
        if (!service.ready) {
          lines.push(`[not ready] ${at} — ${service.message ?? "not ready"}`);
        } else if (service.bridge === false) {
          lines.push(`[no bridge] ${at} — ${service.bridgeReason ?? "no bridge"}`);
        } else {
          lines.push(`[bridged] ${at}`);
        }
      }
      return { exitCode: 0, stdout: lines.join("\n") + "\n" };
    },
  });

  const autotitlePrompt = cliCommand({
    summary: "Print the originating prompt an ✨ auto-rename would title from",
    description:
      "Diagnostic for the ✨ auto-rename: the oldest user timeline row (the thread's spawn input), falling back to paged prompt history. `--json` prints { prompt: string | null }.",
    positionals: [
      {
        name: "thread-id",
        description: "The thread to read the originating prompt from.",
        required: true,
      },
    ],
    options: {
      json: { type: "boolean", description: "Print machine-readable JSON." },
    },
    async run(input) {
      const threadId = input.positionals["thread-id"];
      const timeline = (await bb.sdk.threads.timeline({
        threadId,
      })) as { rows?: unknown };
      const rows = (timeline.rows ?? []) as readonly AutotitleTimelineRow[];
      const prompt = await threadOriginatingPrompt(threadId);
      if (input.options.json === true) {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(
            {
              prompt,
              rows: rows.map((row) => ({
                SeqStart: row.sourceSeqStart ?? null,
                createdAt: row.createdAt ?? null,
                kind: row["kind"] ?? null,
                role: row["role"] ?? null,
                text: typeof row.text === "string" ? row.text.slice(0, 120) : null,
              })),
            },
            null,
            2,
          )}\n`,
        };
      }
      return {
        exitCode: 0,
        stdout:
          prompt === null
            ? "no originating prompt found (timeline and history both empty of user text)\n"
            : `${prompt}\n`,
      };
    },
  });

  const autotitleProbe = cliCommand({
    summary:
      "Run the ✨ thread-model probe end-to-end for a thread (spawns a hidden one-turn thread, prints the title, deletes it)",
    positionals: [
      {
        name: "thread-id",
        description: "Thread whose provider/model the probe clones",
        required: true,
      },
    ],
    options: {
      json: { type: "boolean", description: "Emit machine-readable JSON" },
    },
    async run(input) {
      const title = await probeThreadModelTitle(input.positionals["thread-id"]);
      const stdout = input.options.json
        ? JSON.stringify({ title }, null, 2) + "\n"
        : `probed title: ${title}\n`;
      return { exitCode: 0, stdout };
    },
  });

  // Board-linked tracker items: the agent surface (issue #13). The tool's
  // `instructions` nudge — the AGENTS.md-style push — rides with the tool's
  // presence in the session's tool set, so any thread's agent learns to link
  // what it files or turns up, without text pasted into every repo's AGENTS.md.
  const LINK_AGENT_TOOL = "focus_board_link_issue";
  bb.agents.registerTool({
    name: LINK_AGENT_TOOL,
    description:
      "Link this bb thread to a tracker item so the Focus Board card shows a chip: a GitHub issue or pull request (live status dot), or any other https URL the conversation turns up (external tracker, chip reads the label or hostname). Call it right after you open or file the item, passing its URL.",
    instructions: [
      "Linking work to tracker items: whenever you open or file a GitHub issue",
      "or pull request for this thread's work, call focus_board_link_issue with",
      "the returned URL, and the Focus Board card carries its chip (number,",
      "kind, live status dot). External tracker URLs (Jira, Linear, Forgejo,",
      "anything https) link too: pass the URL, optionally with label for the",
      "chip text when the conversation turns such an item up. One call per",
      "item; prefer the URL form (a bare GitHub number needs a GitHub remote",
      "on the thread's project).",
      "If focus_board_link_issue is unavailable in your session (Copilot CLI",
      "sessions, for one, are not served bb plugin tools), fall back to the",
      "bb CLI instead of telling the user the tool is missing:",
      'run `bb focus-board link set "$BB_THREAD_ID" <url>` (add',
      "--label \"<chip text>\" for external trackers). Verify success from",
      "the command's output; report the linked URL either way.",
    ].join("\n"),
    parameters: z
      .object({
        url: z
          .string()
          .startsWith("https://", "https url")
          .optional(),
        number: z.number().int().positive().optional(),
        kind: z.enum(["issue", "pull"]).optional(),
        label: z.string().min(1).max(80).optional(),
      })
      .superRefine((value, refineCtx) => {
        if ((value.url === undefined) === (value.number === undefined)) {
          refineCtx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Pass exactly one of url or number.",
          });
        }
        if (value.number !== undefined && value.label !== undefined) {
          refineCtx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "label applies to the url form only.",
            path: ["label"],
          });
        }
      }),
    execute: async (params, ctx) => {
      const linkError = (text: string) => ({
        content: [{ type: "text" as const, text }],
        isError: true as const,
      });
      const now = new Date();
      const parsed = params.url === undefined ? null : parseGithubItemUrl(params.url);
      let link: ThreadLink;
      if (parsed !== null) {
        link = {
          tracker: "github",
          repo: parsed.repo,
          issue: parsed.issue,
          kind: parsed.kind,
          href: linkHref(parsed.repo, parsed.kind, parsed.issue),
          createdAt: now.toISOString(),
          source: "agent",
        };
      } else if (params.url !== undefined) {
        // Non-GitHub https URL → external tracker item; the hostname derives
        // from the URL, the label (optional) rides caller input.
        link = makeExternalLink(params.url, params.label, "agent", now);
      } else {
        const number = params.number!;
        const kind = params.kind ?? "issue";
        // Repo from the thread's project remote only; never guessed. The
        // URL form is preferred precisely because bare numbers need this.
        const project = await bb.sdk.projects.get({ projectId: ctx.projectId });
        const slug = resolveRepoSlug(project.gitRemoteUrl);
        if (slug === null) {
          return linkError(
            `Cannot link to a GitHub item: project ${ctx.projectId} has no GitHub remote. Pass the full GitHub issue or PR URL instead.`,
          );
        }
        link = {
          tracker: "github",
          repo: slug,
          issue: number,
          kind,
          href: linkHref(slug, kind, number),
          createdAt: now.toISOString(),
          source: "agent",
        };
      }
      await writeLinkedIssues(
        ctx.threadId,
        stampLinkedIssues(await readLinkedIssues(ctx.threadId), link),
      );
      await publishLinksChanged([ctx.threadId]);
      return {
        content: [
          {
            type: "text" as const,
            text: `Linked this thread to ${link.tracker === "external" ? link.url : link.href}; the Focus Board card now carries the chip.`,
          },
        ],
      };
    },
  });

  // Feature groups (issue #84): the agent surface, mirroring the link
  // tool's pattern. An agent creates a thread that belongs to an existing
  // feature group and can now put it there without the board's UI; the
  // group accepts its exact name (the one people quote in conversation)
  // or its id, and assigning replaces any current group with the move
  // reported, so the agent sees what it changed.
  const GROUP_AGENT_TOOL = "focus_board_group_set";
  bb.agents.registerTool({
    name: GROUP_AGENT_TOOL,
    description:
      "Assign a Focus Board feature group (family box) to this bb thread, or to another thread id, so the card joins that group on the board's Group view. Pass the group's exact name, or its id. Assigning replaces any previous group.",
    instructions: [
      "Feature groups: when the conversation settles that this thread belongs",
      "to a named feature group (a family box on the Focus Board's Group view),",
      "call focus_board_group_set with the group's name as given (its id works",
      "too). Assigning replaces any previous group. Create a missing group",
      'first with `bb focus-board group create "<name>"`. If the tool is',
      "unavailable in your session, fall back to the bb CLI instead of telling",
      "the user the tool is missing:",
      '`bb focus-board group add "<group>" "$BB_THREAD_ID"` (or',
      '`group move <thread id> --to "<group>" for a thread other than this',
      "one). Verify success from the command's output.",
    ].join("\n"),
    parameters: z.object({
      group: z.string().min(1).max(80),
      threadId: z.string().min(1).optional(),
    }),
    execute: async (params, ctx) => {
      const groupError = (text: string) => ({
        content: [{ type: "text" as const, text }],
        isError: true as const,
      });
      try {
        const resolved = await resolveGroupRef(params.group);
        const targetId = params.threadId ?? ctx.threadId;
        const { from, fromName } = await setThreadGroup(targetId, resolved.id);
        if (from === resolved.id) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Thread ${targetId} is already in group ${resolved.name} (${resolved.id}); nothing changed.`,
              },
            ],
          };
        }
        const replaced =
          from === null
            ? "Assigned"
            : `Moved (was in ${JSON.stringify(fromName ?? `unknown group ${from}`)})`;
        return {
          content: [
            {
              type: "text" as const,
              text: `${replaced} thread ${targetId} into group ${resolved.name} (${resolved.id}).`,
            },
          ],
        };
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        return groupError(
          `Cannot assign the group: ${detail}. List the existing groups with ` +
            "`bb focus-board group list`, or create one first with " +
            '`bb focus-board group create "<name>".',
        );
      }
    },
  });

  bb.cli.register(
    defineCli({
      name: "focus-board",
      summary: "Manage the Focus Board plugin's own state",
      description:
        "Done list/mark/clear, feature groups (group list/create/rename/delete/add/remove/move, each taking the id or the exact name), linked tracker items (link list/set/clear), snooze list/set/clear, autotitle availability/probe diagnostics, and sweep (archive old Done + long-idle, dry-run by default). Sweep thresholds live in the declared plugin settings (`bb plugin config focus-board`) and the board settings modal; this CLI no longer carries its own config commands.",
      commands: {
        "done list": doneList,
        "done mark": doneMark,
        "done clear": doneClear,
        "group list": groupList,
        "group create": groupCreate,
        "group rename": groupRename,
        "group delete": groupDelete,
        "group add": groupAdd,
        "group remove": groupRemove,
        "group move": groupMove,
        "link list": linkList,
        "link set": linkSet,
        "link clear": linkClear,
        "snooze list": snoozeList,
        "snooze set": snoozeSet,
        "snooze clear": snoozeClear,
        "autotitle availability": autotitleAvailability,
        "autotitle prompt": autotitlePrompt,
        "autotitle probe": autotitleProbe,
        sweep,
      },
    }),
  );

  // Arm every snoozed thread at load (fire-and-forget: scan failures log,
  // never block the plugin's other surfaces), and drop all timers on
  // dispose so a reload never leaves stale wakes ticking.
  void armAllSnoozes().catch((error: unknown) => {
    bb.log.warn(
      `snooze wake scan failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  bb.onDispose(() => {
    for (const timer of wakeTimers.values()) clearTimeout(timer);
    wakeTimers.clear();
    bb.log.info("disposed");
  });
}
