// Jira integration wiring. This part: the `bb focus-board jira …` CLI bridge
// the companion script (scripts/jira-sync.mjs) talks to. The commands work
// whether or not jiraEnabled is set, and change no board behavior.
import { readFileSync } from "node:fs";
import { cliCommand, type BbPluginApi } from "@get-bb/plugin-sdk";
import { JiraSnapshot, OpResult } from "./jira-schema";
import { jiraSettings } from "./jira-settings";
import { createJiraStore, type JiraStore } from "./jira-store";
import type { ThreadLink } from "./link-metadata";
import { BB_PERSONAL_PROJECT_ID } from "./new-thread-seed";

export type JiraDeps = {
  /** Raw plugin settings values (jira* keys). */
  settings: () => Promise<Record<string, unknown>>;
  /** Linked items of every non-archived thread (server.ts's existing link reader). */
  liveLinks: () => Promise<{ id: string; links: ThreadLink[] }[]>;
  /** Plugin source directory, when the host can say; else a placeholder is printed. */
  repoDir?: string;
};

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
  let refreshMinutes = 2; // refreshed from settings by `status` before it reads the snapshot
  const store: JiraStore = createJiraStore(bb.storage.kv as never, bb.sdk.threads as never, Date.now, {
    refreshMinutes: () => refreshMinutes,
    log: (m) => bb.log.warn(m),
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
      const r = await store.ingestSnapshot(raw);
      return r.ok ? { exitCode: 0, stdout: "ingested\n" } : fail(`invalid snapshot: ${r.error}`);
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
      await store.ack(parsed.data);
      return { exitCode: 0, stdout: `acked ${parsed.data.length}\n` };
    },
  });

  const status = cliCommand({
    summary: "Jira snapshot age, pending ops and recent results",
    async run() {
      const s = jiraSettings(await deps.settings());
      refreshMinutes = s.refreshMinutes;
      const { snapshot, ageMs, stale } = await store.readSnapshot();
      const ops = await store.pendingOps();
      const lines = [
        snapshot === null
          ? "snapshot: none"
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

  return {
    commands: { "jira ingest": ingest, "jira wanted": wanted, "jira queue": queue, "jira ack": ack, "jira status": status, "jira setup": setup },
    store,
    dispose() {},
  };
}
