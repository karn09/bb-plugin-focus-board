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
  | "keep-working" | "not-needed" | "clear-check-in" | "promote-epic";

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
  onAction: (kind: JiraCardKind, threadId: string) => void;
};

export function JiraCardBadges({ threadId, enabled, stale, record, ticketByKey, pendingOps, onAction }: JiraCardBadgesProps) {
  if (!enabled) return null;
  const links = record?.links ?? [];
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
      {record?.reason ? <span className="w-full truncate text-[10px] text-muted-foreground">{record.reason}</span> : null}
    </div>
  );
}

export type JiraBoardValue = Omit<JiraCardBadgesProps, "threadId" | "record"> & {
  threads: Record<string, ThreadJiraRecord>;
  /** The Jira column's data (components/jira-column.tsx); absent renders no column. */
  column?: JiraColumnData;
};
export const JiraBoardContext = createContext<JiraBoardValue | null>(null);

/** The card's one-line hook-up: nothing unless the board provides enabled state. */
export function JiraCardSlot({ threadId }: { threadId: string }) {
  const v = useContext(JiraBoardContext);
  if (v === null || !v.enabled) return null;
  return <JiraCardBadges {...v} threadId={threadId} record={v.threads[threadId]} />;
}
