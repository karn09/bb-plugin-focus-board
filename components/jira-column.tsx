// The Jira column: the operator's open tickets, leftmost on the Attention
// view while Jira is on (components/grouping.ts withJiraColumn). It is not a
// thread lane: no cards, no drag, no rank key. JiraColumn is pure; the board
// renders JiraColumnSlot, which reads JiraBoardContext and keeps the
// collapsed / hide-linked toggles in the board's stored preferences.
import { useContext, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { fixQueued } from "../lib/jira-drift";
import type { DriftItem, JiraTicket, QueueOp, ThreadJiraRecord } from "../lib/jira-schema";
import { JiraBoardContext } from "./jira-card-badges";
import { readStoredText, writeStored } from "./preferences";

export const JIRA_COLUMN_COLLAPSED_KEY = "focus-board:jiraColumnCollapsed";
export const JIRA_HIDE_LINKED_KEY = "focus-board:jiraHideLinked";
const NOT_CONNECTED = "Jira not connected: run `acli jira auth login --web`";

type ThreadRef = { id: string; title: string };

/** What the app supplies through JiraBoardContext. */
export type JiraColumnData = {
  tickets: JiraTicket[];
  /** Threads whose Jira record links the key. */
  threadsByKey: Record<string, ThreadRef[]>;
  /** Stored reconcile plan suggestions, by ticket key. */
  suggestions: Record<string, { threadId: string; title: string }[]>;
  drift: DriftItem[];
  stale: boolean;
  snapshotAgeMs: number | null;
  error: string | null;
  onStartThread: (ticket: JiraTicket) => void;
  onLink: (key: string, threadId: string) => void;
  onDismiss: (key: string, threadId: string) => void;
  /** confirm is set only by the Give back dialog. */
  onFix: (item: DriftItem, opts?: { confirm: true }) => void;
  onOpenThread: (threadId: string) => void;
  /** Un-acked queue ops: a fix already queued shows "queued" instead of its button. */
  pending: readonly QueueOp[];
};

/**
 * Linked threads per key: thread-record links plus the reconcile plan's
 * autoLinks (the same "linked" drift uses), deduped, in that order.
 */
export function jiraThreadsByKey(
  records: Record<string, Pick<ThreadJiraRecord, "links">>,
  autoLinks: readonly { threadId: string; key: string }[],
  titleOf: ReadonlyMap<string, string>,
): Record<string, ThreadRef[]> {
  const out: Record<string, ThreadRef[]> = {};
  const add = (key: string, id: string) => {
    const list = (out[key] ??= []);
    if (!list.some((t) => t.id === id)) list.push({ id, title: titleOf.get(id) ?? id });
  };
  for (const [id, rec] of Object.entries(records)) for (const l of rec.links) add(l.key, id);
  for (const l of autoLinks) add(l.key, l.threadId);
  return out;
}

export type JiraColumnProps = JiraColumnData & {
  hideLinked: boolean;
  onHideLinkedChange: (hide: boolean) => void;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
};

const FIX_LABEL: Record<DriftItem["kind"], string> = {
  "todo-with-prs": "Move to In Progress",
  "all-done-still-open": "Run Done check",
  "stale-unlinked": "Give back",
};

function statusLine({ error, stale, snapshotAgeMs }: Pick<JiraColumnProps, "error" | "stale" | "snapshotAgeMs">): string | null {
  // An ok snapshot with some gh reads failed (scripts/jira-sync.mjs): Jira itself is connected.
  if (error !== null && /^gh: \d+ of \d+ /.test(error)) return error;
  if ((error !== null && /unauthori[sz]ed|auth/i.test(error)) || (error === null && snapshotAgeMs === null)) return NOT_CONNECTED;
  if (error !== null) return `Jira refresh failed: ${error}`;
  if (stale && snapshotAgeMs !== null) return `data ${Math.floor(snapshotAgeMs / 60_000)} min old`;
  return null;
}

const btn = "rounded px-1.5 py-0.5 text-[11px] font-medium hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function JiraColumn(props: JiraColumnProps) {
  const { tickets, threadsByKey, suggestions, drift, hideLinked, onHideLinkedChange, collapsed = false, onCollapsedChange } = props;
  const [confirming, setConfirming] = useState<DriftItem | null>(null);
  const status = statusLine(props);

  if (collapsed) {
    return (
      <section data-jira-column="" aria-label="Jira" className="flex h-full w-10 shrink-0 flex-col items-center gap-2 rounded-lg bg-muted/30 py-2">
        <button type="button" aria-label="Expand Jira column" className={btn} onClick={() => onCollapsedChange?.(false)}>
          <Icon name="ChevronRight" className="size-3.5" aria-hidden />
        </button>
        <span className="text-xs font-medium text-muted-foreground [writing-mode:vertical-rl]">Jira · {tickets.length}</span>
      </section>
    );
  }

  const shown = hideLinked ? tickets.filter((t) => (threadsByKey[t.key] ?? []).length === 0) : tickets;
  return (
    <section data-jira-column="" aria-label={`Jira, ${tickets.length} tickets`} className="flex h-full min-h-0 w-64 shrink-0 flex-col rounded-lg">
      <header className="flex items-center gap-1.5 px-1 pb-1.5">
        <h2 className="text-xs font-semibold">Jira</h2>
        <span className="text-xs text-muted-foreground">{tickets.length}</span>
        <label className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
          <input type="checkbox" aria-label="Hide linked tickets" checked={hideLinked} onChange={(e) => onHideLinkedChange(e.target.checked)} />
          hide linked
        </label>
        <button type="button" aria-label="Collapse Jira column" className={btn} onClick={() => onCollapsedChange?.(true)}>
          <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
        </button>
      </header>
      {status !== null ? <p className="px-1 pb-1 text-[11px] text-amber-600 dark:text-amber-400">{status}</p> : null}
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto rounded-lg bg-muted/30 p-1.5">
        {shown.map((t) => {
          const linked = threadsByKey[t.key] ?? [];
          const maybe = suggestions[t.key] ?? [];
          return (
            <article key={t.key} data-jira-ticket={t.key} className="space-y-1 rounded-md border border-border/60 bg-card p-2 text-xs">
              <div className="flex items-baseline gap-1.5">
                <a href={t.url} target="_blank" rel="noreferrer" className="font-medium underline-offset-2 hover:underline">{t.key}</a>
                <span className="text-[10px] text-muted-foreground">{t.status}</span>
              </div>
              <p className="line-clamp-2">{t.summary}</p>
              {drift.filter((d) => d.key === t.key).map((d) => (
                <div key={d.kind} data-jira-drift={d.kind} className="rounded bg-amber-500/10 p-1 text-[11px]">
                  <p>{d.detail}</p>
                  {fixQueued(props.pending, d.key, d.kind) ? (
                    <span className="italic text-muted-foreground">queued</span>
                  ) : (
                    <button
                      type="button"
                      className={btn}
                      onClick={() => (d.kind === "stale-unlinked" ? setConfirming(d) : props.onFix(d))}
                    >
                      {FIX_LABEL[d.kind]}
                    </button>
                  )}
                  {confirming?.key === d.key && confirming.kind === d.kind ? (
                    <div role="alertdialog" aria-label={`Give back ${d.key}`} className="mt-1 space-y-1 rounded border border-border p-1">
                      <p>Comment on {d.key} that you are giving it back, then unassign yourself?</p>
                      <button type="button" className={cn(btn, "bg-amber-500/80 text-amber-950")} onClick={() => { setConfirming(null); props.onFix(d, { confirm: true }); }}>
                        Comment and unassign
                      </button>
                      <button type="button" className={btn} onClick={() => setConfirming(null)}>Cancel</button>
                    </div>
                  ) : null}
                </div>
              ))}
              {linked.map((th) => (
                <button key={th.id} type="button" className="block w-full truncate text-left text-sky-600 hover:underline dark:text-sky-400" onClick={() => props.onOpenThread(th.id)}>
                  {th.title}
                </button>
              ))}
              {maybe.map((s) => (
                <div key={s.threadId} data-jira-suggestion="" className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">Might be: {s.title}</span>
                  <button type="button" className={btn} onClick={() => props.onLink(t.key, s.threadId)}>Link</button>
                  <button type="button" aria-label="Dismiss suggestion" className={btn} onClick={() => props.onDismiss(t.key, s.threadId)}>×</button>
                </div>
              ))}
              {linked.length === 0 ? (
                <button type="button" className={cn(btn, "border border-border/60")} onClick={() => props.onStartThread(t)}>Start thread</button>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

const readFlag = (key: string) => readStoredText(key, "0") === "1";

/** The board's hook-up: nothing unless Jira is on and the app supplied column data. */
export function JiraColumnSlot() {
  const v = useContext(JiraBoardContext);
  const [collapsed, setCollapsed] = useState(() => readFlag(JIRA_COLUMN_COLLAPSED_KEY));
  const [hideLinked, setHideLinked] = useState(() => readFlag(JIRA_HIDE_LINKED_KEY));
  if (v === null || !v.enabled || v.column === undefined) return null;
  const persist = (key: string, set: (b: boolean) => void) => (b: boolean) => {
    set(b);
    writeStored(key, b ? "1" : "0");
  };
  return (
    <JiraColumn
      {...v.column}
      collapsed={collapsed}
      onCollapsedChange={persist(JIRA_COLUMN_COLLAPSED_KEY, setCollapsed)}
      hideLinked={hideLinked}
      onHideLinkedChange={persist(JIRA_HIDE_LINKED_KEY, setHideLinked)}
    />
  );
}
