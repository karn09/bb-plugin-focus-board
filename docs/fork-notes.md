# Fork notes: Jira integration

## Purpose

This fork of the Focus Board bb plugin adds an optional Jira integration: threads link to Jira tickets, a companion script (`scripts/jira-sync.mjs`, driven by an automation) keeps a ticket/PR snapshot and drains an op queue through `acli` and `gh`, the Attention view gets a Jira column, cards get ticket chips and reason lines, Done becomes a checked request, and quiet-thread reminders replace the long-idle sweep. It is off by default (`jiraEnabled=false`); with it off the board behaves like upstream.

- Design: `docs/superpowers/specs/2026-10-29-jira-integration-design.md`
- Plan: `docs/superpowers/plans/2026-10-29-jira-integration.md`
- Upstream base: `c41190c` (`git diff c41190c..HEAD --stat` lists everything this fork touches).

New files are all `lib/jira-*.ts`, `components/jira-*.tsx`, `scripts/jira-sync.mjs` and `tests/jira-*`. They do not conflict with upstream. The table below lists every edit to an upstream file.

## Hook-in points into upstream files

After an upstream rebase, re-run the full checks, then re-check the listed item per file.

| File | Change | Why | Re-check after rebase |
|------|--------|-----|-----------------------|
| `server.ts` | (a) eight `jira*` settings (`jiraEnabled`, `jiraProjects`, `jiraDefaultProject`, `jiraNudgeDays`, `jiraDeepCheckDays`, `jiraStaleTicketDays`, `jiraNudgeTurnsPerPass`, `jiraRefreshMinutes`); (b) `stampLink` helper (from `link_set`) taking `{append}`; (c) `registerJira(bb, {...})` call with the deps (`liveLinks`, `reconThreads`, `readLinks`, `addLink`, `isDone`, `markDone`, `notDone`, `reminderThreads`, ...), `bb.onDispose(() => jira.dispose())`, and `...jira.commands` in the CLI commands; (d) both `bb.agents.registerTool` calls became `registerTool` from `trackedRegisterTool`, so `configure` can select every tool; (e) Done paths (`done_set` RPC, `done mark`) route through `jira.startDoneCheck` when Jira is on, and leaving Done (`done_set` with `done: false`, `done clear`) calls `jira.stopDoneCheck`; `link_clear` (RPC and `link clear` CLI) calls `jira.unlinkCleared` so cleared Jira links leave the thread record; (f) the idle-sweep eligible list keeps only `reason === "done"` when Jira is on | settings, wiring, only-door sends, Done as a request, reminders replacing idle sweep | the deps still match upstream helpers (`readLinkedIssues`, `writeDoneRecord`, `readSnoozeRecord`, `listCandidateThreads`); new upstream `registerTool` calls must also use the tracked one; new Done/mark/clear paths and new link-clearing paths need the same Jira calls |
| `app.tsx` | `jira_board_state` / `jira_reconcile_plan` fetch, `jira-changed` and `jira-reconcile-changed` realtime refetch, `JiraBoardContext.Provider`, `stateAcks` (`withNeedsYou(errorAckIds, ...)`) replacing `errorAckIds` at every `threadState` / filter / lane / assemble call, `placedDoneIds` (`boardDoneIds`) for column placement, `boardColumns` (`withJiraColumn`), Start-thread composer seed (`newThreadJira`, `jiraStartThreadSeed`, `jira_column_action started` in `onSpawned`), `jiraEnabled` into the sweep config and `SettingsModal` | the board reads Jira state and shows the column | any new `errorAckIds` call site must take `stateAcks`; any new `doneIds` placement use must decide on `placedDoneIds`; provider still wraps the board JSX |
| `components/grouping.ts` | `StateAcks` type, `withNeedsYou`, `threadState` also returns needs-you for `errorAcks.needsYou`, `JIRA_COLUMN_ID = "__jira"`, `withJiraColumn` | a Jira reason line reads as Needs you on the existing acks route; the column is prepended on the Attention view only | `threadState` needs-you branch intact; with no ids `withNeedsYou` returns the same set object; no bucket id may start with `__` (`tests/board-jira-bucket.test.tsx`) |
| `components/board.tsx` | one line: the `__jira` column renders `JiraColumnSlot` instead of a thread lane (status grouping only) | the column is not a lane: no drop, rank, sweep | the column map loop still returns before lane rendering |
| `components/thread-card.tsx` | `JiraCardSlot` (non-compact cards) and `sameSetMembership` compares `needsYou` membership | chips/reasons on cards; memo must rerender when needs-you changes | the memo comparator still receives the acks; slot still outside compact mode |
| `components/nesting.ts` | `needsYouOnly` and two extra args to `buildColumns` / parent-lane calls in `assembleBoard` | upstream passes no acks on those paths; only Jira's needs-you ids ride in | the `buildColumns` / lane signatures (positional args) |
| `components/new-thread-modal.tsx` | optional `initialPrompt` and `pluginMetadata` props; metadata merged into `threads.spawn` args; `SpawnPluginMetadata` type | Start thread seeds the prompt and the `jira` metadata from the first turn | `spawnArgs` still merges `pluginMetadata`; the `threads.spawn` namespace for metadata (see rollout step 6, not verifiable on the fake host) |
| `components/settings-modal.tsx` | `jiraEnabled` prop hides the long-idle sweep row | reminders replace it | prop wiring in `app.tsx` |
| `lib/link-metadata.ts` | `ExternalItemLink.jira?: {key}` with tolerant parse (`JIRA_KEY_OK`); `stampLinkedIssues(..., {append})` | auto-detected links append and never take the primary chip | `parseLink` keeps dropping malformed `jira`; `append` keeps the order contract |
| `lib/sweep.ts` | `SweepConfig.jiraEnabled`; `sweepCandidatesForIdleColumn` returns `[]` when set | idle arm replaced by reminders; Done arm unchanged | the function's early return |
| `lib/new-thread-seed.ts` | `jiraStartThreadSeed` appended | builds the Start thread prompt and a complete `ThreadJiraRecord` | exported types of `ThreadJiraRecord` still match |
| tests (upstream) | small edits to `link-agent-tool`, `link-metadata`, `new-thread-modal`, `settings-modal`, `thread-card-child-dots` tests | follow the signature changes above | rebase conflicts here usually mean one of the items above moved |

