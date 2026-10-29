# Jira on the Focus Board: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Jira column, ticket matching, a Done check, reminders (nudge
and deeper check) and reconciliation of existing threads to the Focus Board
fork, without breaking any thread that is already running.

**Architecture:** The plugin never runs other programs. A companion
script, run as a bb script automation, does that instead:
- It runs `acli` and `gh`, and talks to the plugin only through new
  `bb focus-board jira …` CLI commands. It sends in a snapshot, drains the
  queue of Jira writes, and reports each result back.
- The plugin keeps all its state in `bb.storage.kv` and per-thread plugin
  metadata.
- Jira writes made inside a thread are done by that thread's agent, guided by
  `bb.agents.configure` instructions.
- Behavior lives in new `lib/jira-*.ts` and `components/jira-*.tsx` files,
  with small, named hook-ins to existing files.

**Tech Stack:** TypeScript, React (board), zod 4, vitest, `@get-bb/plugin-sdk`
^0.6.19, Node 20+ for `scripts/jira-sync.mjs`, `acli` (Atlassian CLI), `gh`.

**Spec:** `docs/superpowers/specs/2026-10-29-jira-integration-design.md`

## Global Constraints

- No `child_process` and no `shell: true` anywhere in `server.ts`, `app.tsx`,
  `lib/` or `components/`, *comments included*. This is enforced by
  `tests/security-no-process-execution.test.ts` and `npm run gates`.
  `scripts/` isn't shipped code, so the companion script may use `execFile`
  there (argument arrays, never a shell).
- No stored tokens. Jira access uses only the operator's `acli` OAuth login.
- Jira projects searched: `["PT", "SRE"]`. Default project for new tickets:
  `"SRE"`.
- Defaults (all are settings):
  - nudge after **2** days
  - deeper check after **5** days (clamped so it's always more than the nudge)
  - stale ticket after **30** days
  - at most **3** nudge turns per scheduler pass
  - snapshot refresh every **2** minutes
  - stale snapshot after **2 × refresh** (4 minutes)
- *Never* send a turn to a running thread (bb status `active`). Check that a
  thread is idle immediately before every `threads.send`.
- Never mark a thread Done automatically. Never transition an epic. A
  skipped check ("Mark done anyway") comments but never transitions.
- Fuzzy matches and PR-body key matches are *suggestions only*. Only an
  exact key in a thread's title, branch or an existing link auto-links.
- The feature is off until the operator turns it on (`jiraEnabled` setting,
  default `false`). With it off, the board behaves exactly like upstream.
- `npm test`, `npm run typecheck` and `npm run gates` pass at every commit.
  Never create a `node_modules` symlink (see `AGENTS.md`).

## Review Focus

1. **A thread starts running between the idle check and the send.** The
   expected behavior is that the send doesn't happen and the work is retried
   on the next `thread.idle`. Pinned in Task 6 (`sendIfIdle` re-reads status;
   a test makes `get` flip to active).
2. **The companion script was never set up, or `acli` is signed out.** The
   snapshot is missing or stale. Expected: no auto-pass in the Done check, no
   "PR merged" reason on nudges, and the Jira column shows "Jira not
   connected" or "data N min old". Pinned in Tasks 3, 9 and 10.
3. **Look-alike keys in titles** ("UTF-8", "GLM-5", "INC-340"). Expected:
   only keys in configured projects that exist in the snapshot auto-link.
   Others are ignored, or suggested once the snapshot confirms them. Pinned
   in Tasks 1 and 5.
4. **One ticket linked from many threads** (PT-3879 has seven). Expected: the
   ticket transitions only when *every* linked thread is Done, and drift
   counts PRs across all of them. Pinned in Tasks 8 and 9.
5. **The script crashes mid-drain and replays queue ops.** Expected: each op
   applies at most once, with no duplicate Jira comments. Pinned in Tasks 3
   and 4 (op ids, ack-before-reissue, an `[fb:<opId>]` marker checked
   before commenting).

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/jira-keys.ts` | Key regex, extracting keys from text, project filter |
| `lib/jira-schema.ts` | zod schemas: `JiraSnapshot`, `QueueOp`, `OpResult`, `ThreadJiraRecord` |
| `lib/jira-settings.ts` | Setting defaults and clamping |
| `lib/jira-store.ts` | KV snapshot (ingest, read, staleness), write queue (enqueue, drain, ack), thread record read/write |
| `lib/jira-idle.ts` | `sendIfIdle`: the only path to `threads.send` for this feature |
| `lib/jira-reconcile.ts` | Pure reconcile planner and its apply step |
| `lib/jira-drift.ts` | Pure drift detection per ticket |
| `lib/jira-done-check.ts` | Done-check state machine (pure) and ticket-update decision |
| `lib/jira-reminders.ts` | Pure quiet-time math, nudge selection, deeper-check findings |
| `lib/jira-agent.ts` | `agents.configure` instruction text and tool handlers |
| `lib/jira-server.ts` | Wires everything into the bb host: RPC, CLI, events, schedule |
| `components/jira-column.tsx` | Jira column and ticket cards |
| `components/jira-card-badges.tsx` | Thread-card Jira chip, reason line, Done-check badges and buttons |
| `scripts/jira-sync.mjs` | Companion script: `acli`/`gh` ↔ `bb focus-board jira …` |
| `docs/fork-notes.md` | The hook-in points, for upstream rebases |
| Modify `server.ts` | Call `registerJira(bb, deps)` once; route `done_set` through the Done check |
| Modify `components/grouping.ts` | Prepend the Jira column (Attention view); a `jira.reason` on a thread puts it in `attention` |
| Modify `components/thread-card.tsx` | Render `JiraCardBadges` |
| Modify `lib/link-metadata.ts` | Optional `jira: { key }` on `ExternalItemLink` |

Tests: one `tests/jira-<unit>.test.ts` per lib file, plus
`tests/jira-column.test.tsx`, `tests/jira-cli.test.ts`,
`tests/jira-sync-script.test.ts` and `tests/jira-running-threads.test.ts`.
Add every new test to `docs/test-coverage-matrix.md`, as the repo requires.

---

### Task 1: Keys, schemas, settings

**Files:**
- Create: `lib/jira-keys.ts`, `lib/jira-schema.ts`, `lib/jira-settings.ts`
- Modify: `server.ts`, adding settings in the existing `bb.settings.define`
  block (around line 770, next to the sweep settings)
- Modify: `lib/link-metadata.ts`, adding the `jira` field
- Test: `tests/jira-keys.test.ts`, `tests/jira-schema.test.ts`,
  `tests/jira-settings.test.ts`

**Interfaces (Produces):**
- `JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+)-(\d+)\b/g`
- `extractJiraKeys(text: string, projects: readonly string[]): string[]`:
  unique keys, in order of appearance, filtered to `projects`
- `jiraBrowseUrl(key: string): string` returns
  `https://growtherapy.atlassian.net/browse/${key}`
