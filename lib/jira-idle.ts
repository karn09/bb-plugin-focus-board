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
  send(args: { threadId: string; mode: "auto"; input: { type: "text"; text: string }[] }): Promise<unknown>;
}

const Job = z.object({
  threadId: z.string(),
  kind: z.enum(["done-check", "verify-turn", "nudge-turn", "find-ticket", "promote-epic"]),
  payload: z.unknown().optional(),
  queuedAt: z.string(),
});
type Job = { threadId: string; kind: JobKind; payload?: JsonValue; queuedAt: string };

// `idle` and `error` are at rest; active/starting/stopping/pending are running.
async function threadState(threads: ThreadDoor, threadId: string): Promise<"idle" | "busy" | "gone"> {
  let row: { status?: unknown; archivedAt?: unknown } | null;
  try {
    row = (await threads.get({ threadId })) as typeof row;
  } catch {
    return "gone";
  }
  if (!row || row.archivedAt != null) return "gone";
  return row.status === "idle" || row.status === "error" ? "idle" : "busy";
}

export async function sendIfIdle(threads: ThreadDoor, threadId: string, text: string): Promise<"sent" | "busy" | "gone"> {
  const state = await threadState(threads, threadId);
  if (state !== "idle") return state;
  await threads.send({ threadId, mode: "auto", input: [{ type: "text", text }] });
  return "sent";
}

export function createIdleWaiters(
  kv: KvLike,
  handlers: Partial<Record<JobKind, IdleHandler>>,
  deps: { threads: ThreadDoor; log?: (msg: string) => void },
) {
  const log = deps.log ?? (() => {});
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
      return p.success ? [p.data as Job] : [];
    });
  };
  const update = (fn: (jobs: Job[]) => Job[]) =>
    locked(async () => {
      const jobs = await read();
      const next = fn(jobs);
      await kv.set(IDLE_JOBS_KEY, next);
      return jobs;
    });

  // Taken jobs are removed before they run: at most once, never a retry loop.
  async function onIdle(threadId: string): Promise<void> {
    let taken: Job[] = [];
    await update((jobs) => {
      taken = jobs.filter((j) => j.threadId === threadId && handlers[j.kind]);
      return jobs.filter((j) => !taken.includes(j));
    });
    for (const job of taken) {
      try {
        await handlers[job.kind]!(job.threadId, job.payload);
      } catch (e) {
        log(`jira idle job ${job.kind} on ${job.threadId} failed: ${(e as Error).message}`);
      }
    }
  }

  return {
    async waitFor(threadId: string, kind: JobKind, payload?: JsonValue): Promise<void> {
      const job: Job = { threadId, kind, ...(payload === undefined ? {} : { payload }), queuedAt: new Date().toISOString() };
      await update((jobs) => [...jobs.filter((j) => !(j.threadId === threadId && j.kind === kind)), job]);
      // The thread may have gone idle before the job was stored; its idle
      // event would then be missed.
      if ((await threadState(deps.threads, threadId)) === "idle") await onIdle(threadId);
    },
    onIdle,
    async resume(): Promise<void> {
      for (const threadId of new Set((await read()).map((j) => j.threadId))) {
        const state = await threadState(deps.threads, threadId);
        if (state === "idle") await onIdle(threadId);
        else if (state === "gone") await update((jobs) => jobs.filter((j) => j.threadId !== threadId));
      }
    },
    register(kind: JobKind, handler: IdleHandler): void {
      handlers[kind] = handler;
    },
  };
}
