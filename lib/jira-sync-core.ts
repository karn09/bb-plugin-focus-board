// One Jira/GitHub sync pass, run inside the plugin (lib/jira-server.ts
// syncPass). Drains the queued Jira writes through `acli`, then (when the
// pass is a full sync) fetches the operator's tickets and the linked PRs and
// hands one snapshot to the store. The runner is injected: production uses
// lib/jira-exec.ts runTool, tests a fake. A tool failure on a fetch goes
// into the snapshot (ok:false / error); only a failing ack or ingest
// rejects the pass.
import type { GhPr, JiraTicket, OpResult, QueueOp } from "./jira-schema";
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
  pendingOps: () => Promise<QueueOp[]>;
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
// those come from one `workitem view` per ticket (fetchTickets).
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
  };
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

export function createSyncCore(deps: SyncDeps) {
  const { run } = deps;
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
      const v = json(await acli("view", i.key, "--fields", "parent,updated", "--json"));
      const t = toTicket({ ...i, fields: { ...i.fields, ...v?.fields } }, me);
      t.openChildren = (await search(`parent = ${i.key} AND resolution = Unresolved`)).length;
      return t;
    });
    return { me, tickets };
  }

  // One unreadable PR (or search) skips just that ref; the failures are counted in snapshot.error.
  async function fetchPrs(wanted: SyncWanted, linkedKeys: string[]) {
    const prs: GhPr[] = [];
    const failed: string[] = [];
    for (const { repo, number } of wanted.prRefs) {
      let p: Raw;
      try {
        p = json(await run("gh", ["pr", "view", String(number), "-R", repo, "--json",
          "state,mergedAt,headRefName,title,body,statusCheckRollup,reviewDecision,updatedAt"]));
      } catch (e) {
        failed.push(msg(e));
        continue;
      }
      prs.push({
        repo, number, state: p.state === "MERGED" || p.mergedAt ? "merged" : p.state === "CLOSED" ? "closed" : "open",
        headRef: p.headRefName ?? "", title: p.title ?? "", body: p.body ?? "", checks: checksOf(p.statusCheckRollup),
        reviewDecision: REVIEW[p.reviewDecision] ?? null, updatedAt: p.updatedAt ?? "",
      });
    }
    const mentions: SyncSnapshot["mentions"] = [];
    const searchFailed: string[] = [];
    for (const key of linkedKeys) {
      let rs: Raw[];
      try {
        rs = json(await run("gh", ["search", "prs", key, "--merged", "--json", "repository,number,closedAt", "--limit", "10"])) ?? [];
      } catch (e) {
        searchFailed.push(msg(e));
        continue;
      }
      for (const r of rs) mentions.push({ key, repo: r.repository?.nameWithOwner ?? "", number: r.number, mergedAt: r.closedAt ?? "" });
    }
    const errors = [
      ...(failed.length ? [`gh: ${failed.length} of ${wanted.prRefs.length} PRs unreadable (${failed[0]})`] : []),
      ...(searchFailed.length ? [`gh: ${searchFailed.length} of ${linkedKeys.length} mention searches failed (${searchFailed[0]})`] : []),
    ];
    return { prs, mentions, error: errors.length ? errors.join("; ") : null };
  }

  async function pass(): Promise<void> {
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
        Object.assign(snap, await fetchPrs(wanted, wanted.linkedKeys.filter((k) => KEY.test(k))));
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
