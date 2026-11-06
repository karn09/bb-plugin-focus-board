// One Jira/GitHub sync pass, run inside the plugin (lib/jira-server.ts
// syncPass). Drains the queued Jira writes through `acli`, then (when the
// pass is a full sync) fetches the operator's tickets and the linked PRs and
// hands one snapshot to the store. The runner is injected: production uses
// lib/jira-exec.ts runTool, tests a fake. A tool failure on a fetch goes
// into the snapshot (ok:false / error); only a failing ack or ingest
// rejects the pass.
import type { GhPr, JiraSnapshot, JiraTicket, OpResult, QueueOp } from "./jira-schema";
import { jiraBrowseUrl } from "./jira-keys";

export type ToolRunner = (tool: "acli" | "gh", args: readonly string[]) => Promise<string>;
export type SyncWanted = {
  projects: string[];
  linkedKeys: string[];
  prRefs: { repo: string; number: number }[];
  branchHeads: unknown[];
  /** false: drain the queue only (nothing due, no Refresh pending). */
  fullSync: boolean;
};
export type SyncDeps = {
  run: ToolRunner;
  wanted: () => Promise<SyncWanted>;
  /** The stored snapshot: its merged/closed PRs are reused, not re-read. */
  previous: () => Promise<JiraSnapshot | null>;
  pendingOps: () => Promise<QueueOp[]>;
  /** Re-checked right before each apply: false means the op was cancelled since the read (skip, no ack). */
  claim: (opId: string) => Promise<boolean>;
  ack: (results: OpResult[]) => Promise<void>;
  ingest: (snapshot: SyncSnapshot) => Promise<void>;
};
export type SyncSnapshot = {
  version: 1;
  takenAt: string;
  ok: boolean;
  error: string | null;
  me: { accountId: string };
  tickets: JiraTicket[];
  prs: GhPr[];
  mentions: { key: string; repo: string; number: number; mergedAt: string }[];
};

const KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const PROJ = /^[A-Z][A-Z0-9]+$/;
// acli's search only returns a fixed set of fields (parent, updated, subtasks are refused);
// those (and the description) come from one `workitem view` per ticket (fetchTickets).
const FIELDS = "key,summary,status,assignee,issuetype";
const msg = (e: unknown) => String((e as Error)?.message ?? e);
type Raw = any;
const json = (s: string): Raw => (s.trim() ? JSON.parse(s) : null);
const asList = (v: Raw): Raw[] => (Array.isArray(v) ? v : (v?.issues ?? v?.values ?? v?.comments ?? []));

// ---- acli JSON -> JiraTicket (REST v3 issue shape; defensive) ----
const CATS = new Set(["new", "indeterminate", "done"]);
const catByName = (n: string): JiraTicket["statusCategory"] =>
  /^(done|closed|resolved|invalid|n\/a)$/i.test(n) ? "done" : /^(to do|open|backlog)$/i.test(n) ? "new" : "indeterminate";
export function toTicket(raw: Raw, meAccountId: string): JiraTicket {
  const f = raw?.fields ?? {};
  const cat = f.status?.statusCategory?.key;
  const a = f.assignee;
  const parent = f.parent?.key && KEY.test(f.parent.key) ? f.parent : null;
  const type = f.issuetype?.name ?? "";
  let desc: string | undefined;
  try {
    desc = descriptionText(f.description);
  } catch {
    desc = undefined; // a bad description costs only itself, never the fetch
  }
  return {
    key: raw.key,
    summary: f.summary ?? "",
    status: f.status?.name ?? "",
    statusCategory: CATS.has(cat) ? cat : catByName(f.status?.name ?? ""),
    assignee: a?.accountId ? { accountId: a.accountId, displayName: a.displayName ?? "" } : null,
    assignedToMe: !!a?.accountId && a.accountId === meAccountId,
    issueType: type,
    isEpic: type === "Epic",
    parentKey: parent?.key ?? null,
    epicKey: parent && parent.fields?.issuetype?.name === "Epic" ? parent.key : null,
    openChildren: 0,
    updatedAt: f.updated ?? "",
    // `self` points at an internal API host, never the browse site.
    url: jiraBrowseUrl(raw.key),
    ...(desc === undefined ? {} : { description: desc }),
  };
}

