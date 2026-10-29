// Jira snapshot / write-queue / per-thread record store. Pure over minimal
// KV and thread-metadata slices so the server, CLI bridge and tests share it.
import {
  JiraSnapshot,
  OpResult,
  QueueOp,
  THREAD_JIRA_KEY,
  ThreadJiraRecord,
} from "./jira-schema";

export interface KvLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
}
export interface MetadataLike {
  getPluginMetadata(args: { threadId: string }): Promise<unknown>;
  updatePluginMetadata(args: {
    threadId: string;
    set?: Record<string, any>;
  }): Promise<unknown>;
}

const SNAPSHOT_KEY = "jira:snapshot";
const QUEUE_KEY = "jira:queue";
const SNAPSHOT_FAILURE_KEY = "jira:snapshot-failure";
const RESULTS_KEY = "jira:results";
const MAX_RESULTS = 200;

const emptyRecord = (): ThreadJiraRecord => ({
  links: [],
  enrolledAt: null,
  verifying: null,
  doneCheck: null,
  nudgedAt: null,
  deepCheckedAt: null,
  reason: null,
  checkInWith: null,
});

/** Keep the last occurrence per key, in first-seen order. */
function dedupeLinks(links: ThreadJiraRecord["links"]): ThreadJiraRecord["links"] {
  const byKey = new Map<string, ThreadJiraRecord["links"][number]>();
  for (const l of links) byKey.set(l.key, l);
  return [...byKey.values()];
}

export function createJiraStore(
  kv: KvLike,
  threads: MetadataLike,
  now: () => number,
  opts?: { refreshMinutes?: () => number | Promise<number>; log?: (msg: string) => void },
) {
  // One in-process chain serializes every read-modify-write (rows and
  // thread records alike), like the board's withKvWriteLock.
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };

  const log = opts?.log ?? (() => {});
  // Raw stored entries; unparseable ones are kept untouched in storage.
  const rawQueue = async (): Promise<unknown[]> => {
    const raw = await kv.get(QUEUE_KEY);
    return Array.isArray(raw) ? raw : [];
  };
  const readQueue = async (): Promise<QueueOp[]> =>
    (await rawQueue()).flatMap((x) => {
      const p = QueueOp.safeParse(x);
      if (!p.success) log(`jira queue: skipping invalid entry: ${p.error.message}`);
      return p.success ? [p.data] : [];
    });
  const readResults = async (): Promise<OpResult[]> => {
    const raw = await kv.get(RESULTS_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((x) => {
      const p = OpResult.safeParse(x);
      return p.success ? [p.data] : [];
    });
  };
  const readThread = async (threadId: string): Promise<ThreadJiraRecord> => {
    const ns = (await threads.getPluginMetadata({ threadId })) as Record<string, unknown> | null;
    const p = ThreadJiraRecord.safeParse(ns?.[THREAD_JIRA_KEY]);
    return p.success ? p.data : emptyRecord();
  };

  return {
    async ingestSnapshot(raw: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
      const parsed = JiraSnapshot.safeParse(raw);
      let failure: string | null = null;
      if (parsed.success && parsed.data.ok) {
        await locked(async () => {
          await kv.set(SNAPSHOT_KEY, parsed.data);
          await kv.set(SNAPSHOT_FAILURE_KEY, null);
        });
        return { ok: true };
      }
      if (parsed.success) failure = parsed.data.error ?? "snapshot not ok";
      else {
        const r = raw as { ok?: unknown; error?: unknown } | null;
        if (r !== null && typeof r === "object" && r.ok === false) {
          failure = typeof r.error === "string" ? r.error : "snapshot not ok";
        }
      }
      if (failure === null) return { ok: false, error: parsed.error?.message ?? "invalid snapshot" };
      // A failed refresh keeps the prior good snapshot; it only marks it stale.
      await locked(() => kv.set(SNAPSHOT_FAILURE_KEY, failure));
      return { ok: true };
    },

    async readSnapshot(): Promise<{
      snapshot: JiraSnapshot | null;
      ageMs: number | null;
      stale: boolean;
      /** Last refresh failure (kept even with no prior good snapshot), else null. */
      error: string | null;
    }> {
      const failure = await kv.get(SNAPSHOT_FAILURE_KEY);
      const error = typeof failure === "string" ? failure : null;
      const p = JiraSnapshot.safeParse(await kv.get(SNAPSHOT_KEY));
      if (!p.success) return { snapshot: null, ageMs: null, stale: true, error };
      const taken = Date.parse(p.data.takenAt);
      const ageMs = Number.isNaN(taken) ? null : Math.max(0, now() - taken);
      const refresh = (await opts?.refreshMinutes?.()) ?? 2;
      return { snapshot: p.data, ageMs, stale: failure != null || ageMs === null || ageMs > 2 * refresh * 60_000, error };
    },

    enqueue(op: Omit<QueueOp, "id" | "createdAt">): Promise<QueueOp> {
      return locked(async () => {
        const full = { ...op, id: crypto.randomUUID(), createdAt: new Date(now()).toISOString() } as QueueOp;
        await kv.set(QUEUE_KEY, [...(await rawQueue()), full]);
        return full;
      });
    },

    // Not popped on read: issued but un-acked ops stay until ack removes them.
    pendingOps: readQueue,

    ack(results: OpResult[]): Promise<void> {
      return locked(async () => {
        const queue = await readQueue();
        const known = new Set(queue.map((o) => o.id));
        // Unknown ids (replayed ack) are ignored; duplicate ids in a batch count once.
        const hits = [...new Map(results.filter((r) => known.has(r.id)).map((r) => [r.id, r])).values()];
        if (hits.length === 0) return;
        const done = new Set(hits.map((r) => r.id));
        // Results first: a crash between the writes leaves the op queued AND recorded.
        await kv.set(RESULTS_KEY, [...(await readResults()), ...hits].slice(-MAX_RESULTS));
        const raw = await rawQueue();
        await kv.set(
          QUEUE_KEY,
          raw.filter((x) => {
            const p = QueueOp.safeParse(x);
            return !(p.success && done.has(p.data.id));
          }),
        );
      });
    },

    async lastResult(opId: string): Promise<OpResult | null> {
      return (await readResults()).find((r) => r.id === opId) ?? null;
    },

    async recentResults(n: number): Promise<OpResult[]> {
      return (await readResults()).slice(-n);
    },

    readThread,

    writeThread(threadId: string, patch: Partial<ThreadJiraRecord>): Promise<ThreadJiraRecord> {
      return locked(async () => {
        const cur = await readThread(threadId);
        const next: ThreadJiraRecord = {
          ...cur,
          ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
          links: dedupeLinks([...cur.links, ...(patch.links ?? [])]),
        };
        await threads.updatePluginMetadata({ threadId, set: { [THREAD_JIRA_KEY]: next } });
        return next;
      });
    },
  };
}

export type JiraStore = ReturnType<typeof createJiraStore>;