- `JiraTicket = { key, summary, status, statusCategory: "new"|"indeterminate"|"done", assignee: { accountId, displayName } | null, assignedToMe: boolean, issueType, isEpic: boolean, parentKey: string|null, epicKey: string|null, openChildren: number, updatedAt: string, url }`
- `GhPr = { repo, number, state: "open"|"closed"|"merged", headRef, title, body, checks: "pass"|"fail"|"pending"|"none", reviewDecision: "approved"|"changes_requested"|"review_required"|null, updatedAt }`
- `JiraSnapshot = { version: 1, takenAt: string, ok: boolean, error: string|null, me: { accountId }, tickets: JiraTicket[], prs: GhPr[], mentions: { key, repo, number, mergedAt }[] }`
- `QueueOp = { id: string, createdAt: string, threadId: string|null } & ({ op: "transition", key, toCategory: "indeterminate"|"done" } | { op: "assign", key, to: "me"|"none" } | { op: "comment", key, body } | { op: "create", project, issueType: "Task"|"Story"|"Epic"|"Sub-task", summary, description, parentKey: string|null })`
- `OpResult = { id, ok: boolean, error: string|null, createdKey: string|null }`
- `ThreadJiraRecord = { links: { key, role: "owner"|"watching", source: "auto"|"agent"|"operator" }[], enrolledAt: string|null, verifying: { startedAt, reasons?: string[] } | null, doneCheck: { at, verdict: "pass"|"fail"|"pending-confirm", reasons: string[], skipped?: true } | null, nudgedAt: string|null, deepCheckedAt: string|null, reason: string|null, checkInWith: string|null, epicSuggested?: true }`
- `THREAD_JIRA_KEY = "jira"`, the plugin metadata key
- `ExternalItemLink.jira?: { key: string }`
- `jiraSettings(raw): { enabled, projects, defaultProject, nudgeDays, deepCheckDays, staleTicketDays, nudgeTurnsPerPass, refreshMinutes }`
  - defaults: `false, ["PT","SRE"], "SRE", 2, 5, 30, 3, 2`
  - `deepCheckDays = max(deepCheckDays, nudgeDays + 1)`
  - days are floored at 1

- [ ] **Step 1: Write failing tests**
  - `extractJiraKeys("PT-3879: Karpenter monitors", ["PT","SRE"])` returns
    `["PT-3879"]`.
  - `extractJiraKeys("UTF-8 fix, GLM-5, INC-340", ["PT","SRE"])` returns `[]`.
  - `extractJiraKeys("pt-12 PT-12 PT-12", ["PT"])` returns `["PT-12"]`.
  - `JiraSnapshot.parse` rejects `version: 2`, and rejects a ticket missing
    `key`.
  - `QueueOp.parse` rejects an `op: "transition"` whose `key` is `"x; rm"`.
    Keys must match `^[A-Z][A-Z0-9]+-\d+$`.
  - `jiraSettings({})` deep-equals the defaults above.
  - `jiraSettings({ nudgeDays: 4, deepCheckDays: 3 }).deepCheckDays === 5`.
  - `parseLinkedIssues` round-trips an external link carrying
    `jira: { key: "PT-1" }`, and drops a malformed `jira`.
- [ ] **Step 2: Run** `npx vitest run tests/jira-keys.test.ts tests/jira-schema.test.ts tests/jira-settings.test.ts`.
  Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the three modules. Add settings with labels
  starting `Jira:`, plus `jiraEnabled`. In `lib/link-metadata.ts`, extend
  the external-link parse to keep a valid `jira.key`.
