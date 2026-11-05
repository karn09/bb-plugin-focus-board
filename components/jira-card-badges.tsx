// Jira chips and badges on a thread card. JiraCardBadges is pure; the board
// publishes its state through JiraBoardContext and JiraCardSlot (rendered by
// the card) reads it, so no prop is threaded through board/parent-lane/card.
import { createContext, useContext, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { JiraTicket, QueueOp, ThreadJiraRecord } from "../lib/jira-schema";
import type { JiraColumnData } from "./jira-column";
import { MenuPopover, MenuPopoverEntry } from "./menu-popover";

export type JiraCardKind =
  | "find-ticket" | "confirm-done" | "skip-done" | "spin-off"
  | "keep-working" | "not-needed" | "clear-check-in" | "promote-epic"
  | "run-done-check" | "dismiss-reason";

const TONE = { new: "neutral", indeterminate: "info", done: "good" } as const;
const LOZENGE = {
  neutral: "bg-zinc-500/25 text-zinc-700 dark:text-zinc-300",
  info: "bg-blue-500/20 text-blue-700 dark:text-blue-300",
  good: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
} as const;
const lozengeText = (status: string) => {
  const u = status.toUpperCase();
  return u.length > 14 ? `${u.slice(0, 13)}…` : u;
};
/** Jira's mark, bundled so the chip never fetches an icon. */
const JiraMark = () => (
  <svg viewBox="0 0 24 24" className="size-3 shrink-0" fill="#2684FF" aria-hidden data-jira-mark="">
    <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84zM6.77 6.8a4.36 4.36 0 0 0 4.34 4.34h1.8v1.72a4.36 4.36 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.83-.83zM2 11.6c0 2.4 1.95 4.34 4.35 4.34h1.78v1.72c0 2.4 1.94 4.34 4.34 4.34v-9.57a.84.84 0 0 0-.84-.83z" />
  </svg>
);
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
  /** Undo: cancel this thread's queued writes before a sync pass sends them (jira_undo). */
  onUndo?: (threadId: string, opIds: string[]) => void;
};

export function JiraCardBadges({ threadId, enabled, stale, record, ticketByKey, pendingOps, onAction, next, onSnooze, onUndo }: JiraCardBadgesProps) {
  if (!enabled) return null;
  const links = record?.links ?? [];
  const failed = record?.doneCheck?.verdict === "fail" ? record.doneCheck.reasons : [];
  const checkOpen = record?.verifying != null || record?.doneCheck?.verdict === "fail" || record?.doneCheck?.verdict === "pending-confirm";
  const pendingKeys = new Set(pendingOps.filter((o) => "key" in o).map((o) => (o as { key: string }).key));
  const own = pendingOps.filter((o) => o.threadId === threadId);
  const ownPending = own.map((o) => o.id);
  // Undo sits on the first chip whose "pending" marker comes from this thread's own ops.
  const undoKey = links.find((l) => own.some((o) => "key" in o && o.key === l.key))?.key;
  const undoButton =
    onUndo && ownPending.length > 0 ? (
      <button
        type="button"
        aria-label="Undo Jira changes"
        title="Cancel this thread's Jira changes before the next sync sends them"
        className="underline"
        onClick={() => onUndo(threadId, ownPending)}
      >
        Undo
      </button>
    ) : null;
  // A failed reason's ⋯ menu: which reason, and where it opens.
  const [menu, setMenu] = useState<{ index: number; x: number; y: number } | null>(null);
  const menuReason = menu === null ? undefined : failed[menu.index];
  const runOnReason = (kind: "spin-off" | "not-needed") => {
    if (menu !== null && menuReason !== undefined) onAction(kind, threadId, menu.index, menuReason);
    setMenu(null);
  };
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 px-3 pb-2 pl-1.5" data-jira-badges="">
      {links.length > 0 ? (
        <span className={cn(chip, "flex-wrap rounded bg-muted px-1 font-mono text-muted-foreground min-h-5 border-0 gap-x-1")} data-jira-chip="">
          <JiraMark />
          {links.map((l) => {
            const t = ticketByKey[l.key];
            const tone = t ? TONE[t.statusCategory] : "neutral";
            return (
              <span key={l.key} className="inline-flex items-center gap-1" data-tone={tone} data-jira-key={l.key}>
                <a
                  href={t?.url}
                  target="_blank"
                  rel="noreferrer"
                  title={t ? `${l.key} · ${t.status} · ${t.issueType}${stale ? " · stale" : ""}` : l.key}
                  onClick={(e) => e.stopPropagation()}
                >
                  {l.key}
                </a>
                {t ? (
                  <span data-jira-lozenge="" className={cn("rounded px-1 font-sans text-[9px] font-semibold", LOZENGE[tone])}>
                    {lozengeText(t.status)}
                  </span>
                ) : null}
              </span>
            );
          })}
          {stale ? <span className="text-amber-600">stale</span> : null}
          {links.some((l) => pendingKeys.has(l.key)) ? <span className="italic text-muted-foreground">pending</span> : null}
          {undoKey !== undefined ? undoButton : null}
        </span>
      ) : null}
      {/* An own op on no linked key (rare): Undo stands alone. */}
      {undoKey === undefined && undoButton ? <span className={chip}>{undoButton}</span> : null}
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
          <span>{record.verifying.reasons?.[0] ?? "verifying"}</span>
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
      {record?.doneCheck?.verdict === "pending-confirm" && record.doneCheck.reasons.length > 0 ? (
        <span className="w-full truncate text-[10px] text-muted-foreground" data-jira-confirm-note="">{record.doneCheck.reasons[0]}</span>
      ) : null}
      {record?.doneCheck?.verdict === "pending-confirm" ? (
        <button type="button" className={cn(chip, "underline")} onClick={() => onAction("confirm-done", threadId)}>
          Confirm done
        </button>
      ) : null}
      {checkOpen ? (
        <button type="button" className={cn(chip, "underline")} onClick={() => onAction("keep-working", threadId)}>
          Keep working
        </button>
      ) : null}
      {failed.length > 0 ? (
        <ul className="w-full text-[10px] text-muted-foreground" data-jira-reasons="">
          {failed.map((r, i) => (
            <li key={i} className="flex items-center gap-1">
              <span className="min-w-0 truncate">{r}</span>
              <button
                type="button"
                aria-label={`More for: ${r}`}
                title="Spin off or mark not needed"
                className="shrink-0 rounded px-0.5 leading-none hover:bg-accent"
                onClick={(e) => {
                  // Enter/Space clicks carry no pointer position (detail 0): open under the button.
                  const r = e.detail === 0 ? e.currentTarget.getBoundingClientRect() : null;
                  setMenu({ index: i, x: r ? r.left : e.clientX, y: r ? r.bottom : e.clientY });
                }}
              >
                ⋯
              </button>
            </li>
          ))}
        </ul>
      ) : record?.reason ? (
        <span className="w-full truncate text-[10px] text-muted-foreground">{record.reason}</span>
      ) : null}
      {menuReason !== undefined ? (
        // The menu renders inside the card: its backdrop clicks must not reach the card's own handlers.
        <span onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
          <MenuPopover open={menu} onClose={() => setMenu(null)} label="Done check reason" title={menuReason}>
            <MenuPopoverEntry label="Spin off" icon="GitBranch" onRun={() => runOnReason("spin-off")} />
            <MenuPopoverEntry label="Not needed" icon="X" onRun={() => runOnReason("not-needed")} />
          </MenuPopover>
        </span>
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
