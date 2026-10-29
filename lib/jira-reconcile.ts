// Reconciliation of existing threads: a pure planner plus an apply that
// writes only board links and enrolledAt. Apply never queues a Jira op,
// never sends a turn and never touches doneCheck: its store parameter is
// typed to readThread/writeThread alone, so it cannot.
import { z } from "zod";
import { extractJiraKeys } from "./jira-keys";
import { DriftItem, type GhPr, type JiraSnapshot } from "./jira-schema";
import type { JiraStore } from "./jira-store";
import type { ThreadLink } from "./link-metadata";

export type ReconThread = {
  id: string;
  title: string;
  branch: string | null;
  status: string;
  archived: boolean;
  done: boolean;
};

export const ReconcilePlan = z.object({
  autoLinks: z.array(z.object({ threadId: z.string(), key: z.string() })),
  suggestions: z.array(z.object({ threadId: z.string(), key: z.string(), why: z.enum(["pr-body", "fuzzy"]) })),
  drift: z.array(DriftItem),
  enroll: z.array(z.string()),
  skippedDone: z.array(z.string()),
});
export type ReconcilePlan = z.infer<typeof ReconcilePlan>;
/** What KV `jira:reconcile-plan` holds. */
export const StoredReconcilePlan = ReconcilePlan.extend({ generatedAt: z.string() });
export type StoredReconcilePlan = z.infer<typeof StoredReconcilePlan>;

/** The Jira key an external board link points at: its jira field, else a /browse/KEY url. */
export function externalJiraKey(link: ThreadLink): string | null {
  if (link.tracker !== "external") return null;
  return link.jira?.key ?? /\/browse\/([A-Z][A-Z0-9]+-\d+)\b/.exec(link.url)?.[1] ?? null;
}

const STOP = new Set(
  "a an and are as at be by for from in into is it of on or the to with up out fix add update new make use via".split(" "),
);
const tokens = (s: string) =>
  new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t) && !/^\d+$/.test(t)));

export function planReconcile(input: {
  threads: ReconThread[];
  links: Record<string, ThreadLink[]>;
  prs: GhPr[];
  snapshot: JiraSnapshot | null;
  projects: string[];
  now: number;
}): ReconcilePlan {
  const { snapshot, projects } = input;
  const known = snapshot ? new Set(snapshot.tickets.map((t) => t.key)) : null;
  const keysIn = (s: string | null | undefined) => (s ? extractJiraKeys(s, projects) : []);
  // Branch names are usually lowercase (pt-3879-fix); only branches are upper-cased.
  const branchKeys = (s: string | null | undefined) => keysIn(s?.toUpperCase());
  const plan: ReconcilePlan = { autoLinks: [], suggestions: [], drift: [], enroll: [], skippedDone: [] };
  const threadPrs = new Map<string, GhPr[]>();

  for (const t of input.threads) {
    if (t.archived) continue;
    plan.enroll.push(t.id);
    if (t.done) plan.skippedDone.push(t.id);
    const links = input.links[t.id] ?? [];
    const existing = links.flatMap((l) => externalJiraKey(l) ?? []).filter((k) => projects.includes(k.split("-")[0]!));
    const auto = [...new Set([...keysIn(t.title), ...branchKeys(t.branch), ...existing])].filter((k) => !known || known.has(k));
    for (const key of auto) plan.autoLinks.push({ threadId: t.id, key });

    const prs = input.prs.filter(
      (p) =>
        (t.branch !== null && p.headRef === t.branch) ||
        links.some((l) => l.tracker === "github" && l.kind === "pull" && l.repo === p.repo && l.issue === p.number),
    );
    threadPrs.set(t.id, prs);
    if (t.done) continue; // Done threads get links and enrollment only.
    const taken = new Set(auto);
    for (const p of prs) {
      for (const key of [...keysIn(p.body), ...keysIn(p.title), ...branchKeys(p.headRef)]) {
        if (taken.has(key)) continue;
        taken.add(key);
        plan.suggestions.push({ threadId: t.id, key, why: "pr-body" });
      }
    }
    // ponytail: plain shared-token count; swap for weighted scoring if suggestions get noisy.
    const title = tokens(t.title);
    for (const tk of snapshot?.tickets ?? []) {
      if (!tk.assignedToMe || taken.has(tk.key)) continue;
      let shared = 0;
      for (const w of tokens(tk.summary)) if (title.has(w)) shared++;
      if (shared >= 3) {
        taken.add(tk.key);
        plan.suggestions.push({ threadId: t.id, key: tk.key, why: "fuzzy" });
      }
    }
  }

  for (const tk of snapshot?.tickets ?? []) {
    if (tk.statusCategory !== "new") continue;
    const ids = plan.autoLinks.filter((l) => l.key === tk.key).map((l) => l.threadId);
    const prs = new Map<string, GhPr>();
    for (const id of ids) for (const p of threadPrs.get(id) ?? []) if (p.state !== "closed") prs.set(`${p.repo}#${p.number}`, p);
    if (prs.size > 0) {
      plan.drift.push({
        key: tk.key,
        kind: "todo-with-prs",
        detail: `${tk.status} in Jira, but ${prs.size} open or merged PR(s) across ${ids.length} linked thread(s)`,
      });
    }
  }
  return plan;
}

/** Board link write for one auto-link (server.ts's link_set path). */
export type LinkWriter = (threadId: string, key: string) => Promise<void>;

export type ApplyResult = { failed: { threadId: string; error: string }[] };

/**
 * resetEnrollment (set only by the jiraEnabled false→true trigger): every
 * planned thread is enrolled at `now`, so time spent with the feature off
 * never counts toward a nudge. Otherwise the first enrolledAt is kept.
 * A thread whose writes fail is skipped and reported; the rest still apply.
 */
export async function applyReconcile(
  plan: ReconcilePlan,
  store: Pick<JiraStore, "updateThread">,
  linkWriter: LinkWriter,
  now: number,
  opts?: { resetEnrollment?: boolean },
): Promise<ApplyResult> {
  const at = new Date(now).toISOString();
  const byThread = new Map<string, string[]>(plan.enroll.map((id) => [id, []]));
  for (const { threadId, key } of plan.autoLinks) byThread.set(threadId, [...(byThread.get(threadId) ?? []), key]);
  const failed: ApplyResult["failed"] = [];
  for (const [threadId, keys] of byThread) {
    try {
      for (const key of keys) await linkWriter(threadId, key);
      await store.updateThread(threadId, (cur) => {
        const have = new Set(cur.links.map((l) => l.key));
        return {
          links: keys.filter((k) => !have.has(k)).map((key) => ({ key, role: "owner" as const, source: "auto" as const })),
          enrolledAt: opts?.resetEnrollment === true ? at : (cur.enrolledAt ?? at),
        };
      });
    } catch (e) {
      failed.push({ threadId, error: (e as Error).message });
    }
  }
  return { failed };
}