- [ ] **Step 4: Run** the tests above, then `npm test && npm run typecheck && npm run gates`.
  Expected: PASS.
- [ ] **Step 5: Commit** `feat(jira): keys, schemas, settings`.

### Task 2: Store (snapshot, queue, thread record)

**Files:**
- Create: `lib/jira-store.ts`
- Test: `tests/jira-store.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas.
- Produces:
  - `createJiraStore(kv: KvLike, threads: MetadataLike, now: () => number)`
    returns an object with:
    - `ingestSnapshot(raw: unknown): Promise<{ ok: true } | { ok: false, error: string }>`
    - `readSnapshot(): Promise<{ snapshot: JiraSnapshot | null, ageMs: number | null, stale: boolean }>`.
      `stale` is true when there's no snapshot, when `!ok`, or when
      `ageMs > 2 × refreshMinutes`.
    - `enqueue(op: Omit<QueueOp,"id"|"createdAt">): Promise<QueueOp>`. The
      id is `crypto.randomUUID()`.
    - `pendingOps(): Promise<QueueOp[]>`, oldest first. Includes issued but
      un-acked ops.
    - `ack(results: OpResult[]): Promise<void>`. Removes the acked ops and
      keeps the last 200 results.
    - `lastResult(opId: string): Promise<OpResult | null>`
    - `readThread(threadId): Promise<ThreadJiraRecord>`. Returns an empty
      record when absent.
    - `writeThread(threadId, patch: Partial<ThreadJiraRecord>): Promise<ThreadJiraRecord>`
  - `KvLike` and `MetadataLike` are the minimal slices of `bb.storage.kv` and
    `bb.sdk.threads.{getPluginMetadata,updatePluginMetadata}` the code uses.
    Follow how `lib/snooze.ts` and the Done record are read in `server.ts`.

- [ ] **Step 1: Write failing tests**
  - Ingesting a valid snapshot, then reading it at +3 min, gives
    `stale: false`. At +5 min (with refresh 2) it gives `stale: true`.
  - Ingesting `{ ok: false, error: "acli: not authenticated" }` gives
    `stale: true`. The prior good snapshot is *kept*, readable with its own
    age.
  - Enqueuing 2 ops then calling `pendingOps()` returns both, oldest first.
    After `ack([{id: first, ok: true, …}])`, only the second remains.
  - Acking an unknown id is a no-op (replay safety).
  - Calling `writeThread` twice merges the patches, and `links` are deduped
    by `key`.
- [ ] **Step 2: Run** `npx vitest run tests/jira-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** KV keys: `jira:snapshot`, `jira:queue`,
  `jira:results`. Keep writes serialized per key, the way
  `tests/board-kv-concurrent.test.ts` expects for the rank store.
- [ ] **Step 4: Run.** Expected: PASS, and `npm test` stays green.
- [ ] **Step 5: Commit** `feat(jira): snapshot and write-queue store`.

### Task 3: CLI bridge and setup command

**Files:**
- Create: `lib/jira-server.ts`, exporting
  `registerJira(bb, deps): { dispose(): void }`. This task adds only the CLI
  part.
- Modify: `server.ts`, with one `registerJira(bb, { … })` call next to the
  existing `bb.cli.register`
- Test: `tests/jira-cli.test.ts`, following the patterns in `tests/cli.test.ts`

**Interfaces (Produces CLI):**
- `bb focus-board jira ingest --file <path|->`. Validates the input, then
  calls `ingestSnapshot`. Exits 1 with the zod error on bad input.
- `bb focus-board jira wanted --json` returns
  `{ projects, linkedKeys: string[], prRefs: { repo, number }[], branchHeads: { repo, headRef }[] }`.
  These are the keys and PRs the script must fetch: every link across
  non-archived threads, plus PR links.
- `bb focus-board jira queue --json` returns `{ ops: QueueOp[] }`.
- `bb focus-board jira ack --file <path|->`. Takes `OpResult[]`.
- `bb focus-board jira status`. Prints the snapshot age, ok/error, the
  pending op count and the last 5 results.
- `bb focus-board jira setup`. Prints, and does not run:
  `bb automation create --project <personal> --name "Focus Board Jira sync" --cron "*/2 * * * *" --timezone <local> --script-file <repo>/scripts/jira-sync.mjs --interpreter node --working-directory automation-storage --timeout 5m`.
  The cron interval comes from `refreshMinutes`.

- [ ] **Step 1: Write failing tests.**
  - `ingest` with a fixture snapshot, then `status`, prints `ok, age 0s`.
  - `ingest` with `{}` exits 1.
  - `wanted` lists `PT-3879` once when two threads link it.
  - `setup` output contains `--cron "*/2 * * * *"` and `jira-sync.mjs`.
- [ ] **Step 2: Run** `npx vitest run tests/jira-cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `bb.cli.register`, matching the existing
  `focus-board` command tree.
- [ ] **Step 4: Run** the tests, `npm test` and `npm run gates`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(jira): CLI bridge for the companion script`.

### Task 4: Companion script

