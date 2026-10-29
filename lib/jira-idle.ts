// The only door to a thread for the Jira feature. Every turn this feature
// sends goes through sendIfIdle, which re-reads the thread's status right
// before the send and never sends to a running one. Work that finds the
// thread busy is queued (persisted in KV) and run on its next thread.idle.
// tests/jira-running-threads.test.ts fails if a `.send(` shows up in any
// other lib/jira-*.ts file.
import { z } from "zod";
import type { JsonValue } from "@get-bb/plugin-sdk";
import type { KvLike } from "./jira-store";

export const IDLE_JOBS_KEY = "jira:idle-jobs";

export type JobKind = "done-check" | "verify-turn" | "nudge-turn" | "find-ticket" | "promote-epic";
export type IdleHandler = (threadId: string, payload: JsonValue | undefined) => Promise<void>;

/** The slice of bb.sdk.threads this module uses. */
export interface ThreadDoor {
  get(args: { threadId: string }): Promise<unknown>;
  send(args: { threadId: string; mode: "start"; input: { type: "text"; text: string }[] }): Promise<unknown>;
}
type Log = (msg: string) => void;

const Job = z.object({
  threadId: z.string(),
  kind: z.enum(["done-check", "verify-turn", "nudge-turn", "find-ticket", "promote-epic"]),
  payload: z.unknown().optional(),
  queuedAt: z.string(),
});
type Job = { threadId: string; kind: JobKind; payload?: JsonValue; queuedAt: string };

// SDK request errors (BbHttpError) carry the server's `status` and `code`
// (also in `body.code`); duck-typed so it survives any serialization.
function apiError(e: unknown): { status?: unknown; code?: unknown } {
  const err = (e ?? {}) as { status?: unknown; code?: unknown; body?: { code?: unknown } };
  return { status: err.status, code: err.code ?? err.body?.code };
}

// `idle` and `error` are at rest; active/starting/stopping/pending are running.
// Only a missing (404 thread_not_found / null) or archived thread is gone; any
// other read failure is treated as busy so queued work keeps waiting.
async function threadState(threads: ThreadDoor, threadId: string, log: Log): Promise<"idle" | "busy" | "gone"> {
  let row: { status?: unknown; archivedAt?: unknown } | null;
  try {
    row = (await threads.get({ threadId })) as typeof row;
  } catch (e) {
    const { status, code } = apiError(e);
    if (status === 404 || code === "thread_not_found") return "gone";
    log(`jira idle: cannot read thread ${threadId}, treating as busy: ${(e as Error)?.message}`);
    return "busy";
  }
  if (!row || row.archivedAt != null) return "gone";
  return row.status === "idle" || row.status === "error" ? "idle" : "busy";
}

/**
 * The only way the Jira feature sends a turn. Re-reads the thread right
 * before sending, then sends with mode "start", which the server rejects
 * atomically (409 thread_not_writable) if the thread became active in
 * between; that rejection returns "busy". Any other send error is rethrown:
 * callers must treat a throw as "not sent".
 */
export async function sendIfIdle(
  threads: ThreadDoor,
  threadId: string,
  text: string,
  opts?: { log?: Log },
): Promise<"sent" | "busy" | "gone"> {
  const state = await threadState(threads, threadId, opts?.log ?? (() => {}));
  if (state !== "idle") return state;
  try {
    await threads.send({ threadId, mode: "start", input: [{ type: "text", text }] });
  } catch (e) {
    const { status, code } = apiError(e);
    if (status === 409 && code === "thread_not_writable") return "busy";
    throw e;
  }
  return "sent";
}

export function createIdleWaiters(
  kv: KvLike,
  handlers: Partial<Record<JobKind, IdleHandler>>,
  deps: { threads: ThreadDoor; log?: Log },
) {
  const log = deps.log ?? (() => {});
  const state = (threadId: string) => threadState(deps.threads, threadId, log);
  // One chain for every KV read-modify-write. Handlers run outside it, so a
  // handler can waitFor again without deadlocking.
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task);
    chain = run.catch(() => undefined);
    return run;
  };
  const read = async (): Promise<Job[]> => {
    // Per entry: one bad row is dropped, not the whole queue.
    const raw = await kv.get(IDLE_JOBS_KEY);
    return (Array.isArray(raw) ? raw : []).flatMap((r) => {
      const p = Job.safeParse(r);
      if (!p.success) log(`jira idle: dropped malformed job ${JSON.stringify(r)}`);
      return p.success ? [p.data as Job] : [];
    });
  };
  const update = (fn: (jobs: Job[]) => Job[]) =>
    locked(async () => {
      const jobs = await read();
      await kv.set(IDLE_JOBS_KEY, fn(jobs));
      return jobs;
    });
  const drop = (threadId: string, why: string) =>
    update((jobs) => {
      for (const j of jobs) if (j.threadId === threadId) log(`jira idle: dropped ${j.kind} job on ${threadId} (${why})`);
      return jobs.filter((j) => j.threadId !== threadId);
    }).then(() => undefined);

  // Taken jobs are removed before they run: at most once, never a retry loop.
  // No job for the thread (every idle, Jira off included): one read, no write.
  async function onIdle(threadId: string): Promise<void> {
    const taken = await locked(async () => {
      const jobs = await read();
      const mine = jobs.filter((j) => j.threadId === threadId && handlers[j.kind]);
      if (mine.length > 0) await kv.set(IDLE_JOBS_KEY, jobs.filter((j) => !mine.includes(j)));
      return mine;
    });
    for (const job of taken) {
      try {
        await handlers[job.kind]!(job.threadId, job.payload);
      } catch (e) {
        log(`jira idle job ${job.kind} on ${job.threadId} failed: ${(e as Error).message}`);
      }
    }
  }

  // Run queued jobs (optionally of one kind) on every thread that is at rest now.
  async function sweep(kind?: JobKind): Promise<void> {
    const ids = new Set((await read()).filter((j) => kind === undefined || j.kind === kind).map((j) => j.threadId));
    for (const threadId of ids) {
      const s = await state(threadId);
      if (s === "idle") await onIdle(threadId);
      else if (s === "gone") await drop(threadId, "thread gone");
    }
  }

  return {
    /** nextIdle: only on the next idle event (or restart), never at once: a retry after a send that threw. */
    async waitFor(threadId: string, kind: JobKind, payload?: JsonValue, opts?: { nextIdle?: boolean }): Promise<void> {
      const job: Job = { threadId, kind, ...(payload === undefined ? {} : { payload }), queuedAt: new Date().toISOString() };
      await update((jobs) => [...jobs.filter((j) => !(j.threadId === threadId && j.kind === kind)), job]);
      // The thread may have gone idle before the job was stored; its idle
      // event would then be missed.
      if (opts?.nextIdle !== true && (await state(threadId)) === "idle") await onIdle(threadId);
    },
    onIdle,
    /** Whether a job of one of these kinds is queued for the thread. */
    async queued(threadId: string, kinds: JobKind[]): Promise<boolean> {
      return (await read()).some((j) => j.threadId === threadId && kinds.includes(j.kind));
    },
    /** Drop every queued job of a thread (archived), logging each. */
    drop: (threadId: string) => drop(threadId, "thread archived"),
    resume: () => sweep(),
    /** Set a kind's handler, then run that kind's queued jobs on idle threads. */
    register(kind: JobKind, handler: IdleHandler): Promise<void> {
      handlers[kind] = handler;
      return sweep(kind).catch((e) => log(`jira idle sweep for ${kind} failed: ${(e as Error).message}`));
    },
  };
}
