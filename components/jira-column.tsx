// The Jira column: the operator's open tickets, leftmost on the Attention
// view while Jira is on (components/grouping.ts withJiraColumn). It is not a
// thread lane: no cards, no drag, no rank key. JiraColumn is pure; the board
// renders JiraColumnSlot, which reads JiraBoardContext and keeps the
// collapsed / hide-linked toggles in the board's stored preferences.
import { useContext, useEffect, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { fixQueued } from "../lib/jira-drift";
import type { DriftItem, JiraTicket, QueueOp, ThreadJiraRecord } from "../lib/jira-schema";
import { JiraBoardContext } from "./jira-card-badges";
import { readStoredText, writeStored } from "./preferences";

export const JIRA_COLUMN_COLLAPSED_KEY = "focus-board:jiraColumnCollapsed";
export const JIRA_HIDE_LINKED_KEY = "focus-board:jiraHideLinked";
const NOT_CONNECTED = "Jira not connected: run `acli jira auth login --web`";
const NO_DATA = "No Jira data yet: run `bb focus-board jira sync`";

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
  /** An unanswered Refresh request (epoch ms), else null. */
  refreshRequestedAt: number | null;
  /** When a sync pass last started (epoch ms), else null. */
  syncRanAt: number | null;
  /** The jiraSync setting: off means nothing syncs on its own. */
  syncEnabled: boolean;
  onRefresh: () => void;
  /** The board's live threads, for "Link to thread…". */
  allThreads: readonly ThreadRef[];
  /** Clock for the Refresh/sync timeouts (tests). */
  now?: number;
};

/** A Refresh or a sync pass older than this counts as lapsed. */
const LAPSE_MS = 3 * 60_000;
const SYNC_OFF = 'Jira sync is off: turn on "Jira: sync automatically" in Focus Board settings';
const NOT_RUNNING = "Jira sync hasn't run: check `bb focus-board jira status`";

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

/** An ok snapshot with some gh reads failed (lib/jira-sync-core.ts): Jira itself is connected. */
const GH_PARTIAL = /^gh: \d+ of \d+ /;
/** lib/jira-exec.ts runTool's message when a tool isn't installed (also inside a gh partial line). */
const TOOL_MISSING = /\b(acli|gh) not found on PATH\b/;

function errorLine(error: string | null): string | null {
  if (error === null) return null;
  const missing = error.match(TOOL_MISSING);
  if (missing) return missing[0];
  if (GH_PARTIAL.test(error)) return error;
  if (/unauthori[sz]ed|not authenticated|auth login|\b401\b/i.test(error)) return NOT_CONNECTED;
  return `Jira refresh failed: ${error}`;
}

type SyncState = Pick<JiraColumnData, "error" | "stale" | "snapshotAgeMs" | "syncRanAt" | "syncEnabled">;
const syncLapsed = (s: SyncState, now: number) => s.syncRanAt === null || now - s.syncRanAt > LAPSE_MS;

/** The column's status lines: an error first, then sync off; else no data, old data, or sync not running. */
export function jiraStatusLines(s: SyncState, now: number): string[] {
  const err = errorLine(s.error);
  if (err !== null || !s.syncEnabled) return [err, s.syncEnabled ? null : SYNC_OFF].filter((l): l is string => l !== null);
  if (s.snapshotAgeMs === null) return [NO_DATA];
  if (s.stale) return [`data ${Math.floor(s.snapshotAgeMs / 60_000)} min old`];
  return syncLapsed(s, now) ? [NOT_RUNNING] : [];
}

/**
 * The board banner's message when sync can't run, else null: the last pass
 * failed (a partial gh failure stays in the column), sync is off, or no pass
 * started for 3 minutes. Same strings as the column's lines.
 */
export function jiraSyncBannerMessage(s: SyncState, now: number): string | null {
  const err = errorLine(s.error);
  if (err !== null && !GH_PARTIAL.test(err)) return err;
  if (!s.syncEnabled) return SYNC_OFF;
  return syncLapsed(s, now) ? NOT_RUNNING : null;
}