**Files:**
- Create: `scripts/jira-sync.mjs`
- Test: `tests/jira-sync-script.test.ts`. This runs the script with `PATH`
  pointing at stub `acli`, `gh` and `bb` executables written into a temp
  dir. Test files aren't scanned by the gate.

**Interfaces:**
- Consumes: Task 3 CLI.
- Produces: a script that runs one pass and exits 0. It exits non-zero only
  on an unexpected crash.

**Pass order (fixed):**
1. **Drain the queue.** For each op from `bb focus-board jira queue --json`,
   apply it with `acli` (`execFile`, argument arrays), then ack it right away.
   - `transition`: read the item's transitions, pick the first whose target
     status category matches `toCategory`, and skip it as ok if the ticket
     is already in that category.
   - `assign`: `me` resolves to `--assignee @me`. `none` unassigns.
   - `comment`: first search the existing comments for the `[fb:<opId>]`
     marker and skip if found. Otherwise append `\n\n[fb:<opId>]` to the
     body and post it.
   - `create`: `acli jira workitem create`. Return `createdKey`.
2. **Fetch tickets.** Use
   `acli jira workitem search --jql "assignee = currentUser() AND resolution = Unresolved AND project in (<projects>)" --json`,
   plus one search for `key in (<linkedKeys>)`. Include each epic's or
   parent's open child count.
3. **Fetch PRs.** For each `prRefs` entry, run
   `gh pr view <n> -R <repo> --json state,mergedAt,headRefName,title,body,statusCheckRollup,reviewDecision,updatedAt`.
   For each linked key, run
   `gh search prs "<key>" --merged --json repository,number,closedAt --limit 10`
   to build `mentions`.
4. **Ingest.** Pipe the snapshot to `bb focus-board jira ingest --file -`.
   - If `acli` fails authentication, ingest `{ version: 1, ok: false, error, takenAt, … }`
     so the board can show it.
   - If `gh` fails, ingest the tickets with `prs: []` and an `error` line.
     Never invent PR states.

- [ ] **Step 1: Write failing tests.** Use stub binaries that log their argv
  to a file.
  - A transition op on a ticket already in Done makes no `acli … transition`
    call, and acks `ok: true`.
  - A comment op whose marker already appears in the stub's comment list
    makes no post, and acks `ok: true`.
  - With the `acli` stub exiting 1 with "unauthorized", the ingested
    snapshot has `ok: false` and its error contains "unauthorized".
  - With the `gh` stub exiting 1, the ingested snapshot has `prs: []` and a
    non-null `error`.
  - No argv ever contains a single string with a space-joined command (no
    shell).
- [ ] **Step 2: Run** `npx vitest run tests/jira-sync-script.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the script. Check real `acli` flags with `--help`
  at build time: `workitem transition --key K --status <name>`, and
  `workitem comment create`.
- [ ] **Step 4: Run.** Expected: PASS. Then run it once for real by hand:
  `node scripts/jira-sync.mjs && bb focus-board jira status`.
  Expected: `ok`, with about 20 assigned tickets.
- [ ] **Step 5: Commit** `feat(jira): companion sync script`.

### Task 5: Reconciliation of existing threads

Run this before any behavior that acts on threads. Everything that follows
relies on `enrolledAt` and on links already being in place.

**Files:**
- Create: `lib/jira-reconcile.ts`
- Modify: `lib/jira-server.ts`, adding the `jira reconcile` CLI, the
  `jira_reconcile_plan` and `jira_reconcile_apply` RPCs, and the trigger on
  first enable
- Test: `tests/jira-reconcile.test.ts`

**Interfaces:**
- Consumes: `extractJiraKeys`, the store, the snapshot, thread list rows
  (`id, title, branch, status, archived, done`) and existing links.
- Produces:
  - `planReconcile(input: { threads: ReconThread[], links: Record<threadId, ThreadLink[]>, prs: GhPr[], snapshot: JiraSnapshot | null, projects: string[], now: number }): ReconcilePlan`
  - `ReconcilePlan = { autoLinks: { threadId, key }[], suggestions: { threadId, key, why: "pr-body"|"fuzzy" }[], drift: DriftItem[], enroll: string[], skippedDone: string[] }`
  - `applyReconcile(plan, store, linkWriter, now): Promise<void>`. Writes
    only links and `enrolledAt`. **It never writes to Jira and never calls
    `threads.send`.**

**Rules:**
- **Auto-links.** Keys from the title or branch, or an existing external
  Jira link, whose project is in `projects` *and* (when a snapshot exists)
  which appear in `snapshot.tickets`. If no snapshot exists, title and
  branch keys still auto-link. They're the operator's own words.
- **Suggestions.** Keys only in a linked PR's body, title or branch.
  Fuzzy suggestions: the operator's own tickets whose summary shares at
  least 3 non-stopword tokens with the thread title (the builder may tune
  the scoring). Never applied.
- **Enrollment.** Every non-archived thread gets `enrolledAt = now`. Threads
  that already have an `enrolledAt` keep it, so running reconcile twice is
  safe.
- **Done threads.** Threads already Done go into `skippedDone`. They're
  enrolled and get title and branch links, but `doneCheck` is never set and
  they're never re-checked.
- **Running threads.** They're handled like the rest: links and enrollment
  only. There's nothing to send, by construction.
- **Trigger.** Flipping `jiraEnabled` from false to true runs
  `planReconcile` and `applyReconcile` once. It then publishes the plan's
  suggestions and drift to the board for a one-time review list.
  `bb focus-board jira reconcile` prints the plan, and `--confirm` applies
  it.

- [ ] **Step 1: Write failing tests**, using fixtures mirroring the
  operator's real board:
  - Four threads titled `PT-3878 A…`, `PT-3878 B+C…`, `PT-3878 D…` and
    `PT-3878 E…` give four `autoLinks` to `PT-3878`.
  - A thread `Resolve WAF IP set drift` with no key, and an assigned ticket
    `PT-3570 Automated Atlantis plan review`, produce no autoLink. (A fuzzy
    suggestion may appear, depending on the token rule.)
  - A thread whose linked PR body says "Part of SRE-26" gets a suggestion
    with `why: "pr-body"` and no autoLink.
  - A thread titled `UTF-8 cleanup` gets nothing.
  - A thread with status `active` gets autoLinks and enrollment. The test
    asserts the injected `send` spy is never called.
  - A Done thread lands in `skippedDone`. After apply, its record has
    `doneCheck: null`.
  - Applying twice keeps the first `enrolledAt`.
  - `applyReconcile` makes zero `enqueue` calls.
- [ ] **Step 2: Run** `npx vitest run tests/jira-reconcile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the planner (pure) and apply. Links are written
  through the existing `link_set` path with `source: "auto"` and
  `jira: { key }`, so chips render with no extra work.
