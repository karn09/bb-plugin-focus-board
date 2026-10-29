// Jira chips and badges on a thread card. JiraCardBadges is pure; the board
// publishes its state through JiraBoardContext and JiraCardSlot (rendered by
// the card) reads it, so no prop is threaded through board/parent-lane/card.
import { createContext, useContext } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { JiraTicket, QueueOp, ThreadJiraRecord } from "../lib/jira-schema";
import type { JiraColumnData } from "./jira-column";

export type JiraCardKind =
  | "find-ticket" | "confirm-done" | "skip-done" | "spin-off"
  | "keep-working" | "not-needed" | "clear-check-in" | "promote-epic"
  | "run-done-check" | "dismiss-reason";

const TONE = { new: "neutral", indeterminate: "info", done: "good" } as const;
const TONE_CLASS = {
  neutral: "text-muted-foreground",
  info: "text-sky-600 dark:text-sky-400",
  good: "text-emerald-600 dark:text-emerald-400",
} as const;
const chip = "inline-flex max-w-full items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[10px] leading-none";

export type JiraCardBadgesProps = {
  threadId: string;
  enabled: boolean;
  stale: boolean;
  record: ThreadJiraRecord | undefined;
  ticketByKey: Record<string, JiraTicket>;
  pendingOps: readonly QueueOp[];
  /** index + reason: which Done-check reason (spin-off / not-needed); the server refuses a stale pair. */
  onAction: (kind: JiraCardKind, threadId: string, index?: number, reason?: string) => void;
  /** The deeper check's one-click next step for this card (lib/jira-reminders.ts). */
  next?: { next: "done-check" | "open-pr" | "snooze"; prUrl?: string };
  /** The board's own snooze (the "snooze" next step). */
  onSnooze?: (threadId: string) => void;
};

export function JiraCardBadges({ threadId, enabled, stale, record, ticketByKey, pendingOps, onAction, next, onSnooze }: JiraCardBadgesProps) {
  if (!enabled) return null;
  const links = record?.links ?? [];
  const failed = record?.doneCheck?.verdict === "fail" ? record.doneCheck.reasons : [];
  const checkOpen = record?.verifying != null || record?.doneCheck?.verdict === "fail" || record?.doneCheck?.verdict === "pending-confirm";
  const pendingKeys = new Set(pendingOps.filter((o) => "key" in o).map((o) => (o as { key: string }).key));
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 px-3 pb-2 pl-1.5" data-jira-badges="">
      {links.map((l) => {
        const t = ticketByKey[l.key];
        const tone = t ? TONE[t.statusCategory] : "neutral";
        return (
          <span key={l.key} className={chip} data-jira-chip="" data-tone={tone} data-jira-key={l.key}>
            <span className={cn("inline-block size-1.5 rounded-full bg-current", TONE_CLASS[tone])} aria-hidden />
            <span>{t ? `${l.key} · ${t.status}` : l.key}</span>
            {stale ? <span className="text-amber-600">stale</span> : null}
            {pendingKeys.has(l.key) ? <span className="italic text-muted-foreground">pending</span> : null}
          </span>
        );
      })}
      {links.length === 0 ? (
        <span className={chip} data-jira-chip="" data-tone="neutral">
          <span>No ticket</span>
          <button type="button" className="underline" onClick={() => onAction("find-ticket", threadId)}>
            Find ticket
          </button>
        </span>
      ) : null}
      {record?.verifying ? (
        <span className={chip} data-jira-verifying="">
          <Icon name="Spinner" className="size-3 animate-spin" aria-hidden />
          verifying
        </span>
      ) : null}
      {record?.checkInWith ? (
        <span className={chip}>
          <span>check in with {record.checkInWith}</span>
          <button type="button" aria-label="Clear check-in" onClick={() => onAction("clear-check-in", threadId)}>
            ×
          </button>
        </span>
      ) : null}
      {record?.epicSuggested && links[0] ? (
        <span className={chip}>
          <button type="button" className="underline" onClick={() => onAction("promote-epic", threadId)}>
            Promote {(links.find((l) => l.role === "owner") ?? links[0]).key} to an epic?
          </button>
        </span>
      ) : null}
      {record?.doneCheck?.verdict === "pending-confirm" ? (
        <button type="button" className={cn(chip, "underline")} onClick={() => onAction("confirm-done", threadId)}>
          Confirm done
        </button>
      ) : null}
      {record?.verifying != null || record?.doneCheck?.verdict === "pending-confirm" ? (
        <button type="button" className={cn(chip, "underline")} onClick={() => onAction("keep-working", threadId)}>
          Keep working
        </button>
      ) : null}
      {failed.length > 0 ? (
        <ul className="w-full text-[10px] text-muted-foreground" data-jira-reasons="">
          {failed.map((r, i) => (
            <li key={i} className="flex flex-wrap items-center gap-1">
              <span className="truncate">{r}</span>
              <button type="button" className="underline" onClick={() => onAction("spin-off", threadId, i, r)}>Spin off</button>
              <button type="button" className="underline" onClick={() => onAction("keep-working", threadId)}>Keep working</button>
              <button type="button" className="underline" onClick={() => onAction("not-needed", threadId, i, r)}>Not needed</button>
            </li>
          ))}
        </ul>
      ) : record?.reason ? (
        <span className="w-full truncate text-[10px] text-muted-foreground">{record.reason}</span>
      ) : null}
      {record?.reason && failed.length === 0 && next?.next === "done-check" ? (
        <button type="button" className={cn(chip, "underline")} onClick={() => onAction("run-done-check", threadId)}>
          Run Done check
        </button>
      ) : null}
      {record?.reason && failed.length === 0 && next?.next === "open-pr" && next.prUrl ? (
        <a className={cn(chip, "underline")} href={next.prUrl} target="_blank" rel="noreferrer">
          Open PR
        </a>
      ) : null}
      {record?.reason && failed.length === 0 && next?.next === "snooze" && onSnooze ? (
        <button
          type="button"
          className={cn(chip, "underline")}
          onClick={() => {
            onSnooze(threadId);
            onAction("dismiss-reason", threadId);
          }}
        >
          Snooze
        </button>
      ) : null}
      {checkOpen ? (
        <details className="text-[10px] text-muted-foreground">
          <summary className="cursor-pointer">More</summary>
          <button type="button" className="underline" onClick={() => onAction("skip-done", threadId)}>
            Mark done anyway
          </button>
        </details>
      ) : null}
    </div>
  );
}

export type JiraBoardValue = Omit<JiraCardBadgesProps, "threadId" | "record" | "next"> & {
  threads: Record<string, ThreadJiraRecord>;
  /** threadId → the deeper check's next step (jira_board_state.next). */
  nextByThread?: Record<string, NonNullable<JiraCardBadgesProps["next"]>>;
  /** The Jira column's data (components/jira-column.tsx); absent renders no column. */
  column?: JiraColumnData;
};
export const JiraBoardContext = createContext<JiraBoardValue | null>(null);

/** The card's one-line hook-up: nothing unless the board provides enabled state. */
export function JiraCardSlot({ threadId }: { threadId: string }) {
  const v = useContext(JiraBoardContext);
  if (v === null || !v.enabled) return null;
  return <JiraCardBadges {...v} threadId={threadId} record={v.threads[threadId]} next={v.nextByThread?.[threadId]} />;
}
