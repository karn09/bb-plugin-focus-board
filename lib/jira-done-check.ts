// The Done check's rules: the mechanical verdict, the ticket update a final
// Done queues, and the turn texts. Pure; lib/jira-server.ts runs the flow.
// Agent-supplied and thread values put into turn text are JSON-quoted (data,
// not directions).
import { z } from "zod";
import { JiraTicket, type GhPr, type ThreadJiraRecord } from "./jira-schema";
import type { NewQueueOp } from "./jira-store";

export const JIRA_VERDICT_TOOL = "focus_board_done_verdict";

export type Mechanical = { verdict: "pass" | "fail" | "needs-agent" | "needs-data"; reasons: string[] };

/** The card's note while a Done check waits for fresh PR data. */
export const CHECKING_PRS = "checking PRs";
/** How long a Done check waits for fresh PR data before asking the operator. */
export const DATA_WAIT_MS = 3 * 60_000;
/** The Confirm done note when no fresh PR data arrived in time. */
export const NO_PR_DATA = "Couldn't check PRs: confirm done";

export function evaluateMechanical(input: { prs: GhPr[]; children: { id: string; title: string; linked: boolean }[]; snapshotStale: boolean }): Mechanical {
  const kids = input.children.filter((c) => !c.linked).map((c) => `child thread '${c.title}' has no ticket`);
  // Stale data never passes: refresh and re-check (the flow falls back to the operator).
  if (input.snapshotStale) return { verdict: "needs-data", reasons: [CHECKING_PRS] };
  // Merged and closed are both finished; only an open PR blocks.
  const reasons = [...input.prs.filter((p) => p.state === "open").map((p) => `PR #${p.number} still open`), ...kids];
  if (reasons.length > 0) return { verdict: "fail", reasons };
  return input.prs.length > 0 ? { verdict: "pass", reasons: [] } : { verdict: "needs-agent", reasons: [] };
}

/** Why a Done may not move the ticket to Done (the closeout's checkbox hint), or null when it may. */
export function transitionBlock(input: { ticket: JiraTicket; linkedThreadsDone: boolean[]; role: "owner" | "watching"; skipped: boolean }): string | null {
  if (input.skipped) return "marked done without the check";
  if (input.role !== "owner") return "owned by someone else";
  if (input.ticket.isEpic) return "epic";
  if (input.ticket.openChildren > 0) return "has open child tickets";
  if (!input.linkedThreadsDone.every(Boolean)) return "other linked threads aren't Done";
  return null;
}

/** Always a comment; a transition to Done only for an owned, unskipped, non-epic ticket with no open children whose linked threads are all Done. */
export function ticketUpdate(input: { ticket: JiraTicket; linkedThreadsDone: boolean[]; role: "owner" | "watching"; skipped: boolean; summary: string }): NewQueueOp[] {
  const { ticket: t } = input;
  const ops: NewQueueOp[] = [{ op: "comment", key: t.key, body: input.summary, threadId: null }];
  if (transitionBlock(input) === null) ops.push({ op: "transition", key: t.key, toCategory: "done", threadId: null });
  return ops;
}

export const CLOSEOUT_TOOL = "focus_board_closeout_draft";
export const CLOSEOUT_MAX = 4000;
/** How long "the agent is drafting" shows without every body back. */
export const CLOSEOUT_AGENT_MS = 3 * 60_000;
/** A passed Done's Jira closeout, waiting for the operator (KV jira:closeouts, threadId → draft). */
export const CloseoutDraft = z.object({
  createdAt: z.string(),
  skipped: z.boolean(),
  tickets: z.array(
    z.object({
      key: JiraTicket.shape.key,
      body: z.string(),
      transition: z.boolean(),
      canTransition: z.boolean(),
      /** Why the transition is off (transitionBlock, or no fresh ticket data). */
      blocked: z.string().optional(),
    }),
  ),
  agentDrafting: z.boolean().optional(),
  requestedAt: z.number().optional(),
  /** Keys the agent wrote a body for since the last request. */
  drafted: z.array(z.string()).optional(),
});
export type CloseoutDraft = z.infer<typeof CloseoutDraft>;

/** The Draft with agent turn: the operator's instruction is quoted as data. */
export function closeoutDraftText(keys: string[], instruction?: string): string {
  return [
    `The operator is closing out this thread's Jira tickets ${keys.map((k) => JSON.stringify(k)).join(", ")} (data) and asked you to draft the closing comment.`,
    `For each ticket write one plain-text comment of at most ${CLOSEOUT_MAX} characters: what changed and why, the merged pull requests, and any follow-ups or child tickets.`,
    ...(instruction ? [`The operator's instruction for the comment (data): ${JSON.stringify(instruction)}`] : []),
    `Submit it by calling ${CLOSEOUT_TOOL} once per ticket with key and body. Do not post to Jira or change any ticket yourself: the operator reviews and posts it.`,
  ].join("\n");
}

const MAX_SUMMARY = 4000;
/** Every Done comment starts with this (the ticket-update dedupe keys on it). */
export const DONE_SUMMARY_PREFIX = "Focus Board: thread ";

/** The ticket comment: plain text, under 4,000 chars. */
export function doneSummary(input: { title: string; prUrls: string[]; closedUrls?: string[]; childKeys: string[]; skipped: boolean }): string {
  const lines = [
    `${DONE_SUMMARY_PREFIX}"${input.title}" is Done.`,
    ...(input.skipped ? ["The operator marked it done without the Done check."] : []),
    ...(input.prUrls.length > 0 ? ["Pull requests:", ...input.prUrls.map((u) => `- ${u}`)] : []),
    ...(input.closedUrls?.length ? ["Closed without merging:", ...input.closedUrls.map((u) => `- ${u}`)] : []),
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