- [ ] **Step 4: Run.** Expected: PASS. Then dry-run against the real board:
  `bb focus-board jira reconcile`.
  Expected: PT-3878 ×4 and PT-3879 ×7 auto-links, no Jira writes, and a
  pending op count of 0.
- [ ] **Step 5: Commit** `feat(jira): reconcile existing threads`.

### Task 6: The only door to a thread (`sendIfIdle`)

**Files:**
- Create: `lib/jira-idle.ts`
- Test: `tests/jira-running-threads.test.ts`

**Interfaces (Produces):**
- `sendIfIdle(sdk: { get(id): Promise<{ status: string, archived: boolean }>, send(args): Promise<void> }, threadId: string, text: string): Promise<"sent" | "busy" | "gone">`.
  It reads the status *immediately* before sending, and returns `"busy"`
  when the status is `active`.
- `createIdleWaiters(): { waitFor(threadId, job: () => Promise<void>): void, onIdle(threadId): Promise<void> }`.
  Jobs queued for a busy thread run on its next `thread.idle`, one job per
  thread per kind, with the latest replacing the earlier one. Queued jobs
  persist in KV `jira:idle-jobs`, so a restart resumes them.

- [ ] **Step 1: Write failing tests**
  - When `get` returns `active`, the result is `"busy"` and `send` isn't
    called.
  - When `get` returns `idle`, the result is `"sent"`, with
    `send({ threadId, mode: "auto", input: [{ type: "text", text }] })`.
  - The race: `get` returns idle on the first call and active on the
    second. Call `sendIfIdle` twice and expect `"sent"` then `"busy"`.
  - `waitFor` while busy, then `onIdle`: the job runs exactly once.
  - Calling `waitFor` twice for the same thread and kind runs only the last
    job.
  - An archived thread returns `"gone"`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** In `registerJira`, subscribe
  `bb.events.on("thread.idle", …)` to `onIdle`. **Add a test helper** that
  scans `lib/jira-*.ts` and fails if `threads.send` appears outside
  `jira-idle.ts`. That keeps this the only door.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(jira): idle-gated thread sends`.

### Task 7: Jira chips and the thread-card badges

**Files:**
- Create: `components/jira-card-badges.tsx`
- Modify: `components/thread-card.tsx` (render the badges),
  `lib/jira-server.ts` (a `jira_board_state` RPC and a `jira-changed`
  realtime event)
- Test: `tests/jira-card-badges.test.tsx`

**Interfaces:**
- Produces:
  - RPC `jira_board_state()` returns
    `{ enabled, snapshotAge: number|null, stale, error: string|null, tickets: JiraTicket[], threads: Record<threadId, ThreadJiraRecord>, pending: Record<opId, QueueOp> }`.
  - `<JiraCardBadges record ticketByKey pendingOps onAction />` renders:
    - a chip `KEY · Status` with a status dot, where category maps to tone
      (new → neutral, indeterminate → info, done → good), plus a "stale"
      marker when the snapshot is stale
    - a **No ticket** chip with a **Find ticket** button when there are no
      links and `enabled`
    - the `reason` line when set
    - a "check in with <name>" badge from `checkInWith`
    - a spinner badge while `verifying`
    - "pending" next to any chip with an un-acked op for that key

- [ ] **Step 1: Write failing tests.** One snapshot-free render per state
  above. With `enabled: false`, nothing renders: an upstream card is
  unchanged.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Buttons call `onAction(kind, threadId)`, where
  `kind` is `"find-ticket"|"confirm-done"|"skip-done"|"spin-off"|"keep-working"|"not-needed"|"clear-check-in"|"promote-epic"`.
  An RPC `jira_card_action` receives it. Kinds whose behavior lands later
  (Tasks 9–11) return `{ ok: false, error: "not yet" }` until then.
- [ ] **Step 4: Run** the tests and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(jira): card chips and badges`.

