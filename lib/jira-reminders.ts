// Reminders for quiet threads (spec §4, D1): the day-n nudge (one tiny
// status turn, sent by lib/jira-server.ts through sendIfIdle) and the
// day-m deeper check (plugin-side, no turn). Pure: the server feeds it.
import { prUrl } from "./jira-drift";
import type { GhPr, JiraSnapshot, JiraTicket } from "./jira-schema";

const DAY = 86_400_000;
const RUNNING = new Set(["active", "starting", "stopping", "pending"]);

export const NUDGE_TEXT = "Focus Board check-in: in one line, what is this thread waiting on? Reply with just that line.";

type Stamps = {
  lastActivityAt: number | null;
  enrolledAt: number | null;
  nudgedAt: number | null;
  deepCheckedAt: number | null;
  snoozeWokeAt: number | null;
  linkedChangeAt: number | null;
};
export type ReminderThread = Stamps & { id: string; archived: boolean; done: boolean; snoozed: boolean; status: string; verifying: boolean };

/** The latest of the non-null stamps (epoch ms). */
export function quietSince(t: Stamps): number {
  const all = [t.lastActivityAt, t.enrolledAt, t.nudgedAt, t.deepCheckedAt, t.snoozeWokeAt, t.linkedChangeAt];
  return Math.max(0, ...all.filter((v): v is number => v !== null));
}

/** Nudge (capped, oldest quiet first) and deep-check lists for one pass. */
export function planReminders(input: { threads: ReminderThread[]; now: number; nudgeDays: number; deepCheckDays: number; cap: number }): {
  nudge: string[];
  deepCheck: string[];
  carried: number;
} {
  const { now } = input;
  const due: { id: string; start: number }[] = [];
  const deepCheck: string[] = [];
  for (const t of input.threads) {
    if (t.archived || t.done || t.snoozed || t.verifying || RUNNING.has(t.status)) continue;
    // The stretch starts at the last real change; our own nudge and check
    // mark it ("done for this stretch") without restarting it.
    const start = quietSince({ ...t, nudgedAt: null, deepCheckedAt: null });
    const quiet = now - start;
    if (quiet >= input.deepCheckDays * DAY && (t.deepCheckedAt === null || t.deepCheckedAt < start)) deepCheck.push(t.id);
    else if (quiet >= input.nudgeDays * DAY && (t.nudgedAt === null || t.nudgedAt < start)) due.push({ id: t.id, start });
  }
  due.sort((a, b) => a.start - b.start);
  const nudge = due.slice(0, input.cap).map((d) => d.id);
  return { nudge, deepCheck, carried: due.length - nudge.length };
}

export type DeepNext = "done-check" | "open-pr" | "snooze";

/** The day-m findings: one reason line and its one-click next step. */
export function deepCheckFindings(input: {
  links: { key: string }[];
  snapshot: { stale: boolean; tickets: JiraTicket[] } | null;
  prs: GhPr[];
  mentions: JiraSnapshot["mentions"];
  me: string | null;
}): { reason: string; next: DeepNext; prUrl?: string } {
  const { snapshot, prs } = input;
  // Missing or stale data never reads as "resolved": no Done offer.
  if (snapshot === null || snapshot.stale) return { reason: "PR status unavailable", next: "snooze" };
  const tickets = input.links.flatMap((l) => snapshot.tickets.find((t) => t.key === l.key) ?? []);
  const live = prs.filter((p) => p.state !== "closed");
  const allMerged = live.every((p) => p.state === "merged");
  const allResolved = tickets.every((t) => t.statusCategory === "done");
  const merged = allMerged && live.length > 0;
  const resolved = allResolved && tickets.length > 0;
  if (allMerged && allResolved && (merged || resolved)) {
    const parts = [...(merged ? ["All PRs merged"] : []), ...(resolved ? [`${tickets.map((t) => t.key).join(", ")} resolved`] : [])];
    return { reason: parts.join(" · "), next: "done-check" };
  }
  const moved = tickets.find((t) => t.statusCategory !== "done" && t.assignee !== null && t.assignee.accountId !== input.me);
  if (moved) return { reason: `${moved.key} reassigned to ${moved.assignee!.displayName}`, next: "snooze" };
  for (const p of live) {
    if (p.state !== "open") continue;
    if (p.reviewDecision === "changes_requested") return { reason: `PR #${p.number}: changes requested`, next: "open-pr", prUrl: prUrl(p) };
    if (p.checks === "fail") return { reason: `PR #${p.number}: CI failing`, next: "open-pr", prUrl: prUrl(p) };
  }
  const keys = new Set(input.links.map((l) => l.key));
  const other = input.mentions.find((m) => keys.has(m.key) && !prs.some((p) => p.repo === m.repo && p.number === m.number));
  if (other) return { reason: `Possibly fixed elsewhere: ${other.repo}#${other.number} merged`, next: "done-check" };
  return { reason: "No change in linked PRs or tickets", next: "snooze" };
}

/** The nudge reply's first non-empty line as plain text, at most 140 chars (untrusted: render as text). */
export function replyLine(text: string | null): string | null {
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/^[\s#>*-]+/, "")
      .replace(/[*`]/g, "")
      .trim();
    if (line !== "") return line.slice(0, 140);
  }
  return null;
}