const DESC_MAX = 2_000;
const ADF_MAX_DEPTH = 50;
/** Plain text of one ADF node: blocks end in a blank line, list items read "- ". Deeper than the cap is dropped. */
function adfText(n: Raw, depth = 0): string {
  if (!n || typeof n !== "object" || depth > ADF_MAX_DEPTH) return "";
  if (n.type === "text") return typeof n.text === "string" ? n.text : "";
  if (n.type === "hardBreak") return "\n";
  if (n.type === "mention") return typeof n.attrs?.text === "string" ? n.attrs.text : "";
  const inner = Array.isArray(n.content) ? n.content.map((c: Raw) => adfText(c, depth + 1)).join("") : "";
  if (n.type === "listItem") return `- ${inner.trim()}\n`;
  if (n.type === "paragraph" || n.type === "heading" || n.type === "codeBlock" || n.type === "blockquote") return `${inner}\n\n`;
  if (n.type === "bulletList" || n.type === "orderedList") return `${inner}\n`;
  return inner;
}
/**
 * A ticket description as plain text: Jira REST v3 sends Atlassian Document
 * Format (an object tree), a string passes through, anything else is
 * omitted. Capped at 2,000 chars with "…".
 */
export function descriptionText(v: unknown): string | undefined {
  const raw = typeof v === "string" ? v : v && typeof v === "object" && typeof (v as Raw).type === "string" ? adfText(v) : "";
  const text = raw.replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return undefined;
  return text.length > DESC_MAX ? `${text.slice(0, DESC_MAX - 1)}…` : text;
}

/** map with at most `n` in flight, results in input order. */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

// ponytail: acli has no "list transitions"; map category -> conventional status names and try in order.
const TARGETS: Record<string, string[]> = { done: ["Done", "Closed", "Resolved"], indeterminate: ["In Progress"] };
const FAIL = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
function checksOf(rollup: Raw): GhPr["checks"] {
  if (!Array.isArray(rollup) || !rollup.length) return "none";
  let pending = false;
  for (const c of rollup) {
    if (FAIL.has(c.conclusion) || FAIL.has(c.state)) return "fail";
    if ((c.status && c.status !== "COMPLETED") || c.state === "PENDING" || c.state === "EXPECTED") pending = true;
  }
  return pending ? "pending" : "pass";
}
const REVIEW: Record<string, GhPr["reviewDecision"]> = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", REVIEW_REQUIRED: "review_required" };

const MENTIONS_TTL_MS = 30 * 60_000;
const CLOSED_QUIET_MS = 24 * 60 * 60_000;