### Task 8: Jira column and drift

**Files:**
- Create: `components/jira-column.tsx`, `lib/jira-drift.ts`
- Modify: `components/grouping.ts`. In the Attention view only, when
  enabled, prepend a column with id `jira`. Collapsed state is stored in the
  board's existing preferences.
- Test: `tests/jira-drift.test.ts`, `tests/jira-column.test.tsx`

**Interfaces:**
- `detectDrift(ticket: JiraTicket, linkedThreads: { id, done: boolean, prs: GhPr[] }[], now: number, staleTicketDays: number): DriftItem[]`.
  `DriftItem = { key, kind: "todo-with-prs"|"all-done-still-open"|"stale-unlinked", detail: string }`.
- `<JiraColumn tickets threadsByKey suggestions drift stale error onStartThread onLink onFix hideLinked />`
  - `suggestions` comes from the stored reconcile plan (Task 5), keyed by
    ticket. Each one shows "Might be: <thread title>" with a **Link** button,
    which writes the link with `source: "operator"`. Linking or dismissing
    removes the suggestion.
  - **Start thread** opens the existing composer through
    `lib/new-thread-seed.ts`. The prompt is
    `"<KEY>: <summary>\n\n<url>\n\n<description>"` and the seed is
    `pluginMetadata: { jira: { links: [{ key, role: "owner", source: "operator" }], enrolledAt: now } }`.
    Starting the thread enqueues `transition → indeterminate` if the ticket
    is in `new`.
  - Fixes enqueue ops:
    - `todo-with-prs`: a transition to `indeterminate`, plus a comment
      listing the PR URLs
    - `all-done-still-open`: runs the Done check for those threads
    - `stale-unlinked`, "Give back": opens a confirm dialog, then enqueues
      the comment and `assign none`

- [ ] **Step 1: Write failing tests**
  - A ticket in `new` with 2 merged PRs across 2 linked threads returns one
    `todo-with-prs` item whose detail mentions both PR numbers.
  - 7 linked threads where only 6 are Done gives no `all-done-still-open`.
    With all 7 Done, it does.
  - A ticket updated 31 days ago with no links gives `stale-unlinked`. At 29
    days it gives nothing.
  - The column with `stale: true` shows "data 6 min old". With
    `error: "unauthorized"`, it shows "Jira not connected: run `acli jira auth login --web`".
  - The hide-linked toggle hides tickets that have threads.
  - A suggestion renders "Might be: Resolve WAF IP set drift". Clicking
    **Link** calls `onLink("PT-3570", threadId)`, and nothing auto-links.
  - Start thread calls the seed with the exact prompt and metadata above.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** The column lives outside the rank store, so it's
  never draggable as a thread lane.
- [ ] **Step 4: Run** the tests and `npm test`. All existing `board-*`
  tests must still pass, because the column is absent when the feature is
  disabled.
- [ ] **Step 5: Commit** `feat(jira): Jira column with drift fixes`.

### Task 9: Ticket matching and child spawn (agent side)

**Files:**
- Create: `lib/jira-agent.ts`
- Modify: `lib/jira-server.ts`, registering the tools and `bb.agents.configure`
- Test: `tests/jira-agent.test.ts`

**Interfaces:**
- Instructions (from `agents.configure`, only when `enabled`). Ticket data
  is quoted with `JSON.stringify`, following the SDK's untrusted-metadata
  guidance.
  - **Unlinked thread:** "When you can describe this thread's work in one
    sentence, and before creating a branch or editing files, find its Jira
    ticket."
    - Search with `acli jira workitem search --jql 'project in (PT,SRE) AND resolution = Unresolved AND text ~ "<terms>"' --json`.
      Search the operator's own tickets first.
    - Show the operator up to 5 candidates with their owners, and wait for a
      choice.
    - Then call `focus_board_jira_link`.
    - If there's no match, draft a ticket. The project defaults to
      `<defaultProject>`. Judge whether the work is ticket-shaped or
      epic-shaped, and propose a parent epic or a new epic. Confirm with the
      operator, create it with `acli`, then link it.
    - If the first user message contains a key or a browse URL, link it
      immediately.
  - **Linked thread:** put `<KEY>` in branch names and PR titles. Spin off
    children only through `focus_board_spawn_child`.
- Tools:
  - `focus_board_jira_link({ key, role: "owner"|"watching", ownerName?: string, claimed: boolean })`
    - Validates the key.
    - Writes the link (`source: "agent"`), plus `checkInWith = ownerName`
      when `watching`.
    - Prefixes the thread title with `KEY: ` if no key is present.
    - Returns text telling the agent to stop work when `watching`.
  - `focus_board_spawn_child({ title, prompt, ticketKey })`
    - `ticketKey` must already exist. The agent created it with `acli` after
      the operator confirmed.
    - Calls `bb.sdk.threads.spawn` with
      `parentThreadId = caller, prompt, pluginMetadata: { jira: { links: [{ key: ticketKey, role: "owner", source: "agent" }], enrolledAt: now } }`.
    - When the caller's ticket isn't an epic and this is its second or later
      child, sets `epicSuggested: true` on the parent. The card offers
      "Promote <key> to an epic?", which changes nothing until clicked; the
      click sends the parent thread a turn (through `sendIfIdle`) asking the
      agent to do the promotion with `acli`.