const btn = "rounded px-1.5 py-0.5 text-[11px] font-medium hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function JiraColumn(props: JiraColumnProps) {
  const { tickets, threadsByKey, suggestions, drift, hideLinked, onHideLinkedChange, collapsed = false, onCollapsedChange } = props;
  const [confirming, setConfirming] = useState<DriftItem | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const now = props.now ?? Date.now();
  const refreshing = props.refreshRequestedAt !== null && now - props.refreshRequestedAt < LAPSE_MS;
  const status = jiraStatusLines(props, now);

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
        {props.pending.length > 0 ? (
          <span className="text-[10px] italic text-muted-foreground" data-jira-waiting="" title="Sent to Jira on the next sync pass">
            {props.pending.length} Jira {props.pending.length === 1 ? "change" : "changes"} waiting
          </span>
        ) : null}
        <button
          type="button"
          aria-label="Refresh Jira"
          title={refreshing ? "Syncing with Jira and GitHub" : "Fetch tickets now"}
          className={cn(btn, "ml-auto inline-flex items-center gap-1")}
          disabled={refreshing}
          onClick={props.onRefresh}
        >
          <Icon name={refreshing ? "Spinner" : "RotateCcw"} className={cn("size-3", refreshing && "animate-spin")} aria-hidden />
          {refreshing ? "Refreshing…" : null}
        </button>
        <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <input type="checkbox" aria-label="Hide linked tickets" checked={hideLinked} onChange={(e) => onHideLinkedChange(e.target.checked)} />
          hide linked
        </label>
        <button type="button" aria-label="Collapse Jira column" className={btn} onClick={() => onCollapsedChange?.(true)}>
          <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
        </button>
      </header>
      {status.map((line) => <p key={line} className="px-1 pb-1 text-[11px] text-amber-600 dark:text-amber-400">{line}</p>)}
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
              <div className="flex flex-wrap gap-1">
                {linked.length === 0 ? (
                  <button type="button" className={cn(btn, "border border-border/60")} onClick={() => props.onStartThread(t)}>Start thread</button>
                ) : null}
                <button
                  type="button"
                  data-jira-link-thread=""
                  className={btn}
                  onClick={() => { setLinking(linking === t.key ? null : t.key); setQuery(""); }}
                >
                  Link to thread…
                </button>
              </div>
              {linking === t.key ? (
                <div className="space-y-1">
                  <input
                    type="search"
                    autoFocus
                    aria-label={`Find a thread to link to ${t.key}`}
                    placeholder="Search threads"
                    className="w-full rounded border border-border/60 bg-background px-1.5 py-0.5 text-[11px]"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") setLinking(null); }}
                  />
                  <ul role="listbox" aria-label={`Threads to link to ${t.key}`} className="max-h-40 overflow-y-auto">
                    {props.allThreads
                      .filter((th) => !linked.some((l) => l.id === th.id) && th.title.toLowerCase().includes(query.trim().toLowerCase()))
                      .slice(0, 50)
                      .map((th) => (
                        <li
                          key={th.id}
                          role="option"
                          aria-selected={false}
                          aria-label={th.title}
                          className="cursor-pointer truncate rounded px-1 py-0.5 hover:bg-muted"
                          onClick={() => { setLinking(null); props.onLink(t.key, th.id); }}
                        >
                          {th.title}
                        </li>
                      ))}
                  </ul>
                </div>
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

/**
 * The board banner row's Jira line (components/board.tsx): one slim banner
 * while Jira is on and sync can't run, with Run sync now (jira_refresh).
 * Dismissing hides that message for the session; a new one shows again.
 */
const STARTUP_GRACE_MS = 10_000;

export function JiraSyncBannerSlot() {
  const v = useContext(JiraBoardContext);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [graceOver, setGraceOver] = useState(false);
  const col = v !== null && v.enabled ? v.column : undefined;
  const on = col !== undefined;
  // The no-pass condition comes with time alone: re-check while Jira is on.
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setClock(Date.now()), 30_000);
    const grace = setTimeout(() => setGraceOver(true), STARTUP_GRACE_MS);
    return () => {
      clearInterval(t);
      clearTimeout(grace);
    };
  }, [on]);
  const now = col?.now ?? clock;
  const raw = col === undefined ? null : jiraSyncBannerMessage(col, now);
  // The load pass lands about 2 s in: "hasn't run" waits out a startup grace
  // so it never flashes (or gets dismissed into a false quiet). Others show at once.
  const message = raw === NOT_RUNNING && !graceOver ? null : raw;
  // A cleared condition re-arms the dismissal, so the same message can come back.
  useEffect(() => {
    if (message === null) setDismissed(null);
  }, [message]);
  if (col === undefined || message === null || message === dismissed) return null;
  return (
    <div
      role="status"
      data-testid="jira-sync-banner"
      className="mx-3 mb-1 flex items-center justify-between gap-2 rounded border border-amber-500/40 bg-amber-50 dark:bg-amber-950 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400"
    >
      <p className="min-w-0">{message}</p>
      <div className="flex shrink-0 items-center gap-1">
        <button type="button" className={btn} onClick={col.onRefresh}>Run sync now</button>
        <button
          type="button"
          onClick={() => setDismissed(message)}
          aria-label="Dismiss Jira sync notice"
          title="Dismiss"
          className="rounded p-0.5 text-amber-700/70 transition-colors hover:bg-amber-500/10 hover:text-amber-700 focus-visible:outline focus-visible:outline-1 focus-visible:outline-amber-600 dark:text-amber-400/70 dark:hover:text-amber-400"
        >
          <Icon name="X" className="size-3" aria-hidden />
        </button>
      </div>
    </div>
  );
}
