// Jira integration wiring. This part: the `bb focus-board jira …` CLI bridge
// the companion script (scripts/jira-sync.mjs) talks to. The commands work
// whether or not jiraEnabled is set, and change no board behavior.
// Also: reconciliation (`jira reconcile`, the jira_reconcile_* RPCs, and the
// one-time run when jiraEnabled flips on). And the Jira column's writes
// (jira_column_action): Link / dismiss a suggestion, drift fixes, Start thread.
// And the agent side (lib/jira-agent.ts): the one bb.agents.configure, the
// focus_board_jira_link / focus_board_spawn_child tools, and the find-ticket /
// promote-epic card turns. And the Done check (lib/jira-done-check.ts):
// startDoneCheck, the focus_board_done_verdict tool, jira_done_confirm and
// the Done card actions. And the reminders (lib/jira-reminders.ts): the
// "jira-reminders" schedule (nudge turn, deeper check), the nudge reply
// capture and the reason clearing.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { cliCommand, defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { createIdleWaiters, sendIfIdle, type JobKind } from "./jira-idle";
import { findTicketText, JIRA_AGENT_TOOLS, JIRA_LINK_TOOL, JIRA_SPAWN_TOOL, jiraConfigure, JiraLinkParams, promoteEpicText, SpawnChildParams, titleWithKey, trackedRegisterTool } from "./jira-agent";
import { jiraBrowseUrl } from "./jira-keys";
import { fixQueued, livePrs, prUrl } from "./jira-drift";
import { capReasons, DONE_SUMMARY_PREFIX, doneSummary, evaluateMechanical, JIRA_VERDICT_TOOL, spinOffText, ticketUpdate, verifyTurnText } from "./jira-done-check";
import { deepCheckFindings, NUDGE_TEXT, planReminders, replyLine, type DeepNext, type ReminderThread } from "./jira-reminders";
import { applyReconcile, externalJiraKey, planReconcile, StoredReconcilePlan, threadPrsOf, type ReconThread } from "./jira-reconcile";
import { DriftItem, JiraTicket, OpResult, QueueOp, ThreadJiraRecord } from "./jira-schema";
import { jiraSettings } from "./jira-settings";
import { createJiraStore, type JiraStore, type NewQueueOp } from "./jira-store";
import { makeExternalLink, type ThreadLink } from "./link-metadata";
import { BB_PERSONAL_PROJECT_ID } from "./new-thread-seed";

export type JiraDeps = {
  /** Raw plugin settings values (jira* keys). */
  settings: () => Promise<Record<string, unknown>>;
  /** Linked items of every non-archived thread (server.ts's existing link reader). */
  liveLinks: () => Promise<{ id: string; links: ThreadLink[] }[]>;
  /** Plugin source directory, when the host can say; else a placeholder is printed. */
  repoDir?: string;
  /** Live threads as reconcile input (title, branch, status, Done). */
  reconThreads: () => Promise<ReconThread[]>;
  /** One thread's board links (server.ts readLinkedIssues). */
  readLinks: (threadId: string) => Promise<ThreadLink[]>;
  /** Stamp one board link the way link_set does (write + publish). */
  addLink: (threadId: string, link: ThreadLink) => Promise<void>;
  /** Subscribe to plugin settings changes (settings.onChange). */
  onSettingsChange?: (listener: () => void) => void;
  /** Names of every agent tool the plugin registers (filled through `tracked`); Jira's are added here too. */
  agentTools?: string[];
  /** Whether the thread carries a Done stamp (server.ts readDoneRecord). */
  isDone?: (threadId: string) => Promise<boolean>;
  /** Stamp Done the upstream way (server.ts writeDoneRecord + done-changed). */
  markDone?: (threadId: string) => Promise<void>;
  /** Publish done-changed { done: false }: a check ended without a stamp, so boards drop their optimistic Done. */
  notDone?: (threadId: string) => void;
  /** Live threads for the reminder pass: status, last activity (epoch ms), Done, snooze wake (epoch ms, null when not snoozed). */
  reminderThreads?: () => Promise<{ id: string; status: string; updatedAt: number; branch: string | null; done: boolean; snoozeWakeAt: number | null }[]>;
};

const PLAN_KEY = "jira:reconcile-plan";
const ENABLED_SEEN_KEY = "jira:enabled-seen";
/** `${threadId} ${key}` suggestions the operator dismissed; never re-suggested. */
// ponytail: grows by one entry per dismissal, never pruned; prune archived threads if it ever matters.
const DISMISSED_KEY = "jira:dismissed-suggestions";
/** threadId → verifying.startedAt of the check whose verify turn was sent (the verdict tool's gate). */
const VERIFY_SENT_KEY = "jira:verify-sent";
/** threadId → the nudge turn in flight or answered (its own activity is not "new activity"). */
const NUDGE_TURNS_KEY = "jira:nudge-turns";
/** threadId → the snooze wake seen (epoch ms): the quiet clock restarts there. */
const SNOOZE_SEEN_KEY = "jira:snooze-seen";
/** threadId → the deeper check's next step, shown while the reason is still that check's. */
const NEXT_STEPS_KEY = "jira:next-steps";
export const JIRA_RECONCILE_CHANGED = "jira-reconcile-changed";
export const JIRA_CHANGED = "jira-changed";

export const JIRA_CARD_ACTIONS = [
  "find-ticket", "confirm-done", "skip-done", "spin-off", "keep-working", "not-needed", "clear-check-in", "promote-epic", "run-done-check", "dismiss-reason",
] as const;
const NextStep = z.object({ reason: z.string(), next: z.enum(["done-check", "open-pr", "snooze"]), prUrl: z.string().optional() });

const AppliedPlan = StoredReconcilePlan.extend({
  /** Threads skipped because a write failed; the rest applied. */
  failed: z.array(z.object({ threadId: z.string(), stage: z.enum(["link", "enroll"]), error: z.string() })),
});
type AppliedPlan = z.infer<typeof AppliedPlan>;