- [ ] **Step 1: Write failing tests**
  - `configure` for an unlinked thread includes "before creating a branch"
    and `"SRE"`. For a linked thread, it includes the quoted key.
  - With `enabled: false`, `configure` returns no tools and no instructions.
  - `focus_board_jira_link({ key: "PT-1; rm -rf", … })` throws and writes
    nothing.
  - `watching` sets `checkInWith`, and the return text contains "stop".
  - Linking a thread titled `Investigate slack thread` retitles it to
    `PT-9: Investigate slack thread`. A title already containing `PT-9` is
    left alone.
  - `spawn_child` passes the exact `pluginMetadata`. The third child under a
    non-epic sets `epicSuggested`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Export `FIND_TICKET_TEXT`, the match
  instruction as a one-off turn. Wire the `find-ticket` and
  `promote-epic` card actions to `sendIfIdle`.
- [ ] **Step 4: Run** the tests, `npm test` and `npm run gates`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(jira): matching instructions and agent tools`.

### Task 10: Done check

**Files:**
- Create: `lib/jira-done-check.ts`
- Modify: `server.ts`. In `done_set` (around line 2189), when
  `enabled && done === true`, call `startDoneCheck(threadId)` instead of
  `writeDoneRecord`. `done === false` and the disabled case are unchanged.
  Also add a `jira_done_confirm({ threadId, skip?: boolean })` RPC.
- Test: `tests/jira-done-check.test.ts`

**Interfaces:**
- `evaluateMechanical(input: { prs: GhPr[], children: { id, linked: boolean }[], snapshotStale: boolean }): { verdict: "pass"|"fail"|"needs-agent"|"needs-operator", reasons: string[] }`, which decides:
  - Stale or missing PR data gives `needs-operator`, with the reason "PR
    status unavailable".
  - Any PR `closed` without merging gives `fail`, with "PR #N closed
    unmerged, confirm it's not needed".
  - Any PR `open` gives `fail`, with "PR #N still open".
  - Any child without a link gives `fail`, with "child thread '<title>' has
    no ticket".
  - At least one PR, and every PR merged, gives `pass`.
  - No PRs gives `needs-agent`.
- `ticketUpdate(input: { ticket: JiraTicket, linkedThreadsDone: boolean[], role: "owner"|"watching", skipped: boolean, summary: string }): QueueOp[]`.
  It always returns a `comment` op. It adds a `transition → done` only
  when all of these hold:
  - `role === "owner"`
  - not skipped
  - not an epic
  - `openChildren === 0`
  - every linked thread is Done
- The flow, in `startDoneCheck`:
  1. Write `verifying`.
  2. If the thread is running, `waitFor(idle)`.
  3. Run `evaluateMechanical`.
     - `pass`: stamp Done (the existing `writeDoneRecord`) and enqueue
       `ticketUpdate`.
     - `needs-agent`: send a verify turn through `sendIfIdle`, asking the
       agent to call `focus_board_done_verdict({ verdict, remaining: string[] })`.
       A `pass` from the agent sets `doneCheck.verdict = "pending-confirm"`,
       and the card shows **Confirm done**. Confirming stamps Done and runs
       `ticketUpdate`.
     - `fail` or `needs-operator`: clear `verifying` and leave `done`
       unset. Set `reason` to the reasons, which puts the card in Needs you,
       with **Spin off**, **Keep working** and **Not needed** buttons per
       reason.
  4. **Mark done anyway** calls `jira_done_confirm({ skip: true })`. That
     stamps Done, sets `doneCheck.skipped`, and enqueues `ticketUpdate` with
     `skipped: true`, which means a comment only.

- [ ] **Step 1: Write failing tests** covering each `evaluateMechanical`
  branch, with the exact reason strings above. Also:
  - `ticketUpdate` for an epic gives `[comment]` only.
  - For `watching`, it gives `[comment]` only.
  - With skipped, it gives `[comment]` only.
  - With 6 of 7 threads Done, it gives `[comment]` only. With 7 of 7 and
    `openChildren: 0`, it gives `[comment, transition done]`.
  - Integration through the RPC with a fake host:
    - A Done drop on an `active` thread makes no send and stamps nothing.
      After `thread.idle`, the check runs.
    - A Done drop while the snapshot is stale makes the card show the "PR
      status unavailable" reason, with no Done stamp and no ops.
    - A thread Done before enrollment (`skippedDone`) never gets a
      `doneCheck`.
  - With `enabled: false`, `done_set` stamps immediately, as upstream does.
    The existing `done-rpc.test.ts` passes unchanged.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Persist `verifying`, so an interrupted check
  resumes after a plugin restart. On startup, every thread in `verifying`
  is queued with `waitFor`.
- [ ] **Step 4: Run** the tests and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(jira): Done check`.

### Task 11: Reminders (nudge and deeper check), replacing the idle sweep

