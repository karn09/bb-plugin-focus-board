// Board-vs-Jira drift for one ticket, given the threads linked to it. Pure;
// planReconcile (lib/jira-reconcile.ts) is the one caller that feeds it.
import type { DriftItem, GhPr, JiraTicket } from "./jira-schema";

export type DriftThread = { id: string; done: boolean; prs: GhPr[] };

const DAY = 86_400_000;

/** Open or merged PRs across the threads, one per repo#number. */
export function livePrs(threads: readonly DriftThread[]): GhPr[] {
  const byRef = new Map<string, GhPr>();
  for (const t of threads) for (const p of t.prs) if (p.state !== "closed") byRef.set(`${p.repo}#${p.number}`, p);
  return [...byRef.values()];
}

export const prUrl = (p: Pick<GhPr, "repo" | "number">) => `https://github.com/${p.repo}/pull/${p.number}`;

export function detectDrift(
  ticket: JiraTicket,
  linkedThreads: readonly DriftThread[],
  now: number,
  staleTicketDays: number,
): DriftItem[] {
  const { key } = ticket;
  const out: DriftItem[] = [];
  const n = linkedThreads.length;
  // Never offered on an epic: its fix would transition it.
  if (ticket.statusCategory === "new" && !ticket.isEpic) {
    const prs = livePrs(linkedThreads);
    if (prs.length > 0) {
      out.push({
        key,
        kind: "todo-with-prs",
        detail: `${ticket.status} in Jira, but ${prs.length} open or merged PR(s) across ${n} linked thread(s): ${prs.map((p) => `${p.repo}#${p.number}`).join(", ")}`,
      });
    }
  }
  if (ticket.statusCategory !== "done" && n > 0 && linkedThreads.every((t) => t.done)) {
    out.push({ key, kind: "all-done-still-open", detail: `All ${n} linked thread(s) are Done, but the ticket is still ${ticket.status}` });
  }
  const idleDays = Math.floor((now - Date.parse(ticket.updatedAt)) / DAY);
  if (ticket.assignedToMe && ticket.statusCategory !== "done" && n === 0 && idleDays >= staleTicketDays) {
    out.push({ key, kind: "stale-unlinked", detail: `No Jira activity for ${idleDays} days and no linked thread` });
  }
  return out;
}