## Load-bearing contracts

- `lib/jira-schema.ts` (zod; the companion script and the server both parse with it): `JiraSnapshot` (version 1; `tickets`, `prs`, `mentions` shape), `GhPr`, `QueueOp` (discriminated on `op`), `OpResult`. Changing any of them means changing `scripts/jira-sync.mjs` and its test (`tests/jira-sync-script.test.ts` parses script output with the real schema).
- `ThreadJiraRecord` is stored under plugin metadata key `"jira"` (`THREAD_JIRA_KEY`). It must be complete: a partial record parses as empty (`lib/jira-store.ts`). `jiraStartThreadSeed` writes a complete one.
- KV keys: `jira:snapshot`, `jira:snapshot-failure`, `jira:queue`, `jira:results`, `jira:reconcile-plan`, `jira:dismissed-suggestions`, `jira:enabled-seen`, `jira:snooze-seen`, `jira:idle-jobs`, `jira:next-steps`, `jira:nudge-turns`, `jira:verify-sent`.
- Only-door rule: `threads.send` is called only from `lib/jira-idle.ts` `sendIfIdle` (re-reads status right before the send, mode `"start"`, refuses non-idle threads). Everything else calls `sendIfIdle`. Guarded by `tests/jira-running-threads.test.ts`; also no `child_process` / `shell:true` in `server.ts`, `app.tsx`, `lib/`, `components/` (comments included).

## Operator rollout checklist

These steps change the live bb install, so they are deliberately not run by the implementation. Do them in order. `<checkout>` is this checkout's absolute path.

1. Checks:
   `NODE_OPTIONS=--experimental-strip-types npm test && npm run typecheck && npm run gates && npm run build`
   `NODE_OPTIONS=--experimental-strip-types` is needed on Node 22.13.1: the test and build scripts first run `scripts/generate-unreleased.mjs`, which imports a `.ts` file. Newer Node versions strip types by default. This predates the Jira work.
2. `bb plugin install <checkout>` then `bb plugin reload focus-board`. Expected: `bb plugin list` shows focus-board running from `<checkout>`, and the board is unchanged (Jira off).
3. Confirm `focus_board_link_issue` and `focus_board_group_set` still appear in a new thread's tools (the first-ever `bb.agents.configure` registration).
4. Prerequisites: `acli jira auth status` shows Authenticated, and `gh auth status` reports a logged-in account.
   `bb focus-board jira setup`: copy the printed command, replace `<path-to-bb-plugin-focus-board>` with `<checkout>`, run it. If the path contains spaces, put the whole `--script-file` value in double quotes (`--script-file "<checkout>/scripts/jira-sync.mjs"`). Wait about 2 minutes, then `bb focus-board jira status`. Expected: ok with about 20 tickets. This is the first real acli/gh run: check the flags, and that status names map (In Progress; Done/Closed/Resolved).
5. `bb focus-board jira reconcile` (dry run). Expected: PT-3878 x4 and PT-3879 x7 auto-links, a short suggestions list, 0 queued ops.
6. Enable: `bb plugin config focus-board set jiraEnabled true`. Enabling runs one reconcile apply with a fresh plan (board links plus an enrollment reset, so no thread is nudged on day 0). It makes no Jira writes. Rollback: `bb plugin config focus-board set jiraEnabled false` (the board goes back to upstream behavior). Then check: running threads get no new turns, the Jira column appears, no pushes on day 0, and a thread spawned by "Start thread" carries the `jira` metadata (the fake host could not verify the namespace).
7. Known limits:
   - The Start thread prompt has no ticket description (the snapshot does not carry one).
   - Archived threads are excluded from the all-done drift check: a ticket whose only other linked thread was archived unfinished can still read as all Done.
   - Jira search-index lag can rarely duplicate a create on replay.
   - A verify turn that ends with no verdict fails the check ("no verdict from the agent"). If the plugin restarts while that turn runs, the card stays verifying until Keep working / Mark done anyway.
   - A gh read that fails for some PRs leaves those PRs out of the snapshot (shown as `gh: N of M PRs unreadable` in `jira status` and the column). A thread linking one of them gets "PR status unavailable" from the Done check and the deeper check.
