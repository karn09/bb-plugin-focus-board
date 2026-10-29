// Jira integration wiring. This part: the `bb focus-board jira …` CLI bridge
// the companion script (scripts/jira-sync.mjs) talks to. The commands work
// whether or not jiraEnabled is set, and change no board behavior.
// Also: reconciliation (`jira reconcile`, the jira_reconcile_* RPCs, and the
// one-time run when jiraEnabled flips on).
import { readFileSync } from "node:fs";
import { z } from "zod";
import { cliCommand, defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { createIdleWaiters } from "./jira-idle";
import { jiraBrowseUrl } from "./jira-keys";
import { applyReconcile, externalJiraKey, planReconcile, StoredReconcilePlan, type ReconThread } from "./jira-reconcile";
import { OpResult } from "./jira-schema";
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
};

const PLAN_KEY = "jira:reconcile-plan";
const ENABLED_SEEN_KEY = "jira:enabled-seen";
export const JIRA_RECONCILE_CHANGED = "jira-reconcile-changed";

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
  });
  // Queued idle-gated work (lib/jira-idle.ts). No handlers yet: later
  // features register them, so with nothing registered no job ever runs.
  const idle = createIdleWaiters(bb.storage.kv as never, {}, { threads: bb.sdk.threads as never, log: (m) => bb.log.warn(m) });
  bb.events.on("thread.idle", ({ thread }) => idle.onIdle(thread.id));
  idle.resume().catch((e) => bb.log.warn(`jira idle resume failed: ${(e as Error).message}`));
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

  async function freshPlan(): Promise<StoredReconcilePlan> {
    const s = jiraSettings(await deps.settings());
    const { snapshot } = await store.readSnapshot();
    const links = Object.fromEntries((await deps.liveLinks()).map((t) => [t.id, t.links]));
    const now = Date.now();
    const plan = planReconcile({ threads: await deps.reconThreads(), links, prs: snapshot?.prs ?? [], snapshot, projects: s.projects, now });
    return { ...plan, generatedAt: new Date(now).toISOString() };
  }
  // Board links go through server.ts's link_set path; a key the thread
  // already links (any external link for it) is left as the operator set it.
  const linkWriter = async (threadId: string, key: string) => {
    if ((await deps.readLinks(threadId)).some((l) => externalJiraKey(l) === key)) return;
    const link = makeExternalLink(jiraBrowseUrl(key), key, "auto", new Date());
    await deps.addLink(threadId, { ...link, jira: { key } });
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
  deps.onSettingsChange?.(() => {
    checkFirstEnable().catch(() => undefined);
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
