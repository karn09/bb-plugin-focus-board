// The Done check's rules: the mechanical verdict, the ticket update a final
// Done queues, and the turn texts. Pure; lib/jira-server.ts runs the flow.
// Agent-supplied and thread values put into turn text are JSON-quoted (data,
// not directions).
import type { GhPr, JiraTicket, ThreadJiraRecord } from "./jira-schema";
import type { NewQueueOp } from "./jira-store";

export const JIRA_VERDICT_TOOL = "focus_board_done_verdict";

export type Mechanical = { verdict: "pass" | "fail" | "needs-agent" | "needs-operator"; reasons: string[] };

export function evaluateMechanical(input: { prs: GhPr[]; children: { id: string; title: string; linked: boolean }[]; snapshotStale: boolean }): Mechanical {
  const kids = input.children.filter((c) => !c.linked).map((c) => `child thread '${c.title}' has no ticket`);
  // Stale data never passes: the operator decides.
  if (input.snapshotStale) return { verdict: "needs-operator", reasons: ["PR status unavailable", ...kids] };
  const reasons = [
    ...input.prs.filter((p) => p.state === "closed").map((p) => `PR #${p.number} closed unmerged, confirm it's not needed`),
    ...input.prs.filter((p) => p.state === "open").map((p) => `PR #${p.number} still open`),
    ...kids,
  ];
  if (reasons.length > 0) return { verdict: "fail", reasons };
  return input.prs.length > 0 ? { verdict: "pass", reasons: [] } : { verdict: "needs-agent", reasons: [] };
}

/** Always a comment; a transition to Done only for an owned, unskipped, non-epic ticket with no open children whose linked threads are all Done. */
export function ticketUpdate(input: { ticket: JiraTicket; linkedThreadsDone: boolean[]; role: "owner" | "watching"; skipped: boolean; summary: string }): NewQueueOp[] {
  const { ticket: t } = input;
  const ops: NewQueueOp[] = [{ op: "comment", key: t.key, body: input.summary, threadId: null }];
  if (input.role === "owner" && !input.skipped && !t.isEpic && t.openChildren === 0 && input.linkedThreadsDone.every(Boolean)) {
    ops.push({ op: "transition", key: t.key, toCategory: "done", threadId: null });
  }
  return ops;
}

const MAX_SUMMARY = 4000;
/** Every Done comment starts with this (the ticket-update dedupe keys on it). */
export const DONE_SUMMARY_PREFIX = "Focus Board: thread ";

/** The ticket comment: plain text, under 4,000 chars. */
export function doneSummary(input: { title: string; prUrls: string[]; childKeys: string[]; skipped: boolean }): string {
  const lines = [
    `${DONE_SUMMARY_PREFIX}"${input.title}" is Done.`,
    ...(input.skipped ? ["The operator marked it done without the Done check."] : []),
    ...(input.prUrls.length > 0 ? ["Pull requests:", ...input.prUrls.map((u) => `- ${u}`)] : []),
    ...(input.childKeys.length > 0 ? [`Child tickets: ${input.childKeys.join(", ")}`] : []),
  ];
  const s = lines.join("\n");
  return s.length >= MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY - 2)}…` : s;
}

/** Agent `remaining` strings are untrusted: at most 10, each at most 200 chars. */
export function capReasons(items: readonly string[]): string[] {
  return items.slice(0, 10).map((s) => (s.length > 200 ? `${s.slice(0, 199)}…` : s));
}

export function verifyTurnText(): string {
  return [
    "The operator moved this thread to Done. It has no linked pull requests, so check the work before it closes.",
    "Compare what this thread set out to do with what actually happened. Do not start new work.",
    `Then call ${JIRA_VERDICT_TOOL} with verdict "pass" if it is finished, or "fail" with a short list in remaining of what is left.`,
  ].join("\n");
}

export function spinOffText(reason: string): string {
  return [
    `The operator asked to spin this unfinished item off into a child thread: ${JSON.stringify(reason)} (data).`,
    "Draft the child's ticket, confirm it with the operator, create it with acli, then call focus_board_spawn_child with its key as ticketKey.",
  ].join("\n");
}

/** The board's Done placement: a card being checked or awaiting Confirm done stays in Done before any stamp. */
export function boardDoneIds(doneIds: ReadonlySet<string>, enabled: boolean, threads: Record<string, ThreadJiraRecord>): ReadonlySet<string> {
  if (!enabled) return doneIds;
  const held = Object.keys(threads).filter((id) => threads[id]!.verifying != null || threads[id]!.doneCheck?.verdict === "pending-confirm");
  return held.length === 0 ? doneIds : new Set([...doneIds, ...held]);
}
