// Jira integration wiring. This part: the `bb focus-board jira …` CLI bridge
// the companion script (scripts/jira-sync.mjs) talks to. The commands work
// whether or not jiraEnabled is set, and change no board behavior.
// Also: reconciliation (`jira reconcile`, the jira_reconcile_* RPCs, and the
// one-time run when jiraEnabled flips on). And the Jira column's writes
// (jira_column_action): Link / dismiss a suggestion, drift fixes, Start thread.
// And the agent side (lib/jira-agent.ts): the one bb.agents.configure, the
// focus_board_jira_link / focus_board_spawn_child tools, and the find-ticket /
// promote-epic card turns.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { cliCommand, defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { createIdleWaiters, sendIfIdle, type JobKind } from "./jira-idle";
import { findTicketText, JIRA_LINK_TOOL, JIRA_SPAWN_TOOL, jiraConfigure, JiraLinkParams, promoteEpicText, SpawnChildParams, titleWithKey } from "./jira-agent";
import { jiraBrowseUrl } from "./jira-keys";
import { fixQueued, livePrs, prUrl } from "./jira-drift";
import { applyReconcile, externalJiraKey, planReconcile, StoredReconcilePlan, threadPrsOf, type ReconThread } from "./jira-reconcile";
import { DriftItem, JiraTicket, OpResult, QueueOp, ThreadJiraRecord } from "./jira-schema";
import { jiraSettings } from "./jira-settings";
import { createJiraStore, type JiraStore } from "./jira-store";
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
  /** The plugin's other agent tools: the one configure must keep selecting them. */
  agentTools?: string[];
};

const PLAN_KEY = "jira:reconcile-plan";
const ENABLED_SEEN_KEY = "jira:enabled-seen";
/** `${threadId} ${key}` suggestions the operator dismissed; never re-suggested. */
// ponytail: grows by one entry per dismissal, never pruned; prune archived threads if it ever matters.
const DISMISSED_KEY = "jira:dismissed-suggestions";
export const JIRA_RECONCILE_CHANGED = "jira-reconcile-changed";
export const JIRA_CHANGED = "jira-changed";

export const JIRA_CARD_ACTIONS = ["find-ticket", "confirm-done", "skip-done", "spin-off", "keep-working", "not-needed", "clear-check-in", "promote-epic"] as const;

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
    }),
  },
  /** A card button press; kinds whose behavior lands later answer "not yet". */
  jira_card_action: {
    input: z.object({ kind: z.enum(JIRA_CARD_ACTIONS), threadId: z.string() }),
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
  const refreshCfg = () =>
    deps.settings().then((v) => {
      cfg = jiraSettings(v);
    });
  const cfgFailed = (e: unknown) => bb.log.warn(`jira settings read failed: ${(e as Error).message}`);
  refreshCfg().catch(cfgFailed);
  // The plugin's only configure: with one registered, unselected tools are off,
  // so the board's own tools are always selected; Jira's only while enabled.
  bb.agents.configure((context) => {
    const j = jiraConfigure(cfg.enabled, cfg, context.pluginMetadata as Record<string, unknown>);
    return { tools: [...(deps.agentTools ?? []), ...j.tools], skills: [], ...(j.instructions ? { instructions: j.instructions } : {}) };
  });

  /** One card turn: sent now, or queued for the thread's next idle. A throw is "not sent". */
  const turnOrWait = async (threadId: string, kind: JobKind, text: string, payload?: string) => {
    const r = await sendIfIdle(bb.sdk.threads as never, threadId, text, { log: (m) => bb.log.warn(m) });
    if (r === "busy") await idle.waitFor(threadId, kind, payload);
    return r;
  };
  void idle.register("find-ticket", async (threadId) => {
    const s = jiraSettings(await deps.settings());
    if (s.enabled) await turnOrWait(threadId, "find-ticket", findTicketText(s));
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
  const onceQueued = (key: string, kind: DriftItem["kind"], task: () => Promise<ColumnResult>): Promise<ColumnResult> => {
    const run = queueing.then(async () => (fixQueued(await store.pendingOps(), key, kind) ? { ok: true, alreadyQueued: true as const } : task()));
    queueing = run.catch(() => undefined);
    return run;
  };

  // Drift fixes re-derive the drift server-side: a stale board cannot queue a write.
  const fixDrift = (key: string, kind: DriftItem["kind"]): Promise<ColumnResult> =>
    onceQueued(key, kind, async () => {
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

  bb.agents.registerTool({
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

  bb.agents.registerTool({
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
      if (!(await enabled())) return { enabled: false, snapshotAge: null, stale: false, error: null, tickets: [], threads: {}, pending: {} };
      const { snapshot, ageMs, stale, error } = await store.readSnapshot();
      const threads: Record<string, ThreadJiraRecord> = {};
      for (const { id } of await deps.liveLinks()) threads[id] = await store.readThread(id);
      return {
        enabled: true,
        snapshotAge: ageMs,
        stale,
        error,
        tickets: snapshot?.tickets ?? [],
        threads,
        pending: Object.fromEntries((await store.pendingOps()).map((o) => [o.id, o])),
      };
    },
    // Later tasks (10-11) wire the other kinds.
    jira_card_action: async ({ kind, threadId }) => {
      if (!(await enabled())) return { ok: false, error: OFF };
      if (kind !== "clear-check-in" && kind !== "find-ticket" && kind !== "promote-epic") return { ok: false, error: "not yet" };
      if (!(await deps.liveLinks()).some((t) => t.id === threadId)) return { ok: false, error: "unknown thread" };
      if (kind === "clear-check-in") {
        await store.writeThread(threadId, { checkInWith: null });
        return { ok: true };
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
    jira_column_action: async ({ action, key, threadId, kind, confirm }) => {
      if (!(await enabled())) return { ok: false, error: OFF };
      if (action === "fix") {
        if (kind === undefined) return { ok: false, error: "kind required" };
        if (kind === "all-done-still-open") return { ok: false, error: "not yet" }; // Task 10: the Done check.
        if (kind === "stale-unlinked" && confirm !== true) return { ok: false, error: "confirm required" };
        return fixDrift(key, kind);
      }
      if (threadId === undefined) return { ok: false, error: "threadId required" };
      if (!(await deps.liveLinks()).some((t) => t.id === threadId)) return { ok: false, error: "unknown thread" };
      if (action === "started") {
        await operatorLink(threadId, key);
        return onceQueued(key, "todo-with-prs", async () => {
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
    dispose() {},
  };
}
