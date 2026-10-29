# Design: Jira on the Focus Board

*2026-10-29 · fork `karn09/bb-plugin-focus-board`, based on upstream `dev` (1.7.3-dev) · status: design, no code yet*

## Why

The operator (John, SRE/platform at Grow Therapy) works almost entirely in bb
threads and never opens Jira. Work starts from a Slack alert or message, an
idea he steers in a thread, or a piece of a bigger thread that deserves its own
child thread. Jira ends up out of step with what's actually happening. A
manager's audit (Oct 14–28) found:

- Whole workstreams with PRs and no ticket (Atlantis plan-review tooling,
  workload fixes for other teams, the INC-340 remediation).
- Tickets that don't reflect the work: PT-3878 sat in To Do behind about 20
  PRs. PT-3893 through PT-3900 map one to one onto John's PRs but are
  unassigned.
- Some "untracked" work has a ticket that nobody linked. PT-3570, *Automated
  Atlantis plan review*, is In Progress, but the plan-review PRs never mention
  it.

Many thread titles already carry the key ("PT-3879: Karpenter monitors"). The
gap is **binding** the ticket to the thread and **writing back** to Jira, not
knowing which ticket applies. The goal is to keep threads and tickets moving
together without John having to open Jira.

Prior art in this repo: `docs/musings/2026-09-25-tracker-integration.md` chose
"mirror, don't integrate" and named a "Work" column fed by an adapter as the
heavier option. This fork builds the heavier option, for Jira only.

## Goals

1. **Jira column.** The board's leftmost column lists open tickets assigned to
   the operator. One click starts a thread from a ticket that has no thread.
2. **Ticket matching.** Partway through a thread, once the work can be
   described, the thread finds the right ticket. If an open ticket has no
   owner, it claims it. If someone else owns it, it stops. If none fits, it
   drafts one.
3. **Done check.** Dropping a card on Done asks for a check. A passing check
   closes the ticket; a failing one sends the card back with what's left.
4. **Reminders.** A quiet thread gets a nudge after *n* days (default 2) and a
   deeper background check after *m* days (default 5).
5. **Reconciliation.** The operator's existing threads (dozens, many already
   carrying PRs and keys) join this without misfiring.

## Non-goals

- Trackers other than Jira. Nothing here should block adding them later, but
  don't build the adapter layer.
- Team-wide views or other people's queues.
- Cleaning up Jira itself, such as the SRE-17/PT-3922 duplicate epics.
- Sending this upstream now. That's a later, separate decision (see
  "Keeping the fork rebasable").
- Slack intake. A thread started from Slack is just a thread here.

## Anti-goals (a failure even if it technically works)

- **Interrupting a running thread.** No check, nudge, or verify turn is ever
  sent to a thread that is running. It waits until the thread is idle.
- **Writing to Jira without an explicit trigger.** Every Jira write follows
  either a user action (a click, a drop on Done, a confirmed match) or a rule
  the operator agreed to in this doc. Nothing is inferred and filed silently.
- **Quietly marking things Done.** This feature never moves a thread to Done
  on its own. Upstream's *sweep: mark long-idle threads Done* is the behavior
  being replaced (see Reminders).
- **Floods.** Turning the feature on, or the first reconcile, must not fire
  nudges or pushes for every old thread at once.
- **Wrong links.** A wrong link is worse than none: PT-3879 once ended up
  covering someone else's PR. Fuzzy matches are always confirmed by the
  operator.

## Constraints

- **Jira access goes through `acli`** (Atlassian CLI, at
  `/opt/homebrew/bin/acli`), signed in with the operator's own OAuth login on
  `growtherapy.atlassian.net`. No API tokens are stored by the plugin.
  `acli` reads its credentials from the macOS keychain. If `acli` is missing
  or signed out, the column shows that state and every Jira feature degrades
  to off. Nothing else breaks.
- **This repo forbids running other programs from the plugin, with no
  exceptions.** The rule is enforced by `tests/security-no-process-execution.test.ts`
  and `scripts/security-gates.mjs`, which reject any `child_process` string
  in shipped code. It comes from the 2026-09-28 and 2026-10-05 security
  audits. Upstream removed a `gh` call under this rule (issue #236,
  `lib/tracker-refresh.ts`). So the plugin can't call `acli` or `gh`
  directly as it stands. **Decided (D0): a companion script automation
  carries Jira and PR data, and the rule stays intact.**