export const jiraRpcContract = defineRpcContract({
  /** The stored plan from the last apply, else a fresh dry plan (nothing written). */
  jira_reconcile_plan: { input: z.null(), output: StoredReconcilePlan },
  /** Plan, apply (links + enrolledAt only) and store the plan. */
  jira_reconcile_apply: { input: z.null(), output: AppliedPlan },
  /** Everything the board's Jira chips need in one read. */
  jira_board_state: {
    input: z.null(),
    output: z.object({
      enabled: z.boolean(),
      snapshotAge: z.number().nullable(),
      stale: z.boolean(),
      error: z.string().nullable(),
      tickets: z.array(JiraTicket),
      threads: z.record(z.string(), ThreadJiraRecord),
      pending: z.record(z.string(), QueueOp),
      /** Deeper-check next steps, only while the card's reason is still that check's. */
      next: z.record(z.string(), NextStep),
    }),
  },
  /** A card button press; kinds whose behavior lands later answer "not yet". */
  jira_card_action: {
    input: z.object({
      kind: z.enum(JIRA_CARD_ACTIONS),
      threadId: z.string(),
      /** spin-off / not-needed: which doneCheck reason. */
      index: z.number().int().min(0).optional(),
      /** The reason text the card showed at that index; refused if it changed. */
      reason: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /** Confirm done (skip: "Mark done anyway", comment only, never a transition). */
  jira_done_confirm: {
    input: z.object({ threadId: z.string(), skip: z.boolean().optional() }),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /** A Jira column press. "started" follows a Start-thread spawn. */
  jira_column_action: {
    input: z.object({
      action: z.enum(["link", "dismiss-suggestion", "fix", "started"]),
      key: JiraTicket.shape.key,
      threadId: z.string().optional(),
      kind: DriftItem.shape.kind.optional(),
      /** Give back only: set by the column's confirm dialog. */
      confirm: z.literal(true).optional(),
    }),
    output: z.object({ ok: z.boolean(), error: z.string().optional(), alreadyQueued: z.literal(true).optional() }),
  },
});

const PLACEHOLDER_REPO = "<path-to-bb-plugin-focus-board>";
const fail = (msg: string) => ({ exitCode: 1, stderr: `${msg}\n` });
const out = (v: unknown) => ({ exitCode: 0, stdout: JSON.stringify(v, null, 2) + "\n" });

// ponytail: `-` (stdin) is not offered: plugin CLI handlers get no stdin from
// the bb CLI (only a one-line 16 KiB `stdin: true` option). The script passes a file.
function readJsonFile(path: string): unknown {
  if (path === "-") throw new Error("stdin is not supported by plugin CLI commands; pass a file path");
  return JSON.parse(readFileSync(path, "utf8"));
}

export function registerJira(bb: BbPluginApi, deps: JiraDeps) {
  const store: JiraStore = createJiraStore(bb.storage.kv as never, bb.sdk.threads as never, Date.now, {
    refreshMinutes: async () => jiraSettings(await deps.settings()).refreshMinutes,
    log: (m) => bb.log.warn(m),
    onChange: () => bb.realtime.publish(JIRA_CHANGED, {}),
  });
  // Queued idle-gated work (lib/jira-idle.ts). No handlers yet: later
  // features register them (register re-sweeps queued jobs of its kind), so
  // with nothing registered no job ever runs.
  const idle = createIdleWaiters(bb.storage.kv as never, {}, { threads: bb.sdk.threads as never, log: (m) => bb.log.warn(m) });
  bb.events.on("thread.idle", ({ thread }) => idle.onIdle(thread.id));
  bb.events.on("thread.failed", ({ thread }) => idle.onIdle(thread.id)); // error is at rest
  bb.events.on("thread.archived", ({ thread }) => idle.drop(thread.id));
  idle.resume().catch((e) => bb.log.warn(`jira idle resume failed: ${(e as Error).message}`));

  // configure is synchronous, so it reads a settings copy refreshed at load
  // and on every change (off until the first read lands).
  let cfg = jiraSettings({});
  let cfgSeq = 0; // reads can resolve out of order: only the latest one lands
  const refreshCfg = () => {
    const seq = ++cfgSeq;
    return deps.settings().then((v) => {
      if (seq === cfgSeq) cfg = jiraSettings(v);
    });
  };
  const cfgFailed = (e: unknown) => bb.log.warn(`jira settings read failed: ${(e as Error).message}`);
  refreshCfg().catch(cfgFailed);
  // The plugin's only configure: with one registered, unselected tools are off,
  // so every registered tool is selected, Jira's only while enabled.
  const toolNames = deps.agentTools ?? [];
  const registerTool = trackedRegisterTool(bb.agents, toolNames);
  // configure is synchronous: the verify-sent markers live in memory, mirrored
  // to KV so a restart keeps them (none offered until the load lands).
  const verifySent = new Map<string, string>();
  const sentLoaded = bb.storage.kv.get(VERIFY_SENT_KEY).then((raw) => {
    if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) if (typeof v === "string") verifySent.set(k, v);
  });
  // Every change waits for the load, so an early write never drops (or resurrects) stored markers.
  let sentChain: Promise<unknown> = sentLoaded.catch((e) => bb.log.warn(`jira: verify markers unreadable: ${(e as Error).message}`));
  const setSent = (threadId: string, startedAt: string | null) => {
    const run = sentChain.then(() => {
      if (startedAt === null) verifySent.delete(threadId);
      else verifySent.set(threadId, startedAt);
      return bb.storage.kv.set(VERIFY_SENT_KEY, Object.fromEntries(verifySent));
    });
    sentChain = run.catch(() => undefined);
    return run;
  };
  /** The verify turn of this thread's running check was sent: only then is a verdict taken. */
  const awaitingVerdict = (threadId: string, rec: ThreadJiraRecord | undefined) => rec?.verifying != null && verifySent.get(threadId) === rec.verifying.startedAt;
  bb.agents.configure((context) => {
    const j = jiraConfigure(cfg.enabled, cfg, context.pluginMetadata as Record<string, unknown>, context.origin?.kind === "fork");
    const others = toolNames.filter((n) => !JIRA_AGENT_TOOLS.includes(n) && n !== JIRA_VERDICT_TOOL);
    // The verdict tool whenever on: configure lands only at session start/resume, so a
    // live session must already hold it; the handler refuses unless a verify turn was sent.
    const tools = [...others, ...j.tools, ...(cfg.enabled ? [JIRA_VERDICT_TOOL] : [])];
    return { tools, skills: [], ...(j.instructions ? { instructions: j.instructions } : {}) };
  });

  /** One card turn: sent now, or queued for the thread's next idle. A throw is "not sent". */
  const turnOrWait = async (threadId: string, kind: JobKind, text: string, payload?: string) => {
    const r = await sendIfIdle(bb.sdk.threads as never, threadId, text, { log: (m) => bb.log.warn(m) });
    if (r === "busy") await idle.waitFor(threadId, kind, payload);
    return r;
  };
  void idle.register("find-ticket", async (threadId) => {
    const s = jiraSettings(await deps.settings());
    if (!s.enabled) return;
    if ((await store.readThread(threadId)).links.length > 0) {
      bb.log.info(`jira: skipped queued find-ticket on ${threadId}: already linked`);
      return;
    }
    await turnOrWait(threadId, "find-ticket", findTicketText(s));
  });
  void idle.register("promote-epic", async (threadId, payload) => {
    if (typeof payload === "string" && (await enabled())) await turnOrWait(threadId, "promote-epic", promoteEpicText(payload), payload);
  });
  const fileOpt = {
    file: { type: "string" as const, required: true as const, description: "JSON file path" },
  };

  const ingest = cliCommand({
    summary: "Validate a Jira snapshot file and store it",
    options: fileOpt,
    async run(input) {
      let raw: unknown;
      try {
        raw = readJsonFile(input.options.file);
      } catch (e) {
        return fail(`cannot read ${input.options.file}: ${(e as Error).message}`);
      }
      try {
        const r = await store.ingestSnapshot(raw);
        if (!r.ok) return fail(`invalid snapshot: ${r.error}`);
        const failed = (raw as { ok?: unknown; error?: unknown }).ok === false;
        const why = (raw as { error?: unknown }).error;
        return { exitCode: 0, stdout: failed ? `ingested (failure: ${typeof why === "string" ? why : "snapshot not ok"})\n` : "ingested\n" };
      } catch (e) {
        return fail(`cannot store snapshot: ${(e as Error).message}`);
      }
    },
  });

  const wanted = cliCommand({
    summary: "Jira keys and PRs the sync script must fetch",
    options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
    async run() {
      const s = jiraSettings(await deps.settings());
      const keys = new Set<string>();
      const prs = new Map<string, { repo: string; number: number }>();
      for (const { id, links } of await deps.liveLinks()) {
        for (const l of links) {
          if (l.tracker === "external" && l.jira) keys.add(l.jira.key);
          if (l.tracker === "github" && l.kind === "pull") prs.set(`${l.repo}#${l.issue}`, { repo: l.repo, number: l.issue });
        }
        for (const l of (await store.readThread(id)).links) keys.add(l.key);
      }
      // branchHeads: thread rows expose no branch/repo pair cheaply, so none yet.
      return out({ projects: s.projects, linkedKeys: [...keys].sort(), prRefs: [...prs.values()], branchHeads: [] });
    },
  });

  const queue = cliCommand({
    summary: "Pending Jira write ops",
    options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
    async run() {
      return out({ ops: await store.pendingOps() });
    },
  });

  const ack = cliCommand({
    summary: "Acknowledge applied Jira write ops (OpResult[] file)",
    options: fileOpt,
    async run(input) {
      let parsed;
      try {
        parsed = OpResult.array().safeParse(readJsonFile(input.options.file));
      } catch (e) {
        return fail(`cannot read ${input.options.file}: ${(e as Error).message}`);
      }
      if (!parsed.success) return fail(`invalid results: ${parsed.error.message}`);
      try {
        await store.ack(parsed.data);
      } catch (e) {
        return fail(`cannot record results: ${(e as Error).message}`);
      }
      return { exitCode: 0, stdout: `acked ${parsed.data.length}\n` };
    },
  });

  const status = cliCommand({
    summary: "Jira snapshot age, pending ops and recent results",
    async run() {
      const s = jiraSettings(await deps.settings());
      const { snapshot, ageMs, stale, error } = await store.readSnapshot();
      const ops = await store.pendingOps();
      const lines = [
        snapshot === null
          ? `snapshot: none${error ? ` (last refresh failed: ${error})` : ""}`
          : `snapshot: ${snapshot.ok ? "ok" : `error: ${snapshot.error}`}${stale ? " (stale)" : ""}, age ${ageMs === null ? "?" : `${Math.floor(ageMs / 1000)}s`}`,
        `pending ops: ${ops.length}`,
        ...(await store.recentResults(5)).map((r) => `result ${r.id}: ${r.ok ? `ok${r.createdKey ? ` ${r.createdKey}` : ""}` : `error ${r.error}`}`),
      ];
      return { exitCode: 0, stdout: lines.join("\n") + "\n" };
    },
  });

  const setup = cliCommand({
    summary: "Print (not run) the automation command that schedules the sync script",
    async run() {
      const s = jiraSettings(await deps.settings());
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const repo = deps.repoDir ?? PLACEHOLDER_REPO;
      const cmd =
        `bb automation create --project ${BB_PERSONAL_PROJECT_ID} --name "Focus Board Jira sync" ` +
        `--cron "*/${s.refreshMinutes} * * * *" --timezone ${tz} ` +
        `--script-file ${repo}/scripts/jira-sync.mjs --interpreter node ` +
        `--working-directory automation-storage --timeout 5m`;
      return { exitCode: 0, stdout: cmd + "\n" };
    },
  });

  const dismissed = async () => {
    const raw = await bb.storage.kv.get(DISMISSED_KEY);
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  };
  async function planWithInputs() {
    const s = jiraSettings(await deps.settings());
    const { snapshot } = await store.readSnapshot();
    const links = Object.fromEntries((await deps.liveLinks()).map((t) => [t.id, t.links]));
    const threads = await deps.reconThreads();
    const now = Date.now();
    const prs = snapshot?.prs ?? [];
    const plan = planReconcile({ threads, links, prs, snapshot, projects: s.projects, now, staleTicketDays: s.staleTicketDays });
    const gone = await dismissed();
    plan.suggestions = plan.suggestions.filter((x) => !gone.has(`${x.threadId} ${x.key}`));
    return { plan: { ...plan, generatedAt: new Date(now).toISOString() } as StoredReconcilePlan, s, snapshot, links, threads, prs };
  }
  const freshPlan = async (): Promise<StoredReconcilePlan> => (await planWithInputs()).plan;
  // Board links go through server.ts's link_set path; a key the thread
  // already links (any external link for it) is left as the operator set it.
  const linkWriter = async (threadId: string, key: string, source: ThreadLink["source"] = "auto") => {
    if ((await deps.readLinks(threadId)).some((l) => externalJiraKey(l) === key)) return;
    const link = makeExternalLink(jiraBrowseUrl(key), key, source, new Date());
    await deps.addLink(threadId, { ...link, jira: { key } });
  };
  /** The operator's link: board chip plus an appended record link. */
  const operatorLink = async (threadId: string, key: string) => {
    await linkWriter(threadId, key, "operator");
    await store.updateThread(threadId, () => ({ links: [{ key, role: "owner", source: "operator" }] }));
  };
  // Every PLAN_KEY write (apply, plan refresh) runs on one chain, so the
  // start check, a settings flip and an RPC never interleave.
  let applying: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = applying.then(task);
    applying = run.catch(() => undefined);
    return run;
  };
  const reconcileApply = (opts?: { resetEnrollment?: boolean }): Promise<AppliedPlan> =>
    serial(async () => {
      const plan = await freshPlan();
      const { failed } = await applyReconcile(plan, store, linkWriter, Date.parse(plan.generatedAt), opts);
      for (const f of failed) bb.log.warn(`jira reconcile: thread ${f.threadId} ${f.stage} failed: ${f.error}`);
      await bb.storage.kv.set(PLAN_KEY, plan);
      bb.realtime.publish(JIRA_RECONCILE_CHANGED, { generatedAt: plan.generatedAt });
      return { ...plan, failed };
    });
  // An operator-requested apply (CLI --confirm, RPC) needs the feature on:
  // enrolling while it is off would make the later enable nudge at once.
  const OFF = "Jira is off — enable it first; the dry run works without it";
  const enabled = async () => jiraSettings(await deps.settings()).enabled;

  // Once per false→true flip of jiraEnabled: checked at load (a flip while
  // unloaded) and on every settings change. Turning it off re-arms. A flip
  // re-enrolls every thread at now, so time spent off never counts.
  let checking: Promise<unknown> = Promise.resolve();
  const checkFirstEnable = (): Promise<unknown> =>
    (checking = checking.then(async () => {
      const on = await enabled();
      const seen = (await bb.storage.kv.get(ENABLED_SEEN_KEY)) === true;
      if (!on) {
        if (seen) await bb.storage.kv.set(ENABLED_SEEN_KEY, false);
        return;
      }
      if (seen) return;
      const { failed } = await reconcileApply({ resetEnrollment: true });
      // A thread left un-reset could be nudged at once: retry on next start.
      if (failed.some((f) => f.stage === "enroll")) {
        bb.log.warn("jira reconcile on enable: some enrollments failed; will retry on next start");
        return;
      }
      await bb.storage.kv.set(ENABLED_SEEN_KEY, true);
    }).catch((e) => bb.log.warn(`jira reconcile on enable failed: ${(e as Error).message}`)));
  checkFirstEnable().catch(() => undefined);

  /** Link or dismiss: the suggestion leaves the stored plan (dismissals also stick in DISMISSED_KEY). */
  const dropSuggestion = (threadId: string, key: string, remember: boolean) =>
    serial(async () => {
      if (remember) await bb.storage.kv.set(DISMISSED_KEY, [...(await dismissed()), `${threadId} ${key}`]);
      const stored = StoredReconcilePlan.safeParse(await bb.storage.kv.get(PLAN_KEY));
      if (!stored.success) return;
      const suggestions = stored.data.suggestions.filter((x) => !(x.threadId === threadId && x.key === key));
      await bb.storage.kv.set(PLAN_KEY, { ...stored.data, suggestions });
      bb.realtime.publish(JIRA_RECONCILE_CHANGED, { generatedAt: stored.data.generatedAt });
    });

  // Check-then-enqueue on one chain: a double click (or two windows) queues
  // a fix once; the second press sees the first's ops still pending.
  type ColumnResult = { ok: boolean; error?: string; alreadyQueued?: true };
  let queueing: Promise<unknown> = Promise.resolve();
  const onceQueued = (isQueued: (ops: QueueOp[]) => boolean, task: () => Promise<ColumnResult>): Promise<ColumnResult> => {
    const run = queueing.then(async () => (isQueued(await store.pendingOps()) ? { ok: true, alreadyQueued: true as const } : task()));
    queueing = run.catch(() => undefined);
    return run;
  };

  // Drift fixes re-derive the drift server-side: a stale board cannot queue a write.
  const fixDrift = (key: string, kind: DriftItem["kind"]): Promise<ColumnResult> =>
    onceQueued((ops) => fixQueued(ops, key, kind), async () => {
      const { plan, s, links, threads, prs } = await planWithInputs();
      if (!plan.drift.some((d) => d.key === key && d.kind === kind)) return { ok: false, error: "no such drift" };
      if (kind === "todo-with-prs") {
        const ids = new Set(plan.autoLinks.filter((l) => l.key === key).map((l) => l.threadId));
        const linked = threads.filter((t) => ids.has(t.id)).map((t) => ({ id: t.id, done: t.done, prs: threadPrsOf(t, links[t.id] ?? [], prs) }));
        await store.enqueue({ op: "transition", key, toCategory: "indeterminate", threadId: null });
        const body = ["Focus Board: moving this to In Progress. Linked threads already have these pull requests:", ...livePrs(linked).map(prUrl)].join("\n");
        await store.enqueue({ op: "comment", key, body, threadId: null });
      } else {
        const body = `Focus Board: giving this ticket back. It had no Jira activity for ${s.staleTicketDays} days or more and no linked work, so I am unassigning myself.`;
        await store.enqueue({ op: "comment", key, body, threadId: null });
        await store.enqueue({ op: "assign", key, to: "none", threadId: null });
      }
      return { ok: true };
    });

  // Every linked thread is Done but the ticket is open: the Done ticket update
  // (lib/jira-done-check ticketUpdate), queued once. The Done-summary prefix
  // keeps the per-thread Done dedupe matching it.
  const fixAllDone = (key: string): Promise<ColumnResult> =>
    onceQueued(
      (ops) => ops.some((o) => "key" in o && o.key === key && ((o.op === "comment" && o.body.startsWith(DONE_SUMMARY_PREFIX)) || (o.op === "transition" && o.toCategory === "done"))),
      async () => {
        const { plan, links, threads, prs, snapshot } = await planWithInputs();
        const t = snapshot?.tickets.find((x) => x.key === key);
        if (!t || !plan.drift.some((d) => d.key === key && d.kind === "all-done-still-open")) return { ok: false, error: "no such drift" };
        const ids = new Set(plan.autoLinks.filter((l) => l.key === key).map((l) => l.threadId));
        const linked = threads.filter((x) => ids.has(x.id));
        const roles = await Promise.all(linked.map(async (x) => (await store.readThread(x.id)).links.find((l) => l.key === key)?.role ?? "owner"));
        const summary = doneSummary({
          title: linked.map((x) => x.title).join(", "),
          prUrls: livePrs(linked.map((x) => ({ id: x.id, done: x.done, prs: threadPrsOf(x, links[x.id] ?? [], prs) }))).map(prUrl),
          childKeys: [],
          skipped: false,
        });
        // Stale ticket data: comment only, never a blind transition.
        const ops: NewQueueOp[] = (await store.readSnapshot()).stale
          ? [{ op: "comment", key, body: summary, threadId: null }]
          : ticketUpdate({ ticket: t, linkedThreadsDone: linked.map((x) => x.done), role: roles.includes("owner") ? "owner" : "watching", skipped: false, summary });
        for (const op of ops) await store.enqueue(op);
        return { ok: true };
      },
    );

  deps.onSettingsChange?.(() => {
    refreshCfg().catch(cfgFailed);
    checkFirstEnable().catch(() => undefined);
  });

  const ownerKey = (rec: ThreadJiraRecord) => (rec.links.find((l) => l.role === "owner") ?? rec.links[0])?.key;
  const toolText = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError: true as const } : {}) });
  const TOOL_OFF = "Jira is off (the jiraEnabled setting is false); nothing was written.";
  const prefixTitle = async (threadId: string, key: string) => {
    try {
      const row = await bb.sdk.threads.get({ threadId });
      const title = row.title ?? row.titleFallback ?? "";
      if (title !== "" && titleWithKey(title, key) !== title) await bb.sdk.threads.update({ threadId, title: titleWithKey(title, key) });
    } catch (e) {
      bb.log.warn(`jira: cannot retitle ${threadId}: ${(e as Error).message}`);
    }
  };

  registerTool({
    name: JIRA_LINK_TOOL,
    description:
      "Link this bb thread to its Jira ticket once the operator chose it. role \"owner\" when the operator works it (claimed: whether you assigned it to the operator), \"watching\" when someone else owns it (pass ownerName). Prefixes the thread title with the key.",
    parameters: JiraLinkParams,
    execute: async ({ key, role, ownerName, claimed }, ctx) => {
      if (!(await enabled())) return toolText(TOOL_OFF, true);
      await linkWriter(ctx.threadId, key, "agent");
      await store.updateThread(ctx.threadId, () => ({ links: [{ key, role, source: "agent" }], ...(role === "watching" ? { checkInWith: ownerName ?? null } : {}) }));
      await prefixTitle(ctx.threadId, key);
      if (role === "watching") {
        return toolText(`Linked ${JSON.stringify(key)} as watching. ${JSON.stringify(ownerName)} owns it: stop work on this thread now and tell the operator to check in with them. Make no Jira write.`);
      }
      return toolText(
        `Linked ${JSON.stringify(key)} as owner. Put it in branch names and PR titles.` +
          (claimed ? "" : " It is not claimed yet: assign it to the operator and move it to In Progress with acli once the operator agrees."),
      );
    },
  });

  // A parent whose ticket is not an epic and has 2+ children gets the card's
  // "Promote <key> to an epic?" offer. Snapshot-confirmed non-epics only.
  // ponytail: re-offered after a click if the ticket is still not an epic at the next spawn; add a "declined" marker if that nags.
  const maybeSuggestEpic = async (parentId: string) => {
    const rec = await store.readThread(parentId);
    const key = ownerKey(rec);
    if (key === undefined || rec.epicSuggested) return;
    const t = (await store.readSnapshot()).snapshot?.tickets.find((x) => x.key === key);
    if (!t || t.isEpic) return;
    const kids = (await bb.sdk.threads.list({})).filter((r) => r.parentThreadId === parentId && r.archivedAt === null);
    if (kids.length >= 2) await store.updateThread(parentId, () => ({ epicSuggested: true }));
  };

  registerTool({
    name: JIRA_SPAWN_TOOL,
    description:
      "Spawn a child bb thread under this one, already linked to its Jira ticket. Create the child's ticket with acli first (after the operator confirmed it) and pass its key as ticketKey.",
    parameters: SpawnChildParams,
    execute: async ({ title, prompt, ticketKey }, ctx) => {
      if (!(await enabled())) return toolText(TOOL_OFF, true);
      // A complete record: lib/jira-store parses a partial one as empty.
      const jira: ThreadJiraRecord = {
        links: [{ key: ticketKey, role: "owner", source: "agent" }],
        enrolledAt: new Date().toISOString(),
        verifying: null,
        doneCheck: null,
        nudgedAt: null,
        deepCheckedAt: null,
        reason: null,
        checkInWith: null,
      };
      const child = await bb.sdk.threads.spawn({
        projectId: ctx.projectId,
        environment: { type: "project-default" },
        parentThreadId: ctx.threadId,
        title: titleWithKey(title, ticketKey),
        prompt,
        pluginMetadata: { jira },
      });
      try {
        await linkWriter(child.id, ticketKey, "agent");
      } catch (e) {
        bb.log.warn(`jira: child ${child.id} board link failed: ${(e as Error).message}`);
      }
      try {
        await maybeSuggestEpic(ctx.threadId);
      } catch (e) {
        bb.log.warn(`jira: epic suggestion check failed: ${(e as Error).message}`);
      }
      return toolText(`Spawned child thread ${child.id}, linked to ${JSON.stringify(ticketKey)}.`);
    },
  });

  // ---- The Done check: a Done drop (or `done mark`) while on is a request. ----
  const isoNow = () => new Date().toISOString();
  const isDone = deps.isDone ?? (async () => false);
  const markDone = deps.markDone ?? (async () => {});
  const notDone = (threadId: string) => deps.notDone?.(threadId);

  /** What the check and the ticket comment read about one thread. */
  const doneFacts = async (threadId: string) => {
    const rows = await bb.sdk.threads.list({});
    const listed = rows.find((r) => r.id === threadId);
    const row = listed ?? (await bb.sdk.threads.get({ threadId }));
    const links = await deps.readLinks(threadId);
    const { snapshot, stale } = await store.readSnapshot();
    const all = snapshot?.prs ?? [];
    const prs = threadPrsOf({ branch: listed?.environmentBranchName ?? null }, links, all);
    // A board-linked PR the snapshot lacks is missing data, never "no PRs".
    const missing = links.some((l) => l.tracker === "github" && l.kind === "pull" && !all.some((p) => p.repo === l.repo && p.number === l.issue));
    const kids = rows.filter((r) => r.parentThreadId === threadId && r.archivedAt === null);
    const children = await Promise.all(
      kids.map(async (r) => ({ id: r.id, title: r.title ?? r.titleFallback ?? r.id, keys: (await store.readThread(r.id)).links.map((l) => l.key) })),
    );
    return { rows, title: row.title ?? row.titleFallback ?? threadId, prs, stale: stale || missing, snapshot, children };
  };

  // Done-check decisions and card actions run one at a time per thread: a
  // double click sees the first's write, and Keep working beats an in-flight check.
  const threadChains = new Map<string, Promise<unknown>>();
  const perThread = <T>(threadId: string, task: () => Promise<T>): Promise<T> => {
    const run = (threadChains.get(threadId) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => undefined);
    threadChains.set(threadId, tail);
    void tail.then(() => threadChains.get(threadId) === tail && threadChains.delete(threadId));
    return run;
  };

  /** Inside perThread: is the check that started at startedAt still the running one? Logs when not. */
  const stillChecking = async (threadId: string, startedAt: string, what: string) => {
    if ((await store.readThread(threadId)).verifying?.startedAt === startedAt) return true;
    bb.log.info(`jira: Done check on ${threadId} ended before its ${what}; nothing written`);
    return false;
  };

  const failCheck = async (threadId: string, reasons: string[]) => {
    await store.updateThread(threadId, () => ({ verifying: null, doneCheck: { at: isoNow(), verdict: "fail", reasons }, reason: reasons.join("; ") }));
    await setSent(threadId, null);
    notDone(threadId);
  };

  // Comment (and maybe transition) on every linked ticket, once: a second
  // Done while the first's Done ops are un-acked queues nothing.
  const queueTicketUpdate = (threadId: string, skipped: boolean) =>
    onceQueued(
      (ops) =>
        ops.some(
          (o) => o.threadId === threadId && ((o.op === "comment" && o.body.startsWith(DONE_SUMMARY_PREFIX)) || (o.op === "transition" && o.toCategory === "done")),
        ),
      async () => {
        const rec = await store.readThread(threadId);
        if (rec.links.length === 0) return { ok: true };
        const f = await doneFacts(threadId);
        const summary = doneSummary({
          title: f.title,
          prUrls: f.prs.filter((p) => p.state !== "closed").map(prUrl),
          childKeys: f.children.flatMap((c) => c.keys),
          skipped,
        });
        const live = f.rows.filter((r) => r.archivedAt === null);
        for (const l of rec.links) {
          // Unknown or stale ticket data: comment only, never a blind transition.
          const t = f.stale ? undefined : f.snapshot?.tickets.find((x) => x.key === l.key);
          let ops: NewQueueOp[] = [{ op: "comment", key: l.key, body: summary, threadId: null }];
          if (t) {
            const linkedThreadsDone: boolean[] = [];
            for (const r of live) if ((await store.readThread(r.id)).links.some((x) => x.key === l.key)) linkedThreadsDone.push(await isDone(r.id));
            ops = ticketUpdate({ ticket: t, linkedThreadsDone, role: l.role, skipped, summary });
          }
          for (const op of ops) await store.enqueue({ ...op, threadId });
        }
        return { ok: true };
      },
    );

  /** The final Done: stamp, queue the ticket update, then record the verdict
   *  (a crash before the last write leaves `verifying`, so the resumed check re-queues; onceQueued dedupes). */
  const finishDone = async (threadId: string, skipped: boolean) => {
    await markDone(threadId);
    await queueTicketUpdate(threadId, skipped);
    await store.updateThread(threadId, () => ({
      verifying: null,
      reason: null,
      doneCheck: { at: isoNow(), verdict: "pass", reasons: [], ...(skipped ? { skipped: true as const } : {}) },
    }));
    await setSent(threadId, null);
  };

  // The marker is set before sending, since the new turn's configure must offer
  // the tool, and cleared when nothing was sent. A send that throws keeps
  // `verifying` and retries on the next idle (not at once: no loop).
  const verifyTurn = async (threadId: string) => {
    const rec = await store.readThread(threadId);
    if (!(await enabled()) || !rec.verifying || awaitingVerdict(threadId, rec)) return;
    await setSent(threadId, rec.verifying.startedAt);
    try {
      if ((await turnOrWait(threadId, "verify-turn", verifyTurnText())) !== "sent") await setSent(threadId, null);
    } catch (e) {
      await setSent(threadId, null);
      bb.log.warn(`jira: verify turn on ${threadId} not sent, retrying on next idle: ${(e as Error).message}`);
      await idle.waitFor(threadId, "verify-turn", undefined, { nextIdle: true });
    }
  };

  const runCheck = async (threadId: string) => {
    const startedAt = (await store.readThread(threadId)).verifying?.startedAt;
    if (!(await enabled()) || startedAt === undefined) return;
    const f = await doneFacts(threadId);
    const m = evaluateMechanical({ prs: f.prs, children: f.children.map((c) => ({ id: c.id, title: c.title, linked: c.keys.length > 0 })), snapshotStale: f.stale });
    // verifyTurn re-reads verifying itself and must stay outside perThread
    // (its waitFor can run this thread's jobs, which would wait on the lock).
    if (m.verdict === "needs-agent") return verifyTurn(threadId);
    await perThread(threadId, async () => {
      if (!(await stillChecking(threadId, startedAt, m.verdict === "pass" ? "Done stamp" : "fail"))) return;
      if (m.verdict === "pass") await finishDone(threadId, false);
      else await failCheck(threadId, m.reasons);
    });
  };
  const registered = Promise.all([idle.register("done-check", runCheck), idle.register("verify-turn", verifyTurn)]);

  /** done=true while on. An already-Done thread re-stamps as upstream (never checked). */
  const startDoneCheck = async (threadId: string): Promise<"done" | "checking"> => {
    if (await isDone(threadId)) {
      await markDone(threadId);
      return "done";
    }
    await perThread(threadId, () => store.updateThread(threadId, () => ({ verifying: { startedAt: isoNow() }, doneCheck: null, reason: null })));
    await idle.waitFor(threadId, "done-check"); // runs now when idle, else on the next idle (outside perThread: runCheck takes it)
    return (await isDone(threadId)) ? "done" : "checking";
  };

  // Jobs are taken before their handler runs, so a restart mid-check can
  // leave `verifying` with no job: re-queue those. After the register sweeps
  // (they run queued jobs), and never for a check whose verify turn was sent.
  const resumeChecks = async () => {
    await registered;
    await sentLoaded;
    if (!(await enabled())) return;
    for (const { id } of await deps.liveLinks()) {
      const rec = await store.readThread(id);
      if (!rec.verifying || awaitingVerdict(id, rec) || (await idle.queued(id, ["done-check", "verify-turn"]))) continue;
      await idle.waitFor(id, "done-check");
    }
  };
  resumeChecks().catch((e) => bb.log.warn(`jira: resuming Done checks failed: ${(e as Error).message}`));

  const confirmDone = async (threadId: string, skip: boolean): Promise<{ ok: boolean; error?: string }> => {
    const rec = await store.readThread(threadId);
    if (rec.doneCheck?.verdict === "pass" && (await isDone(threadId))) return { ok: false, error: "already done" };
    if (!skip && rec.doneCheck?.verdict !== "pending-confirm") return { ok: false, error: "nothing to confirm" };
    await finishDone(threadId, skip);
    return { ok: true };
  };

  /** Drop one fail reason by value; none left means the operator can confirm. */
  const dropReason = (threadId: string, reason: string) =>
    store.updateThread(threadId, (cur) => {
      const all = cur.doneCheck?.reasons ?? [];
      const at = all.indexOf(reason);
      if (at === -1) return {};
      const left = all.filter((_, i) => i !== at);
      if (left.length === 0) return { reason: null, doneCheck: { at: isoNow(), verdict: "pending-confirm", reasons: [] } };
      return { reason: left.join("; "), doneCheck: { ...cur.doneCheck!, reasons: left } };
    });

  /** Keep working's write (inside perThread): a running, pending or failed check ends with no stamp. False when none was open. */
  const endCheck = async (threadId: string) => {
    const rec = await store.readThread(threadId);
    const open = rec.verifying != null || rec.doneCheck?.verdict === "pending-confirm" || rec.doneCheck?.verdict === "fail";
    if (!open) return false;
    await store.writeThread(threadId, { verifying: null, reason: null, doneCheck: null });
    await setSent(threadId, null);
    return true;
  };

  // A sent verify turn's run starts at its thread.active; the rest after it with no
  // verdict ends the check (a rest seen before that active is an earlier turn's).
  // ponytail: in memory, so a restart mid-turn leaves the card verifying until Keep working; persist if that bites.
  const verifyRunning = new Map<string, string>();
  const NO_VERDICT = "no verdict from the agent — use Keep working or Mark done anyway";
  const onVerifyActive = (threadId: string) => {
    const sent = verifySent.get(threadId);
    if (sent !== undefined) verifyRunning.set(threadId, sent);
  };
  const onVerifyRest = async (threadId: string) => {
    const startedAt = verifyRunning.get(threadId);
    if (startedAt === undefined) return;
    verifyRunning.delete(threadId);
    if (!cfg.enabled) return;
    await perThread(threadId, async () => {
      const rec = await store.readThread(threadId);
      if (rec.verifying?.startedAt === startedAt && awaitingVerdict(threadId, rec)) await failCheck(threadId, [NO_VERDICT]);
    });
  };
  const logVerify = (e: unknown) => bb.log.warn(`jira: verify turn end failed: ${(e as Error).message}`);
  bb.events.on("thread.active", ({ thread }) => onVerifyActive(thread.id));
  bb.events.on("thread.idle", ({ thread }) => void onVerifyRest(thread.id).catch(logVerify));
  bb.events.on("thread.failed", ({ thread }) => void onVerifyRest(thread.id).catch(logVerify));

  /** Card actions on a running or failed check (serialized per thread). */
  const doneAction = (kind: "confirm-done" | "skip-done" | "keep-working" | "not-needed" | "spin-off", threadId: string, index?: number, expected?: string) =>
    perThread(threadId, async (): Promise<{ ok: boolean; error?: string }> => {
      if (kind === "confirm-done" || kind === "skip-done") return confirmDone(threadId, kind === "skip-done");
      if (kind === "keep-working") {
        if (!(await endCheck(threadId))) return { ok: false, error: "no Done check to stop" };
        notDone(threadId);
        return { ok: true };
      }
      const reason = index === undefined ? undefined : (await store.readThread(threadId)).doneCheck?.reasons[index];
      if (reason === undefined || (expected !== undefined && expected !== reason)) return { ok: false, error: "no such reason" };
      if (kind === "spin-off") {
        // Sent now or refused: a queued spin-off could be overwritten by the next one.
        try {
          const r = await sendIfIdle(bb.sdk.threads as never, threadId, spinOffText(reason), { log: (m) => bb.log.warn(m) });
          if (r === "busy") return { ok: false, error: "thread is busy — try after this turn" };
          if (r === "gone") return { ok: false, error: "thread gone" };
        } catch (e) {
          return { ok: false, error: `not sent: ${(e as Error).message}` };
        }
      }
      await dropReason(threadId, reason);
      return { ok: true };
    });

  registerTool({
    name: JIRA_VERDICT_TOOL,
    description:
      "Report the Done check for this thread: verdict \"pass\" when the work it set out to do is finished, \"fail\" with what is left in remaining. Offered only after a Done check asked for it.",
    parameters: z.object({ verdict: z.enum(["pass", "fail"]), remaining: z.array(z.string()) }),
    execute: async ({ verdict, remaining }, ctx) => {
      if (!(await enabled())) return toolText(TOOL_OFF, true);
      // Checked and written under the thread's lock: a Keep working click wins.
      return perThread(ctx.threadId, async () => {
        if (!awaitingVerdict(ctx.threadId, await store.readThread(ctx.threadId))) {
          return toolText("No Done check is waiting on a verdict from this thread; nothing was written.", true);
        }
        if (verdict === "pass") {
          await store.updateThread(ctx.threadId, () => ({ verifying: null, doneCheck: { at: isoNow(), verdict: "pending-confirm", reasons: [] } }));
          await setSent(ctx.threadId, null);
          return toolText("Recorded. The operator confirms Done on the board; nothing else to do.");
        }
        const reasons = capReasons(remaining);
        await failCheck(ctx.threadId, reasons.length > 0 ? reasons : ["the agent reported work left"]);
        return toolText("Recorded. The thread stays open with those items for the operator.");
      });
    },
  });

  // ---- Reminders: the nudge turn (day n) and the deeper check (day m). ----
  const warn = (m: string) => bb.log.warn(m);
  /** A KV-mirrored map: changes run in order after the load, so none is dropped or resurrected. */
  const persisted = <T>(key: string) => {
    const map = new Map<string, T>();
    const loaded = bb.storage.kv
      .get(key)
      .then((raw) => {
        if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) map.set(k, v as T);
      })
      .catch((e) => warn(`jira: ${key} unreadable: ${(e as Error).message}`));
    let chain: Promise<unknown> = loaded;
    const set = (id: string, v: T | undefined) => {
      const run = chain.then(() => {
        if (v === undefined) map.delete(id);
        else map.set(id, v);
        return bb.storage.kv.set(key, Object.fromEntries(map));
      });
      chain = run.catch(() => undefined);
      return run;
    };
    return { loaded, map, set };
  };
  // "sent" set first, since its thread.active may arrive before sendIfIdle returns; "running" on that
  // active, "replied" on the next rest. Kept until real activity: until then the thread's last
  // activity is the one from before the nudge (the nudge turn and its markUnread bump updatedAt),
  // so the deeper check still counts from the pre-nudge quiet start. `at` is the nudge time.
  type NudgeTurn = { phase: "sent" | "running" | "replied"; lastActivityAt: number; at: number };
  const MARKER_TTL_MS = 3_600_000; // a sent/running marker older than this never captures a reply
  const awaitingReply = (t: NudgeTurn | undefined): t is NudgeTurn =>
    t !== undefined && (t.phase === "sent" || t.phase === "running") && Date.now() - t.at < MARKER_TTL_MS;
  const nudgeTurns = persisted<NudgeTurn>(NUDGE_TURNS_KEY);
  const snoozeSeen = persisted<number>(SNOOZE_SEEN_KEY);
  const nextSteps = persisted<z.infer<typeof NextStep>>(NEXT_STEPS_KEY);

  /** New activity or an operator click: the reason line goes (never mid-check). */
  const clearReason = (threadId: string) =>
    perThread(threadId, async () => {
      const rec = await store.readThread(threadId);
      if (rec.reason !== null && rec.verifying === null) await store.writeThread(threadId, { reason: null });
    });
  const onActive = async (threadId: string) => {
    if (!cfg.enabled) return;
    await nudgeTurns.loaded;
    const t = nudgeTurns.map.get(threadId);
    if (awaitingReply(t) && t.phase === "sent") return void (await nudgeTurns.set(threadId, { ...t, phase: "running" })); // the nudge turn itself
    // Anything else (a second active while running, a stale marker, after the reply) is real activity.
    if (t) await nudgeTurns.set(threadId, undefined);
    await clearReason(threadId);
  };
  /** The rest after a sent nudge: the reply's first line is the reason. */
  const onRest = async (threadId: string, text: string | null) => {
    if (!cfg.enabled) return;
    await nudgeTurns.loaded;
    const t = nudgeTurns.map.get(threadId);
    if (t === undefined || t.phase === "replied") return;
    await nudgeTurns.set(threadId, { ...t, phase: "replied" });
    const line = awaitingReply(t) ? replyLine(text) : null;
    if (line === null) return;
    await perThread(threadId, async () => {
      const cur = await store.readThread(threadId);
      // A Done check started (or failed) since the nudge owns the reason line.
      if (cur.verifying !== null || cur.doneCheck?.verdict === "fail") return;
      await store.writeThread(threadId, { reason: line });
    });
  };
  const logFail = (what: string) => (e: unknown) => warn(`jira reminders: ${what} failed: ${(e as Error).message}`);
  bb.events.on("thread.active", ({ thread }) => void onActive(thread.id).catch(logFail("activity")));
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => void onRest(thread.id, lastAssistantText).catch(logFail("reply capture")));
  bb.events.on("thread.failed", ({ thread }) => void onRest(thread.id, null).catch(logFail("reply capture")));

  /** One nudge: only an idle thread gets it; busy or a throw leaves it un-nudged for the next pass. */
  const nudge = async (threadId: string, lastActivityAt: number, unlinked: boolean): Promise<boolean> => {
    const prev = nudgeTurns.map.get(threadId);
    await nudgeTurns.set(threadId, { phase: "sent", lastActivityAt, at: Date.now() });
    let r: "sent" | "busy" | "gone" = "busy";
    try {
      r = await sendIfIdle(bb.sdk.threads as never, threadId, NUDGE_TEXT, { log: warn });
    } catch (e) {
      warn(`jira: nudge on ${threadId} not sent, retrying next pass: ${(e as Error).message}`);
    }
    if (r !== "sent") {
      await nudgeTurns.set(threadId, prev);
      return false;
    }
    // Only after a sent turn: markUnread bumps updatedAt (the marker keeps the pre-nudge clock).
    await bb.sdk.threads.markUnread({ threadId }).catch(logFail(`markUnread on ${threadId}`));
    try {
      await perThread(threadId, () =>
        store.updateThread(threadId, (cur) => ({
          nudgedAt: isoNow(),
          // A reply that already landed (or a Done check started since) keeps its reason.
          ...(cur.verifying !== null || cur.doneCheck?.verdict === "fail" || nudgeTurns.map.get(threadId)?.phase === "replied"
            ? {}
            : { reason: unlinked ? "no ticket yet" : "waiting on you" }),
        })),
      );
    } catch (e) {
      // The marker still counts as nudged (pass input), so no second nudge.
      warn(`jira: nudgedAt write on ${threadId} failed: ${(e as Error).message}`);
    }
    return true;
  };

  const ms = (iso: string | null) => {
    const v = iso === null ? NaN : Date.parse(iso);
    return Number.isNaN(v) ? null : v;
  };
  const laterOf = (a: number | null, b: number | undefined) => (a === null && b === undefined ? null : Math.max(a ?? -Infinity, b ?? -Infinity));
  let passing = false; // one pass at a time: an overlapping tick is skipped
  const reminderPass = async () => {
    if (passing) return;
    passing = true;
    try {
      const s = jiraSettings(await deps.settings());
      if (!s.enabled || !deps.reminderThreads) return;
      await Promise.all([nudgeTurns.loaded, snoozeSeen.loaded, nextSteps.loaded]);
      const now = Date.now();
      const { snapshot, stale } = await store.readSnapshot();
      const allPrs = snapshot?.prs ?? [];
      const facts = new Map<string, { rec: ThreadJiraRecord; prs: typeof allPrs; missing: boolean; lastActivityAt: number }>();
      const threads: ReminderThread[] = [];
      for (const row of await deps.reminderThreads()) {
        const rec = await store.readThread(row.id);
        // Never enrolled (a thread new since the enable): enrolled now, so it gets the grace too.
        if (rec.enrolledAt === null && !row.done) {
          try {
            await store.updateThread(row.id, (cur) => (cur.enrolledAt === null ? { enrolledAt: isoNow() } : {}));
          } catch (e) {
            warn(`jira reminders: enrolling ${row.id} failed, retrying next pass: ${(e as Error).message}`);
          }
        }
        const links = await deps.readLinks(row.id);
        const prs = threadPrsOf({ branch: row.branch }, links, allPrs);
        const missing = links.some((l) => l.tracker === "github" && l.kind === "pull" && !allPrs.some((p) => p.repo === l.repo && p.number === l.issue));
        const tickets = rec.links.flatMap((l) => snapshot?.tickets.find((t) => t.key === l.key) ?? []);
        const changes = [...prs, ...tickets].flatMap((x) => ms(x.updatedAt) ?? []);
        const snoozed = row.snoozeWakeAt !== null && row.snoozeWakeAt > now;
        const seen = snoozeSeen.map.get(row.id);
        if (snoozed && seen !== row.snoozeWakeAt) await snoozeSeen.set(row.id, row.snoozeWakeAt!);
        else if (!snoozed && seen !== undefined && seen > now) await snoozeSeen.set(row.id, now); // cleared early
        const marker = nudgeTurns.map.get(row.id);
        const lastActivityAt = marker?.lastActivityAt ?? row.updatedAt;
        facts.set(row.id, { rec, prs, missing, lastActivityAt });
        threads.push({
          id: row.id, archived: false, done: row.done, snoozed, status: row.status, verifying: rec.verifying !== null,
          checkFailed: rec.doneCheck?.verdict === "fail",
          // The later of the record's and the marker's nudge: a marker is a sent nudge even when its nudgedAt write failed.
          lastActivityAt, enrolledAt: ms(rec.enrolledAt), nudgedAt: laterOf(ms(rec.nudgedAt), marker?.at), deepCheckedAt: ms(rec.deepCheckedAt),
          snoozeWokeAt: snoozed ? null : (snoozeSeen.map.get(row.id) ?? null), linkedChangeAt: changes.length > 0 ? Math.max(...changes) : null,
        });
      }
      // Uncapped here: the cap counts sent turns, so a busy thread does not use a slot.
      const plan = planReminders({ threads, now, nudgeDays: s.nudgeDays, deepCheckDays: s.deepCheckDays, cap: Number.POSITIVE_INFINITY });
      for (const id of plan.deepCheck) {
        const f = facts.get(id)!;
        const found = deepCheckFindings({
          links: f.rec.links,
          snapshot: snapshot && { stale: stale || f.missing, tickets: snapshot.tickets },
          prs: f.prs,
          mentions: snapshot?.mentions ?? [],
          me: snapshot?.me.accountId ?? null,
        });
        const wrote = await perThread(id, async () => {
          const cur = await store.readThread(id);
          if (cur.verifying !== null || cur.doneCheck?.verdict === "fail") return false; // a Done check owns the reason
          await store.writeThread(id, { deepCheckedAt: isoNow(), reason: found.reason });
          return true;
        });
        if (wrote) await nextSteps.set(id, { reason: found.reason, next: found.next as DeepNext, ...(found.prUrl ? { prUrl: found.prUrl } : {}) });
      }
      let sent = 0;
      for (const id of plan.nudge) {
        if (sent >= s.nudgeTurnsPerPass) break;
        const f = facts.get(id)!;
        if (await nudge(id, f.lastActivityAt, f.rec.links.length === 0)) sent++;
      }
    } finally {
      passing = false;
    }
  };
  bb.background.schedule("jira-reminders", "*/5 * * * *", () => reminderPass().catch(logFail("pass")));

  bb.rpc.register(jiraRpcContract, {
    jira_reconcile_plan: () =>
      serial(async () => {
        const stored = StoredReconcilePlan.safeParse(await bb.storage.kv.get(PLAN_KEY));
        if (!stored.success) return freshPlan();
        // A newer snapshot than the stored plan: refresh the dry plan (no apply).
        const { snapshot } = await store.readSnapshot();
        if (snapshot === null || !(Date.parse(snapshot.takenAt) > Date.parse(stored.data.generatedAt))) return stored.data;
        const plan = await freshPlan();
        await bb.storage.kv.set(PLAN_KEY, plan);
        return plan;
      }),
    jira_reconcile_apply: async () => {
      if (!(await enabled())) throw new Error(OFF);
      return reconcileApply();
    },
    jira_board_state: async () => {
      if (!(await enabled())) return { enabled: false, snapshotAge: null, stale: false, error: null, tickets: [], threads: {}, pending: {}, next: {} };
      const { snapshot, ageMs, stale, error } = await store.readSnapshot();
      const threads: Record<string, ThreadJiraRecord> = {};
      for (const { id } of await deps.liveLinks()) threads[id] = await store.readThread(id);
      await nextSteps.loaded;
      const next = Object.fromEntries([...nextSteps.map].filter(([id, n]) => threads[id]?.reason === n.reason));
      return {
        enabled: true,
        snapshotAge: ageMs,
        stale,
        error,
        tickets: snapshot?.tickets ?? [],
        threads,
        pending: Object.fromEntries((await store.pendingOps()).map((o) => [o.id, o])),
        next,
      };
    },
    jira_card_action: async ({ kind, threadId, index, reason }) => {
      if (!(await enabled())) return { ok: false, error: OFF };
      if (!(await deps.liveLinks()).some((t) => t.id === threadId)) return { ok: false, error: "unknown thread" };
      if (kind === "run-done-check") {
        await startDoneCheck(threadId); // clears the reason
        return { ok: true };
      }
      // Every other click outside the Done check clears the reason line.
      if (kind === "dismiss-reason" || kind === "clear-check-in" || kind === "find-ticket" || kind === "promote-epic") await clearReason(threadId);
      if (kind === "dismiss-reason") return { ok: true };
      if (kind === "clear-check-in") {
        await store.writeThread(threadId, { checkInWith: null });
        return { ok: true };
      }
      if (kind === "confirm-done" || kind === "skip-done" || kind === "keep-working" || kind === "not-needed" || kind === "spin-off") {
        return doneAction(kind, threadId, index, reason);
      }
      try {
        if (kind === "find-ticket") {
          const r = await turnOrWait(threadId, "find-ticket", findTicketText(jiraSettings(await deps.settings())));
          return r === "gone" ? { ok: false, error: "thread gone" } : { ok: true };
        }
        const rec = await store.readThread(threadId);
        const key = ownerKey(rec);
        if (!rec.epicSuggested || key === undefined) return { ok: false, error: "no promotion suggested" };
        const r = await turnOrWait(threadId, "promote-epic", promoteEpicText(key), key);
        if (r === "gone") return { ok: false, error: "thread gone" };
        // Cleared once the turn is sent or queued, never before the click.
        await store.updateThread(threadId, () => ({}), ["epicSuggested"]);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `not sent: ${(e as Error).message}` };
      }
    },
    jira_done_confirm: async ({ threadId, skip }) => {
      if (!(await enabled())) return { ok: false, error: OFF };
      if (!(await deps.liveLinks()).some((t) => t.id === threadId)) return { ok: false, error: "unknown thread" };
      return doneAction(skip === true ? "skip-done" : "confirm-done", threadId);
    },
    jira_column_action: async ({ action, key, threadId, kind, confirm }) => {
      if (!(await enabled())) return { ok: false, error: OFF };
      if (action === "fix") {
        if (kind === undefined) return { ok: false, error: "kind required" };
        if (kind === "all-done-still-open") return fixAllDone(key);
        if (kind === "stale-unlinked" && confirm !== true) return { ok: false, error: "confirm required" };
        return fixDrift(key, kind);
      }
      if (threadId === undefined) return { ok: false, error: "threadId required" };
      if (!(await deps.liveLinks()).some((t) => t.id === threadId)) return { ok: false, error: "unknown thread" };
      if (action === "started") {
        await operatorLink(threadId, key);
        return onceQueued((ops) => fixQueued(ops, key, "todo-with-prs"), async () => {
          const t = (await store.readSnapshot()).snapshot?.tickets.find((x) => x.key === key);
          if (t?.statusCategory === "new" && !t.isEpic) await store.enqueue({ op: "transition", key, toCategory: "indeterminate", threadId });
          return { ok: true };
        });
      }
      if (action === "link") await operatorLink(threadId, key);
      await dropSuggestion(threadId, key, action === "dismiss-suggestion");
      return { ok: true };
    },
  });

  const reconcile = cliCommand({
    summary: "Print the reconcile plan for existing threads; --confirm applies it (links + enrollment only)",
    options: { confirm: { type: "boolean", description: "Apply the plan (needs jiraEnabled)" } },
    async run(input) {
      const confirm = input.options.confirm === true;
      if (confirm && !(await enabled())) return fail(OFF);
      const plan = confirm ? await reconcileApply() : await freshPlan();
      return out({ applied: confirm, pendingOps: (await store.pendingOps()).length, plan });
    },
  });

  return {
    commands: { "jira reconcile": reconcile, "jira ingest": ingest, "jira wanted": wanted, "jira queue": queue, "jira ack": ack, "jira status": status, "jira setup": setup },
    store,
    idle,
    /** Whether jiraEnabled is on (done_set / done mark route through the check only then). */
    enabled,
    startDoneCheck,
    /** Leaving Done while on: Keep working's path (no stamp, no ops). */
    stopDoneCheck: (threadId: string) => perThread(threadId, () => endCheck(threadId)).then(() => undefined),
    /** Board links cleared (link_clear): their Jira keys leave the thread's record too. */
    async unlinkCleared(threadId: string, before: ThreadLink[] | null, after: ThreadLink[] | null) {
      const kept = new Set((after ?? []).flatMap((l) => (l.tracker === "external" && l.jira ? [l.jira.key] : [])));
      const gone = (before ?? []).flatMap((l) => (l.tracker === "external" && l.jira && !kept.has(l.jira.key) ? [l.jira.key] : []));
      if (gone.length === 0 || !(await store.readThread(threadId)).links.some((l) => gone.includes(l.key))) return;
      await store.removeLinks(threadId, gone);
    },
    dispose() {},
  };
}