**Files:**
- Create: `lib/jira-reminders.ts`
- Modify: `lib/jira-server.ts`, adding
  `bb.background.schedule("jira-reminders", "*/5 * * * *", …)` and the
  `thread.idle` reason capture. Also modify `lib/sweep.ts`
  `sweepCandidatesForIdleColumn`: when Jira is enabled it returns `[]`, and
  the settings modal hides that setting.
- Modify: `components/grouping.ts` (around line 111). A thread whose
  `jira.reason` is set and which isn't Done counts as `attention`.
- Test: `tests/jira-reminders.test.ts`

**Interfaces:**
- `quietSince(t: { lastActivityAt, enrolledAt, nudgedAt, deepCheckedAt, snoozeWokeAt, linkedChangeAt }): number`
  returns the maximum of the non-null values.
- `planReminders(input: { threads: ReminderThread[], now, nudgeDays, deepCheckDays, cap }): { nudge: string[], deepCheck: string[], carried: number }`.
  - **Eligible** threads are non-archived, not Done, not snoozed, not
    `active`, and not `verifying`.
  - **Nudge** when quiet for at least `nudgeDays` and `nudgedAt` is null or
    older than the quiet start. Oldest first, capped at `cap`; the rest go
    to `carried`.
  - **Deep check** when quiet for at least `deepCheckDays` and not
    deep-checked since the quiet start. Not capped, because it sends no
    turns.
- `deepCheckFindings(input: { links, snapshot, prs, mentions, me }): { reason: string, next: "done-check"|"open-pr"|"snooze" }`, which picks:
  - "All PRs merged · PT-9 resolved", next `done-check`
  - "PT-9 reassigned to <name>"
  - "PR #N: changes requested" or "PR #N: CI failing", next `open-pr`
  - "Possibly fixed elsewhere: <repo>#N merged" (from `mentions` not linked
    to this thread)
  - "PR status unavailable" when the snapshot is stale, next `snooze`, and
    no Done offer
- **Nudge action.** `markUnread`, then
  `sendIfIdle(id, "Focus Board check-in: in one line, what is this thread waiting on? Reply with just that line.")`,
  then set `nudgedAt`. When the thread is unlinked, the initial `reason` is
  "no ticket yet". On the next `thread.idle` after a nudge, the first line
  of `lastAssistantText` (at most 140 characters) becomes `reason`. The
  completed turn fires bb's own push.
- Any thread activity, or an operator click, clears `reason`.

- [ ] **Step 1: Write failing tests**
  - Enrolled today with a last activity 30 days ago gives no nudge (the
    enrollment grace period). At enrollment +2 days, it nudges.
  - 10 eligible threads with cap 3 nudge the 3 oldest, with `carried: 7`.
    The next pass takes the next 3.
  - An `active` thread is never in `nudge`. A snoozed thread is excluded
    until it wakes, and the clock restarts at the wake time.
  - At day 5 a thread is in `deepCheck` and is not re-nudged.
  - Findings with all PRs merged and the ticket resolved give `next: "done-check"`.
    A stale snapshot gives "PR status unavailable" and no Done offer.
  - Integration: the schedule tick calls `sendIfIdle` for the nudged
    threads only. A thread that turns `active` between plan and send gets
    `"busy"`, stays un-nudged, and is retried next pass.
  - The long-idle sweep marks nothing Done when Jira is enabled. The
    existing sweep tests still pass with Jira disabled.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(jira): nudges and deeper checks replace idle sweep`.

### Task 12: Fork notes, coverage matrix, and real-board rollout

**Files:**
- Create: `docs/fork-notes.md`, listing every hook-in point: `server.ts`
  settings, `registerJira` call, `done_set` routing; `components/grouping.ts`
  column prepend and attention rule; `components/thread-card.tsx` badges;
  `lib/link-metadata.ts` `jira` field; the sweep override
- Modify: `docs/test-coverage-matrix.md`, `CHANGELOG.md` (Unreleased)

- [ ] **Step 1:** Run `npm test && npm run typecheck && npm run gates && npm run build`.
  Expected: all green.
- [ ] **Step 2: Install from the local checkout.** The operator runs
  `bb plugin install <absolute path to this checkout>` (bb accepts a local
  path), then `bb plugin reload focus-board`. This replaces the upstream
  `git:` install.
  Expected: `bb plugin list` shows the fork's version running, and the
  board looks like upstream, because Jira is disabled.
- [ ] **Step 3: Set up the companion script.** The operator runs the
  command printed by `bb focus-board jira setup`. After about 2 minutes,
  `bb focus-board jira status` should show `ok` with roughly 20 tickets.
- [ ] **Step 4: Dry-run reconcile.** Run `bb focus-board jira reconcile`
  and review its output with the operator. Expected: PT-3878 and PT-3879
  auto-links, a short suggestion list (PT-3570, SRE-27, PT-3714), and 0
  queued ops.
- [ ] **Step 5: Enable.** `bb plugin config focus-board jiraEnabled true`.
  Check, live:
  - Every running thread keeps running, with no new turns in its timeline
    (check with `bb thread list` statuses and one timeline).
  - The Jira column appears.
  - No pushes fire on day 0.
- [ ] **Step 6: Commit** `docs(jira): fork notes and rollout`.