- **PR data.** `lib/tracker-status.ts` reads the GitHub plugin's SQLite cache
  at `~/.bb/plugins/github/data.db`, which doesn't exist on the operator's
  machine. That cache holds only state, title and update time anyway. The
  `bb--github-pr-status` cache covers only the current branch's PR per
  environment. The Done check, deeper check, drift warnings and
  reconciliation all need PR state, and the deeper check and reconciliation
  also need checks and bodies. They get it the same way as Jira data (D0).
  **A PR state older than its last refresh never counts as a pass.** If PR
  data is missing or stale, the Done check asks the operator instead of
  passing.
- **Jira projects in scope: PT and SRE.** Make this a setting (a list of
  project keys).
- **bb SDK facts this design relies on** (checked against the bundled
  plugin-authoring docs):
  - `bb.sdk.threads.spawn` with a `prompt` and a `pluginMetadata` seed.
  - `bb.sdk.threads.send({ threadId, mode: "auto", input })` starts a turn on
    an idle thread. Mode `auto` would *steer* a running thread, so callers
    must check that the thread is idle first.
  - `bb.background.schedule` (cron), `bb.events.on("thread.idle" | "thread.active" | …)`.
  - `bb.agents.configure` to give every thread instructions and tools.
  - `bb.agents.registerTool`, per-thread plugin metadata, and `bb.storage.kv`.
  - `markUnread` and the existing snooze wake machinery.
- **Push notifications.** No plugin API sends an arbitrary push. bb's
  push-notifications plugin sends one only on `thread.idle` and
  `thread.failed`, filtered by the thread's notification level. So *a push
  happens only when the thread finishes a turn*. See D1.
- **Fork hygiene.** Upstream ships often (1.3.1 to 1.7.3 in about two weeks).
  Put new behavior in new files (`lib/jira-*.ts`, `components/jira-*.tsx`,
  tests under `tests/jira-*.test.ts`). Keep edits to existing files to small,
  named hook-in points so that rebasing on `upstream/dev` stays cheap.
- Follow the repo's `AGENTS.md`: vitest, never a `node_modules` symlink, and
  the existing test coverage matrix.

## Data model

- **Ticket ↔ thread is many-to-many.** PT-3879 has seven threads, and a thread
  may touch two tickets. Store links on the thread, reusing the existing link
  store's `external` records. Add a structured `jira: { key }` field so links
  don't have to be parsed from URLs. The ticket-side view (which threads point
  at PT-3879) is derived from that.
- **Ticket cache.** Every 5 minutes, the companion script (D0) runs a
  Jira search that fetches (a) unresolved tickets assigned to the operator in the configured
  projects and (b) every ticket any thread links to. It stores key, summary,
  status, status category, assignee, parent/epic, issue type, updated time and
  URL in `bb.storage.kv`. Board reads come only from the cache, never live.
  Chips on thread cards get a live status dot from this cache, as GitHub chips
  do today.
- **Thread work state**, in plugin metadata: `verifying`, `doneCheck` (the
  last result and its reasons), `nudgedAt`, `deepCheckedAt`, `deepCheck` (the
  findings), and `jiraEnrolledAt` (see Reconciliation).

## 1. Jira column

- It's the leftmost column in the **Attention** view. *Builder's call*
  whether it also shows in other views. It must be collapsible.
- Cards list tickets assigned to the operator. Each shows the key, summary
  and status, plus one of:
  - **Linked threads.** Each is a link that opens that thread.
  - **Possible match.** A thread whose title, branch or linked PR mentions the
    key, or a fuzzy match found during reconciliation, with a **Link** button.
    Never linked automatically unless the key matched exactly (see
    Reconciliation).
  - **Start thread** for tickets with no thread.
- **Drift warnings** on a ticket card, each with a one-click fix:
  - The status category is To Do, but linked threads have open or merged PRs.
    Fix: move it to In Progress and add a comment listing the PRs.
  - Everything linked is Done, but the ticket is still open. Fix: run the
    Done check.
  - The ticket was untouched for 30 days or more and nothing is linked
    (stale). Fix: "Give back", which drafts a comment and unassigns after
    confirmation. *30 days is the builder's default; make it a setting.*
