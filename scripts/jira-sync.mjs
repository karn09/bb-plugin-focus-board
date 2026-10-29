#!/usr/bin/env node
// Focus Board Jira companion: one sync pass, run as a bb script automation.
// Talks to Jira via `acli`, GitHub via `gh`, and to the plugin ONLY via
// `bb focus-board jira ...`. Shapes mirror lib/jira-schema.ts (zod); keep in sync.
// Exit 0 on any completed pass (acli/gh failures go into the snapshot); non-zero only on a crash.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const PROJ = /^[A-Z][A-Z0-9]+$/;
const FIELDS = "key,summary,status,assignee,issuetype,parent,updated";
const run = async (cmd, args) => {
  try {
    return (await exec(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })).stdout;
  } catch (e) {
    throw new Error(`${cmd} ${args[0] ?? ""} failed: ${(e.stderr || e.message || "").toString().trim()}`.slice(0, 500));
  }
};
const json = (s) => (s.trim() ? JSON.parse(s) : null);
const bb = (...a) => run("bb", ["focus-board", "jira", ...a]);
const acli = (...a) => run("acli", ["jira", "workitem", ...a]);

/** Hand a JSON value to a bb command via a temp file (stdin `--file -` is unsupported). */
async function bbFile(sub, value) {
  const d = await mkdtemp(join(tmpdir(), "jira-sync-"));
  try {
    const p = join(d, "in.json");
    await writeFile(p, JSON.stringify(value));
    await bb(sub, "--file", p);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
}

// ---- acli JSON -> JiraTicket (REST v3 issue shape; defensive) ----
const CATS = new Set(["new", "indeterminate", "done"]);
const origin = (self) => {
  try { return new URL(self).origin; } catch { return (process.env.JIRA_BASE_URL || "https://growtherapy.atlassian.net").replace(/\/$/, ""); }
};
const catByName = (n) =>
  /^(done|closed|resolved|invalid|n\/a)$/i.test(n) ? "done" : /^(to do|open|backlog)$/i.test(n) ? "new" : "indeterminate";
export function toTicket(raw, meAccountId) {
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
    url: `${origin(raw.self)}/browse/${raw.key}`,
  };
}

const asList = (v) => (Array.isArray(v) ? v : (v?.issues ?? v?.values ?? v?.comments ?? []));
const search = async (jql) => asList(json(await acli("search", "--jql", jql, "--fields", FIELDS, "--json", "--paginate")));

// ---- queue ops ----
// ponytail: acli has no "list transitions"; map category -> conventional status names and try in order.
const TARGETS = { done: ["Done", "Closed", "Resolved"], indeterminate: ["In Progress"] };

async function applyOp(op) {
  switch (op.op) {
    case "transition": {
      const cur = json(await acli("view", op.key, "--fields", "status", "--json"));
      if (cur?.fields?.status?.statusCategory?.key === op.toCategory) return null;
      if (!TARGETS[op.toCategory]) throw new Error(`unsupported toCategory: ${op.toCategory}`);
      let last;
      for (const s of TARGETS[op.toCategory]) {
        try { await acli("transition", "--key", op.key, "--status", s, "--yes"); return null; } catch (e) { last = e; }
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
      throw new Error(`unknown op ${op.op}`);
  }
}

async function drain() {
  const { ops } = json(await bb("queue", "--json"));
  for (const op of ops) {
    let r;
    try { r = { id: op.id, ok: true, error: null, createdKey: await applyOp(op) }; }
    catch (e) { r = { id: op.id, ok: false, error: String(e.message ?? e).slice(0, 500), createdKey: null }; }
    await bbFile("ack", [r]);
  }
}

// ---- tickets ----
async function fetchTickets(wanted) {
  const projects = wanted.projects.filter((p) => PROJ.test(p));
  const linked = wanted.linkedKeys.filter((k) => KEY.test(k));
  const mine = await search(
    `assignee = currentUser() AND resolution = Unresolved${projects.length ? ` AND project in (${projects.join(",")})` : ""}`,
  );
  const mineKeys = new Set(mine.map((i) => i.key));
  const extra = linked.length ? (await search(`key in (${linked.join(",")})`)).filter((i) => !mineKeys.has(i.key)) : [];
  // `me` comes from the assignee of the currentUser() query; "" when we have no tickets (acli has no whoami).
  const me = mine.find((i) => i.fields?.assignee?.accountId)?.fields.assignee.accountId ?? "";
  const tickets = [...mine, ...extra].map((i) => toTicket(i, me));
  const parents = tickets.map((t) => t.key); // any ticket can be a parent
  if (parents.length) {
    const counts = {};
    for (const c of await search(`parent in (${parents.join(",")}) AND resolution = Unresolved`))
      if (c.fields?.parent?.key) counts[c.fields.parent.key] = (counts[c.fields.parent.key] ?? 0) + 1;
    for (const t of tickets) t.openChildren = counts[t.key] ?? 0;
  }
  return { me, tickets };
}

// ---- PRs ----
const FAIL = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
function checksOf(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return "none";
  let pending = false;
  for (const c of rollup) {
    if (FAIL.has(c.conclusion) || FAIL.has(c.state)) return "fail";
    if ((c.status && c.status !== "COMPLETED") || c.state === "PENDING" || c.state === "EXPECTED") pending = true;
  }
  return pending ? "pending" : "pass";
}
const REVIEW = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", REVIEW_REQUIRED: "review_required" };

// One unreadable PR (or search) skips just that ref; the failures are counted in snapshot.error.
async function fetchPrs(wanted, linkedKeys) {
  const prs = [];
  const failed = [];
  for (const { repo, number } of wanted.prRefs) {
    let p;
    try {
      p = json(await run("gh", ["pr", "view", String(number), "-R", repo, "--json",
        "state,mergedAt,headRefName,title,body,statusCheckRollup,reviewDecision,updatedAt"]));
    } catch (e) {
      failed.push(String(e.message ?? e));
      continue;
    }
    prs.push({
      repo, number, state: p.state === "MERGED" || p.mergedAt ? "merged" : p.state === "CLOSED" ? "closed" : "open",
      headRef: p.headRefName ?? "", title: p.title ?? "", body: p.body ?? "", checks: checksOf(p.statusCheckRollup),
      reviewDecision: REVIEW[p.reviewDecision] ?? null, updatedAt: p.updatedAt ?? "",
    });
  }
  const mentions = [];
  const searchFailed = [];
  for (const key of linkedKeys) {
    let rs;
    try {
      rs = json(await run("gh", ["search", "prs", key, "--merged", "--json", "repository,number,closedAt", "--limit", "10"])) ?? [];
    } catch (e) {
      searchFailed.push(String(e.message ?? e));
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

export async function main() {
  const wanted = json(await bb("wanted", "--json"));
  await drain();
  const snap = { version: 1, takenAt: new Date().toISOString(), ok: true, error: null, me: { accountId: "" }, tickets: [], prs: [], mentions: [] };
  try {
    const { me, tickets } = await fetchTickets(wanted);
    snap.me.accountId = me;
    snap.tickets = tickets;
  } catch (e) {
    snap.ok = false;
    snap.error = String(e.message ?? e);
  }
  if (snap.ok) {
    try {
      const linked = wanted.linkedKeys.filter((k) => KEY.test(k));
      Object.assign(snap, await fetchPrs(wanted, linked));
    } catch (e) {
      snap.prs = [];
      snap.mentions = [];
      snap.error = String(e.message ?? e);
    }
  }
  await bbFile("ingest", snap);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