export function createSyncCore(deps: SyncDeps) {
  const { run } = deps;
  // ponytail: in-memory (the snapshot schema has no per-key fetch time); a restart refetches every key once.
  const mentionCache = new Map<string, { at: number; rows: SyncSnapshot["mentions"] }>();
  const acli = (...a: string[]) => run("acli", ["jira", "workitem", ...a]);
  const search = async (jql: string) => asList(json(await acli("search", "--jql", jql, "--fields", FIELDS, "--json", "--paginate")));

  async function applyOp(op: QueueOp): Promise<string | null> {
    switch (op.op) {
      case "transition": {
        const cur = json(await acli("view", op.key, "--fields", "status", "--json"));
        if (cur?.fields?.status?.statusCategory?.key === op.toCategory) return null;
        const names = TARGETS[op.toCategory];
        if (!names) throw new Error(`unsupported toCategory: ${op.toCategory}`);
        let last: unknown;
        for (const s of names) {
          try {
            await acli("transition", "--key", op.key, "--status", s, "--yes");
            return null;
          } catch (e) {
            last = e;
          }
        }
        throw last;
      }
      case "assign":
        await acli("assign", "--key", op.key, ...(op.to === "me" ? ["--assignee", "@me"] : ["--remove-assignee"]), "--yes");
        return null;
      case "comment": {
        const marker = `[fb:${op.id}]`;
        if ((await acli("comment", "list", "--key", op.key, "--json", "--paginate")).includes(marker)) return null;
        await acli("comment", "create", "--key", op.key, "--body", `${op.body}\n\n${marker}`);
        return null;
      }
      case "create": {
        const marker = `[fb:${op.id}]`;
        // Replay-safe: a crash/failed ack after create must not make a duplicate next pass.
        const found = asList(json(await acli("search", "--jql", `project = ${op.project} AND description ~ "fb:${op.id}"`, "--fields", "key", "--json")));
        if (found[0]?.key && KEY.test(found[0].key)) return found[0].key;
        const out = await acli("create", "--project", op.project, "--type", op.issueType, "--summary", op.summary,
          "--description", `${op.description}\n\n${marker}`, ...(op.parentKey ? ["--parent", op.parentKey] : []), "--json");
        const key = json(out)?.key ?? out.match(/[A-Z][A-Z0-9]+-\d+/)?.[0];
        if (!key || !KEY.test(key)) throw new Error("create returned no key");
        return key;
      }
      default:
        throw new Error(`unknown op ${(op as { op: string }).op}`);
    }
  }

  /** Apply then ack each op in order: a crash leaves at most one applied-but-unacked op, replay-safe above. */
  async function drain() {
    for (const op of await deps.pendingOps()) {
      if (!(await deps.claim(op.id))) continue;
      let r: OpResult;
      try {
        r = { id: op.id, ok: true, error: null, createdKey: await applyOp(op) };
      } catch (e) {
        r = { id: op.id, ok: false, error: msg(e).slice(0, 500), createdKey: null };
      }
      await deps.ack([r]);
    }
  }

  async function fetchTickets(wanted: SyncWanted) {
    const projects = wanted.projects.filter((p) => PROJ.test(p));
    const linked = wanted.linkedKeys.filter((k) => KEY.test(k));
    // A result key goes into `view <key>` and `parent = <key>`: only well-formed keys get that far.
    const wellFormed = (list: Raw[]) => list.filter((i) => typeof i?.key === "string" && KEY.test(i.key));
    const mine = wellFormed(await search(
      `assignee = currentUser() AND resolution = Unresolved${projects.length ? ` AND project in (${projects.join(",")})` : ""}`,
    ));
    const mineKeys = new Set(mine.map((i) => i.key));
    const extra = linked.length ? wellFormed(await search(`key in (${linked.join(",")})`)).filter((i) => !mineKeys.has(i.key)) : [];
    // `me` comes from the assignee of the currentUser() query; "" when we have no tickets (acli has no whoami).
    const me: string = mine.find((i) => i.fields?.assignee?.accountId)?.fields.assignee.accountId ?? "";
    const tickets = await pool([...mine, ...extra], 5, async (i) => {
      const v = json(await acli("view", i.key, "--fields", "parent,updated,description", "--json"));
      const t = toTicket({ ...i, fields: { ...i.fields, ...v?.fields } }, me);
      t.openChildren = (await search(`parent = ${i.key} AND resolution = Unresolved`)).length;
      return t;
    });
    return { me, tickets };
  }

  // One unreadable PR (or search) skips just that ref; the failures are counted in snapshot.error.
  // A merged PR never changes: reused, not re-read. A closed one can be reopened: reused
  // only on a scheduled pass once quiet for 24h. manual (`jira sync`, Refresh, a Done data wait) skips the mention cache.
  async function fetchPrs(wanted: SyncWanted, linkedKeys: string[], previous: JiraSnapshot | null, manual: boolean) {
    const terminal = new Map<string, GhPr>();
    for (const p of previous?.prs ?? []) {
      const quiet = Date.now() - Date.parse(p.updatedAt) > CLOSED_QUIET_MS; // NaN (no updatedAt): not quiet
      if (p.state === "merged" || (p.state === "closed" && quiet && !manual)) terminal.set(`${p.repo}#${p.number}`, p);
    }
    const failed: string[] = [];
    let attempted = 0;
    const prs = await pool(wanted.prRefs, 6, async ({ repo, number }): Promise<GhPr | null> => {
      const kept = terminal.get(`${repo}#${number}`);
      if (kept) return kept;
      attempted++;
      let p: Raw;
      try {
        p = json(await run("gh", ["pr", "view", String(number), "-R", repo, "--json",
          "state,mergedAt,headRefName,title,body,statusCheckRollup,reviewDecision,updatedAt"]));
        if (!p || typeof p !== "object") throw new Error(`gh pr view ${number} -R ${repo}: no JSON`);
      } catch (e) {
        failed.push(msg(e));
        return null;
      }
      return {
        repo, number, state: p.state === "MERGED" || p.mergedAt ? "merged" : p.state === "CLOSED" ? "closed" : "open",
        headRef: p.headRefName ?? "", title: p.title ?? "", body: p.body ?? "", checks: checksOf(p.statusCheckRollup),
        reviewDecision: REVIEW[p.reviewDecision] ?? null, updatedAt: p.updatedAt ?? "",
      };
    });
    // GitHub search allows ~30 requests/min: 3 at a time, and each key at most once per 30 minutes.
    const searchFailed: string[] = [];
    let searched = 0;
    const mentions = await pool(linkedKeys, 3, async (key): Promise<SyncSnapshot["mentions"]> => {
      const hit = mentionCache.get(key);
      if (hit && !manual && Date.now() - hit.at < MENTIONS_TTL_MS) return hit.rows;
      searched++;
      let rs: Raw[];
      try {
        rs = json(await run("gh", ["search", "prs", key, "--merged", "--json", "repository,number,closedAt", "--limit", "10"])) ?? [];
      } catch (e) {
        searchFailed.push(msg(e));
        return [];
      }
      const rows = rs.map((r) => ({ key, repo: r.repository?.nameWithOwner ?? "", number: r.number, mergedAt: r.closedAt ?? "" }));
      mentionCache.set(key, { at: Date.now(), rows });
      return rows;
    });
    const errors = [
      ...(failed.length ? [`gh: ${failed.length} of ${attempted} PRs unreadable (${failed[0]})`] : []),
      ...(searchFailed.length ? [`gh: ${searchFailed.length} of ${searched} mention searches failed (${searchFailed[0]})`] : []),
    ];
    return { prs: prs.filter((p): p is GhPr => p !== null), mentions: mentions.flat(), error: errors.length ? errors.join("; ") : null };
  }

  async function pass({ manual = false }: { manual?: boolean } = {}): Promise<void> {
    const wanted = await deps.wanted();
    await drain();
    // Queued writes always go out; Jira/GitHub are fetched only when a pass is due or Refresh is pending.
    if (wanted.fullSync === false) return;
    const snap: SyncSnapshot = { version: 1, takenAt: new Date().toISOString(), ok: true, error: null, me: { accountId: "" }, tickets: [], prs: [], mentions: [] };
    try {
      const { me, tickets } = await fetchTickets(wanted);
      snap.me.accountId = me;
      snap.tickets = tickets;
    } catch (e) {
      snap.ok = false;
      snap.error = msg(e);
    }
    if (snap.ok) {
      try {
        Object.assign(snap, await fetchPrs(wanted, wanted.linkedKeys.filter((k) => KEY.test(k)),
          await deps.previous().catch(() => null), manual)); // an unreadable snapshot: fetch everything
      } catch (e) {
        snap.prs = [];
        snap.mentions = [];
        snap.error = msg(e);
      }
    }
    await deps.ingest(snap);
  }

  return { pass };
}