- A toggle hides tickets that already have a thread.
- **Start thread** opens the board's existing new-thread composer, filled in
  with the key, summary, description and URL. It also passes a
  `pluginMetadata` seed linking the ticket, so the thread is linked from the
  first turn. On spawn, the ticket moves to In Progress if its status
  category is To Do. *The builder picks the project from the existing project
  memory chain (`lib/new-thread-seed.ts`).*

## 2. Ticket matching (threads not started from a ticket)

**When.** Not at thread start. The match runs once the thread can say in a
sentence what the work is, usually before its first branch or change. Through
`bb.agents.configure`, every thread without a linked ticket is told:

> "When you can describe this thread's work in one sentence, and before
> creating a branch or editing files, call `focus_board_jira_match` with that
> sentence."

If the thread's first message already contains a Jira key or URL (a Slack
message often does), link it right away. That counts as a confirmed match.

**The `focus_board_jira_match` tool.** It searches open tickets in the
configured projects: tickets assigned to the operator first, then everything
else, by text match on the sentence plus any keys mentioned. It returns up to
5 candidates with their owners. The agent shows them to the operator, and the
outcome is one of:

| Case | What happens |
|---|---|
| Operator picks an open ticket with **no owner** | Assign it to the operator, move it to In Progress if it's in To Do, link it |
| Operator picks a ticket **someone else owns** | Link it as *watching*, **stop**, and tell the operator who owns it. The card shows a "check in with <name>" badge until the operator clears it. No Jira write. |
| Operator picks the operator's **own** ticket | Link it and move it to In Progress if needed |
| **No match** | The agent drafts a ticket (summary, description, project, type, parent epic) and the operator confirms or edits it. Then the tool creates the ticket, assigns it to the operator, sets In Progress and links it. |

The tool itself performs writes only when called with an explicit
`confirm: true`. Instructions tell the agent to set that only after the
operator answered.

**Child threads.** When a thread spins off a child, the child gets a ticket at
spawn time. Agents spawn children through a plugin tool,
`focus_board_spawn_child`, which drafts and confirms the ticket and then calls
`threads.spawn` server-side with the link in `pluginMetadata`.
`bb thread spawn` can't pass plugin metadata, so instructions steer agents to
the tool. A child spawned some other way gets the normal matching flow on its
first turn. *(Designer's call.)* The child's ticket:

- If the parent's ticket is an epic, the child's ticket is a story or task in
  that epic. Otherwise it's a subtask of the parent's ticket.
- The ticket draft comes from the child's prompt, confirmed the same way as a
  new ticket. The child thread starts already linked.

**Thread titles.** Once linked, prefix the thread title with the key if it
isn't there already. Instructions also tell the agent to put the key in branch
names and PR titles. This is what makes the manager's PR-to-key matching and
Jira's GitHub integration work.

**Where a new ticket goes** (project and parent epic): see D2.

## 3. Done check

Dropping a card on Done (or `done mark` from the CLI) no longer stamps
`doneAt` straight away. Instead:

1. **The card enters `verifying`.** It stays in the Done column with a
   spinner badge.
2. **If the thread is running, wait.** The check starts on the next
   `thread.idle`.
3. **The plugin checks the mechanical facts itself, with no agent turn:**
   - Every GitHub PR linked to the thread is **merged**. A PR closed without
     merging fails with "PR #N closed unmerged, confirm it's not needed."
   - Every child thread spun off is linked to a ticket. Children don't have
     to be finished: handing off counts.
4. **Verdict:**
   - **Pass, at least one linked PR and all merged:** done, no agent needed.
   - **Pass, no PRs:** the plugin sends the thread one verify turn (only when
     idle) asking the agent to compare what the thread set out to do with
     what happened, and report through a `focus_board_done_verdict` tool
     (`pass` or `fail`, plus a list of what's left). A **pass** still needs
     the operator's click ("Confirm done") on the card, because it's a
     judgment call.
   - **Fail:** `doneAt` isn't stamped, and the card returns to **Needs you**
     with the reasons as a short checklist. Next to each reason are buttons:
     **Spin off** (child thread plus ticket), **Keep working** (clears it),
     or **Not needed** (drops that item).
   - **Override:** "Mark done anyway" on the card skips the check and records
     that it was skipped in metadata. Keep it one click deep, not on the main
     card face. **An override posts the summary comment but never
     transitions the ticket.** Closing it stays a separate, explicit click.
     *(Designer's call, from the "never quietly Done" anti-goal.)*
5. **On a final Done, update the ticket:**
   - Post a comment summarizing the thread: what shipped, PR links, child
     tickets.
   - **Transition the ticket to Done only if** every thread linked to it is
     Done and it has no open subtasks or children. Otherwise comment only.
     An epic is never transitioned by this feature, only commented on.
   - If the ticket is owned by someone else (watching), comment only.

## 4. Reminders: nudge and deeper check

Two settings, in the existing settings surface next to the sweep settings:

- `Nudge a quiet thread after` *n* days, **default 2**
- `Run a deeper check after` *m* days, **default 5**. It must be greater than
  *n*; clamp it if not.

"Quiet" means no thread activity (turns or messages) **and** no change to the
thread's linked PRs or tickets in the cache since the later of: last activity,
`jiraEnrolledAt`, the last nudge or check, or the last snooze wake.

The reminders apply to every non-archived thread that isn't Done, isn't
snoozed, isn't running and isn't in `verifying`. Unlinked threads count too;
their nudge says "no ticket yet".

**Day *n*, the nudge:**
- The card moves to **Needs you**, with a reason line: "waiting on review
  (#645)", "waiting on you", "no ticket yet", "PR merged, ready for Done?".
- The thread is marked unread.
- Push notification: yes, through a tiny status turn (D1).

**Day *m*, the deeper check** (run by the scheduler, plugin-side, no agent
turn):
- **Linked PRs:** merged, closed, or open with failing CI or requested
  changes.
- **Linked tickets:** resolved, reassigned, or moved outside this thread.
- **Fixed by someone else:** another PR mentioning the ticket key merged
  recently, or the ticket got a "duplicates"/"is fixed by" link to a resolved
  ticket.
- The findings are written to the card's reason line, with a one-click next
  step: **Run Done check** when everything looks resolved, **Open PR** when
  blocked, or **Snooze** (existing feature).

**Replacing the sweep.** Turn off *Sweep: mark long-idle threads Done* by
default for this fork, and hide that setting. Reminders take its place.
Archiving old Done threads keeps working as it does now.

## 5. Reconciliation of existing threads

**When it runs.** The first time the feature is turned on, and again on demand
with `bb focus-board jira reconcile` (dry run by default, `--confirm` to
apply, matching `sweep`'s pattern).

**What it does, for each thread that isn't archived:**

1. Collect keys from the title, branch, linked PR titles, PR bodies and PR
   branches, and existing `external` Jira links.
2. **Exact key found in the title, branch, or an existing link:** link it
   automatically. These are already the operator's own statements. PT-3878's
   four threads and PT-3879's seven link this way.
3. **Key found only in a PR body**, or a **fuzzy match** (title text versus
   ticket summary, for the operator's tickets only): listed as **possible
   matches**. They appear on the Jira column and in a one-time review list,
   and are never linked automatically.
4. **Drift** found on the way (for example, a ticket still in To Do with
   merged PRs linked) is listed, not fixed. The fix is the same one-click
   action as on the column.

**Safety rules:**
- Set `jiraEnrolledAt = now` on every reconciled thread, so the reminder clock
  starts at enrollment, not at the thread's real last activity. No nudge fires
  for *n* days after turning the feature on.
- Threads already Done before enrollment are left alone: no Done check runs
  against them retroactively. They still count as Done for "all of the
  ticket's threads are Done".
- Running threads are reconciled read-only. Nothing is sent to them.
- Reconcile writes nothing to Jira. Every Jira write it suggests goes through
  the normal buttons.

## Settings summary

| Setting | Default |
|---|---|
| Jira projects searched | `PT, SRE` |
| Default project for new tickets | `SRE` |
| Nudge a quiet thread after (days) | 2 |
| Run a deeper check after (days) | 5 |
| Stale assigned ticket after (days) | 30 |
| Ticket cache refresh | every 5 min |
| Sweep: mark long-idle threads Done | off (hidden) |

## Keeping the fork rebasable

- New code goes in new files. The hook-in points into existing code:
  - column building (`components/grouping.ts`): a Jira column prepended in
    the Attention view
  - the Done write path (`done_set` in `server.ts`): routed through the check
  - the sweep setting
  - the agent configuration
  - chip status (`lib/tracker-status.ts`): a Jira source next to GitHub
- Keep a short `docs/fork-notes.md` listing those hook points, so an upstream
  rebase knows where to look.
- Install from the fork with
  `bb plugin install git:https://github.com/karn09/bb-plugin-focus-board@<tag>`.
  This replaces the upstream install. The operator is on 1.3.1 today, so the
  first install also picks up upstream 1.3 to 1.7 changes.

## Left to the builder

- Exact JQL and `acli` flags. Read each workflow's transitions with `acli`;
  don't hard-code status names. PT has statuses including Blocked, In Review
  and Invalid or N/A.
- UI details of the Jira column and badges, within the existing card design.
- Text-match scoring for candidates and possible matches.
- Whether the Jira column shows in views other than Attention.
- Test layout, following the coverage matrix.

## Decisions (operator, 2026-10-29)

- **D0. Transport: companion script automation.** The plugin keeps upstream's
  no-process-execution rule untouched.
  - **Reads.** A bb script automation (the mechanism upstream uses for its
    node_modules watchdog) runs `acli` and `gh` on the operator's host every
    few minutes. It writes one JSON snapshot that the plugin reads with `fs`:
    - tickets assigned to the operator
    - every linked ticket
    - every linked PR: state, merged, checks, review decision, branch, body
    - recent merged PRs that mention a linked key

    The plugin shows the snapshot's age, and treats data older than two
    refresh intervals as stale.
  - **Writes.**
    - *In-thread writes* are done by the thread's agent running `acli`, guided
      by `bb.agents.configure` instructions: claim, In Progress, create, the
      Done comment and transition. Matching and the Done check already involve
      a turn.
    - *Click writes* from the board, such as drift fixes, "Give back" and
      Start-thread's In Progress, go into a write queue file. The script
      drains it on its next run and records each result, and the card shows
      "pending" until then.
    - The queue holds only structured operations (`transition`, `assign`,
      `comment`, `create`) with validated keys, never shell text.
  - **Setup.** The plugin ships the script in the repo, and a
    `bb focus-board jira setup` command prints the exact `bb automation
    create` line for the operator to run. The plugin doesn't create the
    automation itself.
  - **Builder's call:** the snapshot and queue file locations (under the
    plugin's data dir), the interval (default 2 min), and the script language
    (bash or node).
- **D1. Push on the day-2 nudge: yes.**
  - The nudge sends the quiet thread one tiny turn ("In one line: what is this
    thread waiting on?"), only when the thread is idle.
  - The turn's completion fires bb's normal push. The agent's one-line answer
    becomes the card's reason line.
  - The day-5 deeper check stays plugin-side and needs no turn.
  - **Rate cap:** at most 3 nudge turns per scheduler pass, oldest first, with
    the rest carried to the next pass. This is the builder's default; make it
    a setting.
  - If the thread's push level is muted, still send the turn. Muted is the
    operator's choice.
- **D2. New tickets go to SRE by default.**
  - Add a setting for the default project.
  - **Epics are proposed, not defaulted.** When drafting, the agent judges
    whether the work is ticket-shaped or epic-shaped. Epic-shaped means
    multiple deliverables, likely child threads, or work spanning weeks.
  - For *ticket-shaped* work, it proposes a parent epic from open epics in the
    project (or none).
  - For *epic-shaped* work, it proposes creating an epic, with the current
    thread's piece as its first child ticket.
  - The operator confirms or edits either proposal.
  - A thread that later spins off two or more children while its ticket
    isn't an epic gets a one-time card suggestion: "Promote <key> to an epic?"
    This writes nothing until clicked.
