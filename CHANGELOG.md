# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Jira integration (off by default, `jiraEnabled`): threads link to Jira tickets; a companion script keeps a ticket/PR snapshot and drains a queue of ticket ops through `acli` and `gh`; the Attention view gets a Jira column with drift fixes and a Start thread action; cards show ticket chips and reason lines; Done becomes a checked request; nudges and deeper checks replace the long-idle sweep. Fork notes and the operator rollout checklist are in `docs/fork-notes.md`.

### Changed

### Fixed

## [1.7.2] - 2026-10-29

### Added

### Changed

### Fixed

#### Board layout

- **A phone stops repainting the whole board when the thread pane opens.** The pane's full-screen sheet already hides the board, so the spotlight's dim of the other cards is skipped there. On a 474-card board the pane's first frame lands in half the time, and closing it no longer blocks the tap.
  - A desktop window keeps the dim exactly as it was, because the board is visible beside the pane there.

- **The settings sheet stacks its tabs above the panel on a phone.** A 160px side rail left the Appearance tab about 180px wide and the wallpaper picker's Zoom slider with no width at all; the rail is now a horizontal strip above a full-width panel, the body drops its 440px pin, and the crop preview fits the picker. The desktop dialog is unchanged.

## [1.7.1] - 2026-10-28

### Added

### Changed

#### Board layout

- **The card's ticket chips now land in a fixed shape: issues on the first row's left, PRs on its right, tags in the bottom-right corner.** Several issue ids stay inside the left half and spill onto fresh lines instead of sliding under the PR chip. A long ticket name holds one line by shrinking its text, and a tag wraps only at its hyphens.

- **A family's fold and its idle-children filter now follow you to every bb window and machine.** They used to save only in browser localStorage, so a second machine opened every family expanded; the choice now saves to the board's server state, and a fold in one window lands live in the others.

### Fixed

- **The pane's queued-message Send button works on a phone again.** bb's queued row reveals its "…" control on a touch device through a `@media (hover:none)` utility, and the plugin's own scoped `.opacity-0` was outranking that utility inside the pane, so the row's Send stayed unreachable. The pane now re-asserts the host's touch utilities, so the control behaves exactly as it does on bb's own thread page.

## [1.7.0] - 2026-10-22

### Added

#### Board layout

- **The board's lanes can run horizontal.** A "Lane direction" choice in the Appearance settings tab (mirrored on the plugin configuration page) turns the shipped column board into lanes as rows, each lane's cards flowing left to right; the choice persists across sessions.

- **The Parent view's rows each carry their own sweep.** Every sweepable row's rail cell has the same broom the Focus view's columns use, and arming it sweeps that row's cards across every family lane. The A-while-ago row marks its aged-out children Done, the Done row archives, and the Needs-you and Working rows carry no sweep at all.

- **The board search field gains a search button while it holds text and is focused.** The button sits left of the clear x and clicks like Enter: it re-confirms the live search and keeps the field focused with its text. Blurring the field or clearing it hides the button.

- **The overview board opens the New Thread composer on a keyboard shortcut.** Pressing the configured key (default C) with no pane open opens the same composer the New Thread button does; typing in a pane never triggers it, and the key is changeable or switchable off in Settings → Behavior.

#### Groups and family boxes

- **A child thread joins the parent's group.** Starting a child thread from a grouped parent (card menu or pane menu) writes the parent's group membership onto the spawn, so the child counts as a real member of the box and the group filter everywhere, including after the parent is archived. The dialog names the group before the prompt is spent ("Will join the group …").

- **A family box folds into one normal card.** A chevron beside the box label, or Collapse group in the box menu, turns the whole dashed box into a single card: it keeps the dashed ring so it never reads as a parent card, names the group with its member count and one status dot per member, and a click (or the menu's Expand group) unfolds it again. The fold persists per group and stays in step with a second bb window's fold, and the folded card still drags and join-drops as the whole box.

#### Card animations

- **A collapsed family's working dots breathe at the thread's token rate.** The blue dot now pulses, and its period comes from how fast that thread is spending tokens, so a thread streaming fast breathes fast and a quiet one breathes slow.
  - A thread the board cannot measure yet still pulses, at the slowest period, instead of sitting still.
  - A folded family box's member dots breathe the same way, off-screen dots hold still, and rates are asked for only while a board is open and visible, so the breathing adds no idle work.

#### Settings

- **A wallpaper's letterbox bars take the image's own edge color.** When a wallpaper leaves bars under Letterbox, the picker samples the image's averaged edge color once (CORS-permitting hosts only) and fills the bars with it instead of the theme background.
  - The sampled color saves with the wallpaper, so the board never re-reads pixels; a host that refuses the read keeps the themed bars.

### Changed

#### Board layout

- **A burst of realtime signals refetches the board once, not once per signal.** The done, link, ack, snooze, rank, and group echoes now wait out one quiet window: ten signals landing together settle as a single coalesced refetch pass, so a board with hundreds of threads stops repainting on every echo.

#### Cards and chips

- **A state change repaints only the changed cards, not the whole board.** The thread card is memoized on what it actually renders: toggling done, an ack, or a snooze on a board of hundreds of threads now re-renders just the affected card's subtree (and its family), while freshly rebuilt menus, dots, and closures on the untouched cards can no longer force a repaint.

- **Opening a thread on a big board repaints one card, not the whole board.** The open thread was a board-wide value, so tapping a card set it on every card at once and re-rendered all of them: on a phone that measured 1005 card renders and made the tap feel like it had missed (issue #265). A card now reacts only when the open thread is its own or one of its family's.

#### Card animations

- **Opening a thread holds its card in the spotlight while the rest of the board recedes.** The pane-held card and the family holding it keep their surface, the same focus the pointer arms on hover, now with no pointer in play.

#### Settings

- **The wallpaper crop tunes over the image itself.** The picker's preview now paints the image at its own aspect and lays the board's paint frame, the box the wallpaper actually fills at the window's ratio, over it, so its place and size show which parts and how much of the image fill the board, with the bars showing as frame overhang. Dragging reframes, pinching zooms, the frame takes arrow keys, and the board's own footprint rides inside as the porthole with the dim scrim and the lane and card silhouettes.

### Fixed

#### Settings

- **The wallpaper frames the window, not the board's viewport.** The wallpaper now paints into the bb window's box at the window's ratio: opening and closing the thread pane (or resizing a sidebar) carves the board's view out of one fixed image instead of refitting the crop, and the picker's viewport preview models the same framing.

#### Board layout

- **A phone's pane header sizes the done checkbox to its thumb.** The pane's Mark done control was the one header button that never joined the coarse-pointer ladder, so on a phone it measured 18x22px against its 36x36 siblings. It now takes the same 36px box and a larger glyph, so the header row is one target size (issue #267).

- **The thread pane stops before the board runs out of room.** Dragging the pane's edge wide used to squeeze the board's own column until its toolbar and lane headers spilled over the pane, doubling text on a wallpaper whose z-order put the board on top. The pane now keeps a lane and a quarter (320px) of board to its left, so the drag settles with a clean board instead of overlapping chrome (issue #273).

- **The New Thread dialog's header controls no longer touch.** Maximize and the dialog's own close sat edge to edge and read as one control. A 16px inset now separates them.

- **The board's search field stops painting half a word.** Squeezed by an open thread pane, it used to clip its placeholder to "Sea". It now steps down to "Search", then to the magnifier alone, before any word is cut.

#### Cards and chips

- **`bb focus-board done list` survives a done index entry whose thread was deleted.** A stale index id used to abort the whole listing with `HTTP 404: Thread not found`; the command now exits 0, prints the marks it can read, and flags the stale ids in the listing. Any other metadata failure still stops the command loud (issue #259).

- **A Forgejo chip names its item, not its host.** A Cove or Gitea link used to collapse every item on the host into one chip reading `git.cove`, and following it opened whichever item happened to be first. Each link now reads its number (`#42`) with its own href, a PR leads with the PR glyph, the mark points at that repo's list page, and a `#39` in a title stops wearing GitHub's mark.

#### Groups and family boxes

- **Hiding idle children no longer buries a busy grandchild.** The idle filter read only a child's own state, so an idle child carried its working or unread grandchild out of view with its row. A child now hides only when its whole subtree is idle, in the expanded rows and the collapsed dot strip alike.

- **A big family folds on whole rows and reveals the rest in one click.** The child-thread list used to cap at a fixed height and scroll, so its bottom row rendered sliced and the rest of the family hid behind an invisible scrollbar. The card now renders a whole number of rows with a Show all handle, and the count above still names the whole family.

## [1.6.0] - 2026-10-18

### Added

#### Cards and chips

- **A card can drop into a collapsed family's dot field.** The strip claims the card's hover, lights up under the amber ring while a trailing ghost dot marks the landing, and the release children the member under the family root, landing it last in its tier. Its own dots refuse the write, dot drags keep their home rules, and a misplacement refuses with the banner it always names.

- **A dot that leaves its collapsed strip turns into a card drag.** The family card lights up under a soft ring the instant the drag crosses the strip's edge, and the release lands by the card rules, so a drop on a floor un-parents the member entirely. A release back on the dots is refused, because the tail of the gesture is an ordinary card now.

- **A collapsed strip's dot drags to reorder its tier of the family.** Dragging a dot across its siblings reorders them through the same child-rank write the nested rows use, and the tooltip names the dragged member for the whole gesture. A release anywhere but the strip refuses loudly and writes nothing, since dot drags never leave the hierarchy.

### Changed

#### Board layout

- **Hovering a card no longer re-renders the whole board.** A hover used to run through board state, so one pointer landing on a card rebuilt the board and every card on screen; on a phone that measured 335 card renders per hover and dropped frame rate to single digits against 60 at idle. A hover is now a placement pin held outside render, so it repaints nothing and still keeps a hovered card in place when its data churns.
- **The Parent view's row rail is narrower.** Each row's attribution line now shows just the locked family's task count; the family name stays on the lane header. Phones get the freed 36 pixels for lane content.

#### Cards and chips

- **The collapsed child-dot strip paints the whole family, grandchildren in family order.** A child's dot now leads its own smaller sub-dots and a parent dot's hover preview names its sub-threads, so the strip always paints every thread the "N child threads" count reads (the 19-over-9 mismatch cannot recur). An idle sub-thread's dot hides with its row under the eye filter, at either depth.
- **Chip dots age honestly instead of re-checking GitHub through a spawned process.** The plugin runtime no longer runs the gh CLI to re-check stale open chips, and an open dot is trusted only inside its one-hour confirm window, so a stale chip falls to unsure-plain until bb's own GitHub cache catches up. A closed or merged chip keeps its verdict whatever its age.

### Fixed

#### Cards and chips

- **Two boards stop erasing each other's Done and sweep-keep marks.** Marking thread `t2` Done in one bb window while window B marks `t3` one instant later used to overwrite the shared row from a stale snapshot, so one mark vanished. These writes now serialize on the same queue every rank move already runs, and the done index plus the sweep-keep flags land both changes (issue #242).

#### Groups and family boxes

- **A family folded in one bb window stays folded when the other window folds one.** The fold and hide-idle sets were written whole from each window's own state, so the second window's write erased the first window's choice. Both sets now propagate live between windows through a storage event, and each toggle merges with the stored list instead of overwriting it (issue #245).
- **A group created in one board window survives a simultaneous change in another.** Group creates, renames, deletes, and the member-scan prune each rewrite the whole registry row; serialized, a create in window A is no longer wiped from the registry by a create or assign in window B (issue #242).

#### Board layout

- **A board crowded with cards that need you no longer crawls.** Every attention card pulsed at once, which dragged a busy board to a few frames per second; the pulse now animates only while it is on screen and holds still off screen, so nothing the operator can see changes (issue #260).
- **A rank drag in one bb window now survives another window's drop in the same lane.** Every card stores its own fractional rank, so a move writes only the dragged card's rank plus the unranked cards above its landing, and no stale view rewrites the arrangement another window's move just placed (issue #246).
- **A wallpaper chosen in one bb window survives the second window's dim change.** The wallpaper document was written whole from each window's state, so a settings edit on a stale window dropped the other window's image. The board panel and the configuration page's Appearance mirror now re-read the document whenever another window writes it (issue #245).

## [1.5.0] - 2026-10-16

### Added

#### Board layout

- **The thread pane's composer names its project and checkout at rest.** bb's composer footer carries the project/checkout chips, but it collapses to height 0 whenever the composer sits unexpanded, so at rest in a pane nothing of it paints; the pane keeps its own "project · checkout · branch" line under the transcript whenever the host's chips are missing, hidden, or clipped, and yields the moment they actually paint, so the line never doubles up. A collapsed footer keeps its chips mounted but paints none of them, so the pane follows the paint, not the DOM.

#### Groups and family boxes

- **A collapsed family's child dot previews its child and opens it.** Hovering a dot shows that child's title and state; clicking a dot opens it in the thread pane without expanding the rows. The family's open child lists itself below the strip while the rest stay dots, and the strip's background still expands the family.
- **A card menu action zooms the board to one family.** Right-clicking a card that nests child threads, or a nested row of one, gains "Zoom to family": the Parent view opens showing that family alone. The scoping rides the filter row as a Family chip that clears it, and it persists across reloads like the other filters.
- **A family's child section can hide its idle children.** A small eye button beside the "N child threads" toggle filters idle children out of both the expanded rows and the collapsed dot strip, the count enumerates what is hidden ("1 active, 15 idle child threads") while the filter is hiding something, and the choice persists per family.

### Changed

#### Cards and chips

- **Chip statuses refetch at the operator's moments.** Opening or closing the thread pane, a card changing lanes, and a re-sort or rank move each bump the chip snapshot, so the dots you are looking at are the freshly settled ones (issue #205); the batched design stays, one snapshot per event and never a per-card call.

#### Board layout

- **The State filter menu lists Pinned.** Pin state sits outside Working, Needs you, and Unread, so a checked Pinned shows every pinned card whatever its state; it combines with the other rows, a match on either.
- **The View dropdown shows a kanban board in place of its sliders icon.** It switches the board's group-by layout, so the icon now pictures the columns it produces.
- **The View dropdown stays out of the Filters palette while the collapsed toolbar row has room for it.** A header that borrows the mobile ribbon keeps the View button on its row, left of the Filters toggle, until the band drops to about 560px, where the search field needs all the space the row frees up.
- **The default board view is named Focus.** The View chip, the View dropdown, and every label that named the status grouping used to say "Attention", the same word that names the thread state a card reports; they say "Focus" now. Nothing re-lanes and stored settings keep working, so the rename is the whole change.

### Fixed

#### Context menus

- **Right-clicking a Parent view lane header now opens the thread menu.** The header at the top of a family lane was the one thread surface with no menu wired, so the browser's own menu appeared instead (issue #226). It carries the same entries a lane card's menu does, and holding the menu open pins the lane against re-sorting.
- **The right-click menu uses the room the window gives it.** The menu was pinned to a fixed 320-pixel cap, so entries scrolled behind an inner scrollbar even on a tall screen (issue #222). The shell now grows to the window height minus a small margin, and a short window still scrolls.
- **The right-click menu reads as a menu, not a card.** The popover sat on the same surface color at the same hairline weight as the cards beneath it, so the two were hard to tell apart at a glance (issue #221). The shell now draws the full-strength border under an elevated shadow, with a boundary rule under its header line.

#### Groups and family boxes

- **A nested child row shows its child's ticket chips.** A child thread that ties to a tracker item used to chip only as a standalone card, so the family view hid the tie. Its row carries the same chips now, a step smaller and inert: the row itself is one link.
- **A family card's nested rows keep the card's right gutter.** Child and grandchild rows used to run flush against the card's right edge while the left kept its 12px indent. The child-thread section mirrors its left margin on the right now.
- **A family's child-row list can no longer rest sliced between rows.** Scrolling inside a big family's capped rows list stopped wherever the wheel stopped, cutting the first visible child mid-glyph at the list's edge with no scrollbar to explain the cut. The capped list and its sub-row tier now snap their rest to whole rows, so a stopped scroll always shows a whole row at the boundary.
- **Choosing Zoom to group lands the board on the Group view.** The group box's context-menu entry used to set only the group filter, so the board stayed on the view it started on and the zoom read as a silent chip write. It now switches the view to the Group board with the group restrict set to exactly that group; clearing the chip restores the full board.

#### Cards and chips

- **Hovering a card in light mode no longer mutes it.** The hover surface darkened a near-white card into mid-gray on the light theme, which reads as muting. The light hover keeps the card surface and the ring plus the other cards' recede carry the emphasis; the dark theme keeps its darkening.
- **Bare reference ids in pane messages become chips too.** Agents often drop the kind prefix and write `@proj_…` or `@thr_…` straight, and those tokens stayed dead text. The pane paints them like the full forms now, and a trailing `#msg=N` fragment is swallowed the same way.
- **A hung chip-status call can no longer freeze the snapshot forever.** A `tracker_status` request that the transport never answered used to park the fetch guard, so every later poll, focus, and operator-moment bump skipped and the chips froze at a pre-event snapshot. Each call now races an 8-second timeout whose wall degrades it to "no status known", and the batch settles as soon as every call is resolved, rejected, or timed out, so one hung repo cannot mask its siblings' fresh statuses.
- **Ticket-chip dots stay truthful about the tracker cache's age.** A chip's open dot used to mirror the GitHub plugin's cache row forever, even hours after the item merged or closed in the forge and nothing ever re-fetched the row. An open dot now only paints while the state was confirmed inside the last hour, and where the gh CLI exists the board quietly re-checks flagged items (batched and throttled), so a merge reaches the card within a poll or two.

#### Board layout

- **Lane drags resolve their slot loudly, and nests of pinned cards land with a receipt.** A drag whose insertion slot already holds the card refuses with a banner now, writing nothing. A nest the placement rules cannot render (a pinned child keeps its own card) posts a visible receipt naming "Make Top-Level" as the undo, and a write the host rejects surfaces its rejection in the banner row instead of reverting the landing silently. Solo drags save again: the outgoing payload omits the `unitIds` member whose literal `undefined` the host's JSON walk rejected (issue #240).
- **Hovering a card in the open pane's lane no longer ghosts a duplicate family lane.** The pane's capture and the hover capture both pinned that lane, so the Parent view rendered a clipped copy of the whole family beside it (issue #227). One pin per lane holds now, the freshest capture winning the slot.
- **Board alert banners paint a full-strength surface.** The refusal, receipt, report, and notice banners used to sit on a 10%-alpha tint, so with a wallpaper behind the board the message sank into the photo (issue #233). They draw an opaque surface in both themes now, and the dark theme raises the error banners' text a step so it reads on red.

## [1.4.0] - 2026-10-15

### Added

#### Card animations

- **A motion slider replaces the Motion dropdown, with a follow-system checkbox.** The Motion row is now a checkbox over a notched slider: "Follow my system setting" hands everything to the OS's reduce-motion signal and greys the slider out, and a slide left of stock quiets the board ("Reduce"). The notches right of stock stretch the card animations on a log scale (1x, 2x, 4x, 8x), so the longest read is clearly slower, not a hair longer; the choice persists per browser, and yesterday's stored tri-state carries over.

#### Cards and chips

- **A card menu action clears an acknowledged error out of Needs you.** Right-clicking a card whose Needs-you claim comes from error signals alone (a hard-failed turn or a failed send, never a pending interaction) offers "Clear error"; the card settles into its normal lane, staying clear across reloads while the thread's own view keeps showing the error. The acknowledgment rides per-thread plugin metadata and dies the moment the thread runs a new turn, so a fresh error claims attention on its own.

#### Groups and family boxes

- **A group box's context menu gains Zoom to group.** Right-clicking a feature-group box offers "Zoom to group", which restricts the existing Group filter to exactly that group so the board shows its threads only. Clearing the filter chip restores the whole board, and the restriction persists across a refresh like any other filter.

### Changed

#### Board layout

- **The pane header marks threads done where the chat icon used to sit.** The small chat bubble left of the title is now a done checkbox matching the ones on the overview cards: an empty box marks the thread done, a checked box marks it not done.
- **The composer remembers your environment pick.** New thread now opens with the environment of the project's last successful spawn still selected, so a "(new) worktree" pick stays picked instead of falling back to Project checkout. The memory is kept per project, a failed spawn writes nothing, and "New child thread…" on a worktree parent still wins when the two differ.

### Fixed

#### Cards and chips

- **Agent-written reference tokens in pane messages become clickable chips.** An agent's `@thread:thr_…` or `@project:proj_…` token used to stay dead text, and a raw thread token vanished behind the host's empty mention element. They now paint as labeled chips from the board's own thread and project rows, falling back to the raw id; clicking opens the thread in the pane, or bb's main thread/project view for a target the board does not list.

#### Ticket chips
- **Ticket chips wrap their ids onto extra lines instead of overflowing the card.** A chip carrying long external labels (a cove forge link's "cove 0dac60e") used to run past the card's right edge; the ids now reflow onto extra lines whatever their width.
- **Ticket chip links no longer render inside the card's own link.** A chip's mark and id links used to sit inside the card's opening link, an invalid HTML pairing React logged on every render of the card; the chip rows now sit beside the card's link and every chip link still opens its own ticket directly.

#### Card animations

- **Sweep-selected cards keep their opaque card surface.** The selection's amber wash used a translucent card background that replaced the card's surface, so selected cards faded toward transparent while chosen for a sweep; the wash now rides an overlay and the card stays solid.
- **A focused card no longer recedes under the spotlight.** The pane-open card and a needs-attention card used to drop to 70% opacity while another card sat under the pointer; they now carry the same never-fade marker the done, dimmed, snoozed, and sweep-picked cards get.

#### Groups and family boxes

- **Create & assign shows the new group's box right away.** The Group picker's create path used to leave the board and the picker stale until a separate sync signal arrived, so a fresh group sometimes never appeared and the card stayed unboxed. The record now lands from the create response itself, the same settle path the rename and delete writers already use.

## [1.3.1] - 2026-10-14

### Added

#### Search and filters

- **Mobile collapses the filter palette into a header toggle.** On a narrow screen the toolbar keeps New thread, search, the toggle, and the settings gear in one row, while View, the four filters, Clear, and the thread count hide inside an expandable ribbon that badges how many filters are active. The open/closed choice persists per browser.

### Changed

#### Board layout

- **The toolbar reads as its own band.** The header row paints a muted tint shared by the light and dark themes, so its controls stand apart from the board body and the header is easy to find on a busy board.

### Fixed

#### Search and filters

- **A narrowed desktop header borrows the mobile filter collapse.** Between phone widths and the width the filter row needs, a small window or an open pane left the desktop palette wrapped over several header rows; the header now measures itself and folds behind the same Filters toggle, with the same badge and persisted choice, and the single-row palette returns when the band widens again.

#### Board layout

- **The auto-rename titles threads that open with a pasted file.** Such a thread carries an empty opener text row, so every option in the fallback modal (each AI service, and the thread's own model) failed "no prompt text to title from" before any model was even called; the prompt now recovers the paste's content from bb's attachments store, and a missing, escaping, or non-text paste fails with the file named.
- **The auto-rename's service picks fit bb's bridge prompt cap again.** A thread whose opener text ran long built a title prompt over bb's 4000-character bridge limit, so the only usable service answered "HTTP 400: rpc input validation failed" on every pick; the built prompt now clamps to the cap with the instructions included, and the bridge wait rises above the provider plugin's own 30s budget so slow completions abort there, not in the bridge.
- **A squeezed panel puts the thread pane on a panel-wide sheet.** With a plugin panel that narrowed far below its desktop window, the side-by-side pane kept its stored width: the board flexed away to a sliver and the pane's header (title, auto-rename, Mark Unread) painted past the panel's right edge onto the host's own UI. The pane now measures its panel row; below 640px it covers the board as a sheet scoped to the panel, keeping the host's chrome visible, and above it the side-by-side pane returns with its stored width clamped to the panel so it can never jut past the edge again.
- **A frozen parent-lane keeps its hold under By project.** The project sections re-sorted every section's lanes by recency and threw the lane freeze away, so the attended lane snapped back the moment By project engaged. The sectioning now preserves the order it receives, sections themselves still ordering by their freshest lane.
- **Parent-lane board stops yanking the scroll back to the selected card.** With a card selected, every lane assembly rebuild re-ran the same-lane scroll correction and dragged the vertical scroll back down to the selection. Only a selection change, a lane move, or a viewport resize re-locks now; a hover capture or an ambient re-sort that merely rebuilds the lanes leaves the scroll alone.
- **Closing the thread pane releases the card it froze.** The pane-open push consumed its settle marker in a way that also ate the close's, so a closed pane's attention capture survived and the frozen family card stopped following live state (a running child could never lift it into Working until the next open or a drag). Now the close settle clears the capture, the fallback close clears it without a settle, and the decision lives in one pure `paneRouteAction` map.
- **Mark Unread on a frozen card lands in Unread.** A read card held by the attention freeze kept that pin re-armed from the pre-gesture board while its read flip rode the host bridge, so the card sat in its idle lane until the pane closed. The recapture pass now holds the strip while the gesture's write is in flight, and the card lands in the Unread lane the moment the write arrives.
- **Mark Done no longer drags the board back to the Done column.** The reveal request stayed set after it scrolled once, and every later board refresh re-armed the same request, yanking the view back to the done card's lane against the operator's scroll. The claim now records that it was consumed, so a fresh reveal (the next Mark Done, Pin, or read state change) still scrolls while refreshes leave the pan alone.

#### Card animations

- **The lane-move dissolve leaves the active-card marker on the card, not its ghost.** Relocating the open card played its old-lane ghost with the marker still claiming `aria-current`, so the marker and the keep-in-view scroll pointed at different cards. The ghost is inert decoration and never reports the marker now; the card the board followed owns it.
- **Hovering a card makes it more prominent, not less.** The hovered card keeps its opaque background instead of going translucent (the lane background and wallpaper no longer bleed through it), the hover surface darkens below the resting card in both themes for stronger contrast, and the other cards recede slightly while one is hovered. Done, dimmed, snoozed, and sweep-highlighted cards keep their own fade treatment.
- **The recede dim waits for the pointer to rest.** Sibling cards now start dimming only after the pointer holds still for 300ms, and the fade takes another 300ms, so a quick sweep across the board never strobes the dim on and off; un-hovering stays instant.

#### Groups and family boxes

- **A card moving into a lane joins the group frame already there.** Each lane renders at most one dashed frame per group, gathering that lane's members inside it at the first member's slot; a card the lane held between two members now renders after the frame instead of painting a second instance of the group.
- **A search hit keeps the family whole no matter what frames exist.** A second pass re-gated the family filter's output and dropped dimmed family members whenever a group frame existed anywhere on the board, so a missed-search parent card vanished and its child re-rooted as a lone card. The redundant pass is deleted: the family filter is the one keep rule, and frames never touch what it keeps.
- **Thread nesting no longer moves a child into a label it does not belong to.** Under the Group view a child nested into the parent's lane even when its feature-group assignment named another group, and that lane just lost it. The same-space rule keys the group assignment like project, provider, and machine, so a cross-group child stands alone in its own group column.
- **Live work no longer hides under a Done card.** A live child of a Done parent stayed nested as a row inside the Done card whenever the view's own rules said it fit. Every live child of a Done parent now gets its own card, in every view.
- **A Done projection card folds on its own.** The stored fold held the parent id alone, so folding the live family card also folded the projection sitting in the Done lane; the projection keeps its own fold entry now.
- **Attending to a family's live card no longer moves its Done projection.** The attention freeze's slot pin was keyed by thread alone and applied in every lane, so the attended card's twin in Done jumped to the live slot's index. The pin holds column and thread now.
- **A child thread spawned from a child card nests under that card's row.** Right-clicking a nested child card and picking "New child thread…" used to leave the new thread beside its parent under the family root, breaking the dialog's "Will nest under" promise. Families now follow their real edges one row level deeper (a child row carries its own children as indented sub-rows; deeper members still re-attach to the root), and when the display target differs from the spawn parent, the dialog names both.
  - The fold's count names what folding hides: the rows plus their sub-rows, so a family card with a grandchild no longer reads one short.
- **An errored child thread reads as Needs-you, not gray idle.** A child whose turn failed hard (`status: "error"` in bb) matched no state in `threadState()`, so its dot rendered the same gray as an idle child everywhere, and a collapsed family's child-dot strip hid the error entirely. Errored turns and failed queued sends now ride the attention arm: amber, pulsing, on the strip, the nested rows, and the board lanes.

## [1.3.0] - 2026-10-13

### Added

#### Card animations

- **Cards teleport with the transporter dissolve.** A card moving between lanes dissolves away in its old spot (the slot holds until the dissolve finishes, then the lane closes) and materializes into the new one as its space opens quickly around it; both sweeps ease in slowly and bloom brighter as they travel, each carrying its own shimmer: silver glints rising from the bottom as the card departs, amber glints descending from the top as it arrives. A view switch or a whole-board batch move keeps the plain reflow.
- **Family boxes teleport as one unit.** A dashed box relocating between lanes dissolves as the whole container, slot hold and collapse included, instead of a scatter of per-card ghosts, and it holds its true old slot in the lane even when it sat mid-lane. A box whose membership changes while it moves keeps the plain reflow.
- **The lane move gains a zoom transport.** A board playing the zoom sends a moved card shrinking into its old lane's slot while that slot's space closes with it, then the card grows from small to full in its new lane as the slot's space opens on the same clock, so the space and the card land together. The transporter dissolve stays the default.

#### Settings

- **The board's settings live in one gear.** A modal with Behavior, What's new, and About panels replaces the standalone What's-new alert; the toolbar icon is a pulsing gift while there is unseen changelog (its click lands straight on the news), and a settings gear otherwise.
  - **Appearance joins the tabs.** Card animations pick the transporter read (None snaps into place, Teleport dissolves, Zoom out / in waits visibly), motion can force quieter or fuller animation than the OS setting, and the wallpaper picker lives here; the rail marks the read tab with an accent bar, and What's-new lines fresh on dev tint amber.
- **A wallpaper crops to the board, tuned on a live viewport of the real board.** The picker shows the panel's true aspect with translucent lane and card silhouettes at scale: dragging sets the focal point, pinching zooms, the focus rectangle takes arrow keys, and a Letterbox/Fill toggle plus zoom slider stay for pointer users; every edit carries the layer's other settings, typed url edits keep the dark variant, and stored wallpapers without crop fields render exactly as before.
  - Fits and zooms that paint past the board edge are clipped, so a zoomed wallpaper never scrolls or resizes the board.

- **The configuration page mirrors the Appearance tab.** Beside the declared settings on Focus Board's plugins page, a section re-renders the card animation and motion choices and the wallpaper picker, writing the same per-browser values the modal writes, so an edit in either place covers both.

#### Groups and family boxes

- **The CLI can manage feature groups, not just list them.** `bb focus-board group` grows create, rename, delete, add, remove, and move, and every command accepts the group's id or its exact name, so agents and scripts can place threads without opening the board.
  - `group add` leaves a thread that is already in the group alone and refuses the batch when a thread sits in a different group; `group move <threads> --to <group>` is the mover.
- **An agent can put a thread in a feature group by name.** The `focus_board_group_set` tool assigns the thread or one you name to a group quoted from the conversation, and sessions without plugin tools keep the `bb focus-board group add` fallback.
- **A family box drags by its label.** Grabbing the group name moves the whole box and ranks it wherever the drop lands, the same move grabbing a member card already made. A snoozed lead member still refuses to drag, and a click without the drag still renames.
- **A right-click on a family box offers the group's actions in one menu.** New thread in group… opens the composer preset to the group, Rename group… opens the label editor, and Ungroup all members keeps its click-again confirm.
  - The spawned thread lands with the majority of the members' settings: the most common project and the most common provider/model pair seeded into the composer, each member's model resolved through its own settings.
  - The composer dialog announces the target, "Will be tagged into *group*", before the prompt is spent, and tags the spawned thread into the group itself.
  - Member cards keep their own menus; the group menu covers the box's surface only.

#### Cards and chips

- **A status-dot checkbox settles threads.** Hovering a card swaps its state dot for a checkbox, empty on not-done cards and checked on done; the first click arms it ("Mark Done" or "Mark Not Done" joins the header row) and the second click writes, with hovering away disarming so a stray pointer settles nothing.

#### Search and filters

- **Toolbar search finds a card from any id it carries.** Typing or pasting a project (`proj_…`), provider, environment, host, linked thread, or section id matches now, alongside the thread id it always found.
- **The search field gains an x.** The button appears once the field holds text and wipes the query with one click, leaving focus in the field.

### Changed

#### Settings

- **The Appearance tab is now the wallpaper's only home.** The board toolbar drops its wallpaper icon, and the picker renders inline in the settings' Appearance tab instead of popping over the toolbar; a wallpaper already stored keeps painting the board.
- **The plugin CLI drops its config commands.** Sweep thresholds are set through `bb plugin config focus-board` or the board settings modal, so `bb focus-board config show` and `config set` retire and the CLI help names the surviving door.
- **The Behavior tab hosts the sweep thresholds.** Each arm's count and unit edit the same declared settings Focus Board's configuration page already edits, the values render live in both places, and a rejected write names its failure right under the row.
- **The sidebar's footer gear retitles to Focus Board configuration.** The board's own gear keeps opening the settings modal; the footer gear still jumps to the plugin page in Tools, and two gears no longer share one name.

#### Search and filters

- **The State filter splits Idle into one checkbox per idle lane.** Idle · Recent, Idle · Today, Idle · Earlier, and Idle · A while ago replace the single Idle row, each ticking exactly the Attention lane it names; a stored filter that ticked the old Idle row still shows every idle thread.
  - The menu grew to seven rows, so it now carries the search bar and select-all checkbox the other filters have.

#### Card animations

- **Card animations default to zoom.** The Appearance tab's default read is now the shrink-out/grow-in portal transport instead of the dissolve; Teleport stays the explicit name for the transporter read and None snaps the card instantly.

#### Groups and family boxes

- **Feature groups default to splitting across lanes.** A group's members stay in the lanes their own state puts them in, and each lane holds a dashed frame around its slice of the group (a lone slice included), instead of the whole box gathering in the busiest member's lane; a lane view that had a large box land on it now keeps that lane's cards.
- **Clicking a group marks every lane it renders in.** A clicked member card, or the dashed frame's own surface, ambers that group's every frame across the board, so the whole footprint reads in one gesture; clicking the frame again (or anything outside the group) clears it.

#### Board layout

- **A family card follows the busiest thread inside it.** A running child lifts its quiet parent into Working, and under Last activity a fresh child lifts the family's bucket the same way. A child with a lane of its own (Needs you, Done, Pinned) keeps that lane without dragging the family along.
- **A card the board sees you attending holds its place.** Hovering a card, or keeping it open in the thread pane, pins its lane, its slot, and the lane of its family, so live updates re-sort the board around it instead of moving it; the pin lifts when the pointer leaves or the pane closes.
  - The parent thread view pins the attended card's lane order and its row slot the same way.
  - An open context menu holds the card too, whatever closes it (a menu action, a backdrop click, Escape); the menu's pop-over does not count as the pointer leaving.
  - The pin also holds the card against a rank order that changes while attention lasts: stored rankings are never rewritten, and the held card renders its ranked slot again when the pin lifts.
  - Your own moves still land: a drag, drop, or menu action releases the pin for that gesture and re-pins the settled result.

#### Cards and chips

- **A card's chips group by provider, at most two to a row.** All of a provider's issue ids share one chip and its pull ids another, with the provider mark at the head linking to that kind's list page: the repo's filtered page when the repo is known, GitHub's global one otherwise; long id lists wrap onto extra lines. Each id keeps its own item link inside a grid sized to each track's widest id, at most three ids to a line, and enlarges slightly on hover without moving its neighbors, and a hover bubble repeats the id above the cell so a pointer resting on it never hides the text; merged ids strike through dimmed grey with the merged glyph reading uncolored, every id's state answers on its hover title, and a kindless `#N` whose status names a PR swaps to the pull glyph.
  - A chip whose ids all fit one line centers that line in the chip's height, and the chip hugs its id count: a lone id no longer holds empty column width past the last id.

### Fixed

#### The New thread composer

- **The "@" mention menu works in the New thread dialog again.** A left-over scroll wrapper clipped the composer's popup menus out of the dialog; the @ picker and the / command menu now open like they do everywhere else in bb.

- **Thread agents still link tickets when the linking tool is missing from their session.** GitHub Copilot CLI sessions run without bb plugin tools, so the agent read the linking instructions, tried the call, and could only apologize. The tool's instructions now carry the CLI fallback, `bb focus-board link set "$BB_THREAD_ID" <url>`, so those sessions file the Linear or Jira chip instead of reporting the tool unavailable.

#### Board layout

- **The white drop rectangle around a lane no longer sticks after the drag ends.** Escape mid-drag, a drop claimed by a card, and a drop that relocates the card out from under its own element all clear the lane's ring now, where only a drop onto empty lane space did before.

- **The board holds still through ambient resizes.** With a thread selected, any container resize used to slide the whole board back to that card's lane, even height-only changes like the phone keyboard or a composer animation. The re-fit now fires on width changes only, pane openings and drag resizes, so a pan rests where you leave it.
- **Parent lanes stop the phone snap-back.** A pan at phone widths near 404-467px used to settle by yanking back to the lane it started from, undoing the whole gesture. The pan now rests where you leave it, and lane header clicks still select and lock lanes.

#### Cards and chips

- **Status dots refresh after a PR merges or an issue closes.** Chip dots fetched once per visible-ref set and never again, and a merge changes only the cache, not the ref set, so a dot could sit open for minutes. The fetch also reruns on a 30s poll and on window focus, without reloading the pane.

## [1.2.0] - 2026-10-10

### Added

#### Groups and family boxes

- **Threads join named family boxes.** "Group…" in a card menu assigns the thread to a shared named group; members render inside one dashed outline with the group name on its border, and the whole box moves as one unit by drag or Alt+Arrow.
  - The outline is the join target: a drop onto the box or any member card joins, while a member card's middle third still nests.
  - A group of one keeps its named outline, and a rename re-labels every member card, archived holders included.
  - Rename, ungroup, and delete a group from its box label or a Group picker row.
  - Boxes render under the Project, Provider, Machine, and Group groupings too, while the Parent thread view stays unboxed.
- **Feature groups can be their own view.** The View menu offers Group next to Parent thread: one column per group, unassigned threads parked under No group.
- **A Group filter restricts the board by feature group.** It sits beside Project with a row per group plus "No group", composes with the other filters, and persists.
- **Hide a Project or Group lane straight from the board.** Hovering a column header shows the eye-off icon; two clicks write that lane's project or group out of its filter, a banner names the restore path, and the sole project lane refuses with its reason instead of pretending to hide.
  - The armed hide disarms: Escape or a press outside the armed icon drops it without writing.
- **Family members reorder on their own.** Dropping a box member beside a sibling moves that member alone, and the box renders its members in the order the drop wrote. Nested child rows under a family card reorder the same way; Done rows keep their done recency, and a floor drop still detaches.
- **Toolbar search matches feature-group names.** Typing an epic's name surfaces its member cards; family and box stay whole with non-matching members dimmed, like any other search hit.

#### Wallpaper

- **The board can wear a wallpaper.** The image control opens a picker of gradient presets, a shuffle strip, an openly licensed photo search, or any URL. A dim slider keeps cards readable, and the setting persists per browser, applying board-wide.
  - Theme-aware: presets carry a light and a dark palette and the board follows `prefers-color-scheme` live.
  - Letterboxed: wallpapers fit the whole image instead of cropping, with the bars in the theme background.
  - Done, dimmed, and snoozed cards fade through a wash of their own surface color instead of whole-card opacity.

#### The New thread composer

- **The New thread composer can maximize into the main new-thread view.** Project and environment seeds plus the prompt text ride along, and the board keeps its own draft.

#### The board toolbar

- **`/` jumps to search.** With no pane open, pressing `/` on the board moves focus to the toolbar's search field; panes, dialogs, open dropdowns, and modifier chords keep claiming the key.

#### Cards, menus, and views

- **The pane's open menu reveals the thread's browser tab.** The entry sits between "Open in browser" and "Copy thread link" and runs the same gesture the card menu carries.

### Changed

- **Board cards name personal threads "No project", matching the composer's picker.** The old label used the personal project's "Personal" name ([get-bb/bb#5340](https://github.com/get-bb/bb/issues/5340)); a filter naming personal seeds that state deliberately. ([#25](https://github.com/cristoslc/bb-plugin-focus-board/issues/25))

#### Wallpaper

- **Re-searching in the wallpaper picker's Openverse search now walks the result pages.** An unchanged query fetches the next page with a "page N of M" marker; editing the query resets, and a click past the last page says so outright.

#### The board toolbar

- **The board toolbar reads as one line: create, search + View, filters.** The search field pairs with a View chip naming the current view, and the Project / Provider / State filters, thread count, and What's-new gift run as one trailing cluster that wraps together on narrow panels.

#### Cards, menus, and views

- **The card menu now reads in four groups.** Destinations lead, then the state and picker block, then lineage, with archive and delete closing the menu; one divider per group, and no divider between Read and Done.

### Fixed

#### Groups and family boxes

- **A family box's lane no longer depends on the open pane.** Opening one member's detail pulled the whole box into that member's lane, so a running sibling read as idle; the box now always rides its most attention-needing member.

#### The board toolbar

- **The toolbar's dropdown and wallpaper triggers align at any host font size.** They sat on the text baseline and lifted up to a pixel above their neighbours; they now flex-center, and the screenshot harness pins the alignment.

#### Alert banners

- **Board alert banners stay bound to the viewport.** They used to scroll offscreen with a wide board; they now render above the horizontal scroll surface. ([#26](https://github.com/cristoslc/bb-plugin-focus-board/issues/26))

#### The board toolbar

- **Project filters no longer leak unselected projects into the board.** A family whose only match lived in a selected project kept its dimmed parent's project on the board; a project miss now drops the member outright, while other misses keep-and-dim ([#27](https://github.com/cristoslc/bb-plugin-focus-board/issues/27)).

#### Cards, menus, and views

- **A pin applied in the Parent view now survives the switch to the Attention view.** Pinning a child used to nest it away under its unpinned parent; a pinned child now stands alone in the Pinned column, Done children keeping their Done-lane placement ([#28](https://github.com/cristoslc/bb-plugin-focus-board/issues/28)).

#### The New thread composer

- **New thread starts where the board points, even with no filter armed.** The composer seeds from the board's unanimous project, else from the project the board's composer last spawned into; "No project" only shows when nothing on the board points anywhere. ([#24](https://github.com/cristoslc/bb-plugin-focus-board/issues/24))
  - The maximize hand-off rides the same seed now, instead of bb's own remembered pick.

#### Cards, menus, and views

- **"Open in browser" now means your browser.** Renamed from "Open in new window": on desktop the gesture hands the thread to your system browser instead of bb's in-app panel (filed upstream as [get-bb/bb#5342](https://github.com/get-bb/bb/issues/5342)), and the web board's detached tab is unchanged.

## [1.1.0] - 2026-10-09

### Added

- **The pane's question form keeps half-answered questions alive.** Picks and free text survive a reload or a thread switch and restore with the open tab, then clear once the question is submitted or dismissed — the same recovery the new-thread composer gives prompts.
- **Card menus now surface a thread's controlled browser tab.** "Reveal browser tab" discovers the thread's desktop-browser tabs, focuses the owning thread, and opens the side panel on the page's tab — blank carrier tabs skipped — one click straight from the board. bb offers no honest success signal here (it answers `ok` even when the reveal no-ops, and `tabs`' `presentation` field never reflects live visibility), so the gesture claims nothing; the opened panel is the feedback.
  ([#17](https://github.com/cristoslc/bb-plugin-focus-board/issues/17))
- **Board cards carry linked-issue chips.** A thread tied to a GitHub issue or pull request in the board's own link store shows its `#N` chip with a live status dot, even when the title and branch name say nothing (issue [#13](https://github.com/cristoslc/bb-plugin-focus-board/issues/13)).
  - **Agents are nudged to link.** The `focus_board_link_issue` tool rides thread instructions and asks agents to call it right after they open or file an issue or PR.
  - **The CLI links too.** `bb focus-board link list|set|clear` manages the store by hand.
- **Board links reach any tracker.** `link set` and the agent tool accept any https tracker URL (with an optional chip label), forgejo remotes build their own `…/issues/N` chips, and non-GitHub chips show the site's favicon.

### Changed

- **The pane's actions menu now leads with the state toggles.** Mark Done and Pin sit at the top, Snooze keeps its divider, and "New child thread…" moved down below the snooze entry, away from the everyday toggles.
- **Ticket chips say their source and their kind at a glance.** Each chip now leads with its provider mark — GitHub's own mark, or a generic ticket glyph when the source can't be named — followed by the issue-vs-PR glyph: a linked PR shows the PR glyph immediately, a merged one turns purple, and the open/merged/closed color takes over the old bare state dot.

### Fixed

- **Toolbar search finds cards by their issue/PR chip.** Typing `#38` (or the bare `38`, a pasted item URL, or an external item's label) now matches every card carrying that chip, including chips attached through the board's link store whose title and branch never name the number.
- **The selected parent's lane stays inside the viewport.** A lane's ruler
  columns now cap to the viewport budget and surplus cards wrap downward
  into the bands; on scrollports too narrow to fit a single lane at all,
  snap-to on scroll is off and header clicks select lanes.
  ([#22](https://github.com/cristoslc/bb-plugin-focus-board/issues/22))
- **The board no longer silently vanishes when a checkout's node_modules goes bad.** `npm test`, `npm run build`, and `npm run uat` now abort at a preflight guard whenever repo-root node_modules is a symlink, with the repair printed in the error; `scripts/node-modules-watchdog.sh` carries the self-healing bb automation that checks the main checkout every 5 minutes (its `/Users/cristos/code` path is a symlink alias to the same directory, not a second checkout), and AGENTS.md forbids node_modules symlinks outright.
- **Word-shaped ticket keys no longer chip.** `PROJ-123`-style text matched with nothing able to validate it, so impostor chips like GLM-5 appeared; only refs GitHub can confirm (`#N`, issue/PR URLs) and the board's own links chip now.
- **Mobile thread pane: thread actions drop from a split caret, like Open
  in.** The standalone ⋯ button next to the Mark Read toggle is gone — an
  icon-only toggle, a hairline divider, and an attached ChevronDown caret
  now use the same grammar as the Open in menu at every width.
  ([#14](https://github.com/cristoslc/bb-plugin-focus-board/issues/14))

## [1.0.0] - 2026-10-05

### Added

- **Toolbar search reaches project names and branches.** The filter box still
  matches card titles, but now also matches the project and the branch (or
  machine) a card's footer shows, on parents and nested children alike — a
  hit on any family member keeps the family on the board with the rest
  dimmed.

### Fixed

- **"The thread's active model" no longer lands on a metered catalog
  default.** When the thread's model can't be cloned, the title probe now
  inherits the same spawn default chain a new thread gets instead of
  cloning just the provider. The old path resolved the provider's catalog
  default (an openrouter model here) and the metered gate rejected it with
  a 409.
- **Reordering from two boards at once can no longer drop a column's
  order.** Rank writes now serialize server-side, so a move landing while
  another panel's write is in flight can no longer revert that panel's
  column.
- **A corrupt snooze record can no longer silence the other wake-ups.** One
  bad record is skipped with a log line at load instead of stranding every
  later snooze, and a record that turns unreadable between set and wake now
  logs instead of crashing the timer.
- **An absurd snooze duration refuses cleanly.** A `<when>` like
  `+100000000w` that overflows the Date range exits with the invalid-wake
  hint and no longer marks the thread read as a side effect.

### Changed

- **A drop on a column title never writes an order.** It still detaches a
  nested child (or applies the column's state change cross-lane), but
  placement stays with the insertion line beside the cards — the floor below
  keeps its append.
- **The Working lane no longer vanishes when nothing runs.** The Attention
  board keeps its Working column even when every thread has gone idle; the
  empty lane reads "No work in progress" instead of disappearing.

## [0.9.0] - 2026-10-05

### Added

- **Auto-rename gains the thread's own model as a fallback.** When the
  pinned AI service fails, the fallback modal now titles the thread with a
  hidden one-turn probe on the model bb resolved for the source thread: no
  workspace tools run, the probe is deleted in every path, and resolution
  falls back through the thread's provider to a plain hidden child. The
  modal's other-services list is probed for the bridge focus-board calls,
  so a service whose plugin lacks it (bb cloud, Codex) renders disabled
  with its reason instead of a click that 404s.
  - **Titles come from the thread's true originating prompt.** The source
    timeline's oldest user row wins, prompt history as the fallback — no
    more titling the latest follow-up.
  - **The CLI mirrors the menu.** `bb focus-board autotitle
    availability|prompt|probe --thread-id <id>` runs the probe end-to-end
    without opening the pane.

- **Sweep selection takes shift-click and ⌘/Ctrl-click.** Shift-click grabs
  the run from the last-clicked card through the one you click (cards that
  cannot join a sweep are skipped); ⌘/Ctrl-click toggles a single card.

- **Open menu in the thread pane header.** The workspace button becomes a
  header menu styled like the main thread view's: the icon opens the
  thread's workspace folder in your preferred editor, and the dropdown adds
  file explorer, terminal, new window, and Copy thread link. It runs on the
  machine the workspace lives on (remote sessions included) and hides when
  there is no workspace, the host daemon is down, or the workspace lives on
  another host.
  - **Full screen joins the dropdown.** The floating caret button becomes
    an ellipsis in the swap.
  - **The debug bug button is gone.** The scroll instrumentation setting
    still works, but its log reaches only the browser console (and the
    `__focusBoardScrollDebug.dump()` window handle).

### Changed

- **The Done column sorts by activity recency again, most recently active on top.** The idle sweep's fresh stamps no longer vault long-idle threads or family projections up the column. A stored drag order still wins.

- **A double-tap of Escape no longer closes the thread pane.** After the pane
  stops a running thread or closes, further Escapes inside a short window
  are swallowed, so a stop double-tap can't cascade into closing the pane.

- **Family cards fold their child rows into a "N child threads" line with a
  strip of status-colored dots immediately below it.** The fold toggle sits
  in the child section, directly above the rows it acts on, and folds
  persist across sessions. A child that needs you un-nests into its own
  Needs-you card while the rest stay folded.

- **"New child thread…" opens a composer preset to the parent.** The card
  menu (board cards, nested rows) and the pane's actions menu open the
  composer keyed to the parent, and the spawned child opens in the pane
  nested under it.
  - **The child starts where the parent runs.** When the parent's checkout
    is a worktree, the composer's environment picker is seeded to reuse it;
    other checkouts keep bb's own default.

- **Drop a card onto a card to nest it.** The hovered target rings amber —
  distinct from the top/bottom thirds' ordinary insertion line, so a family
  drop never masquerades as a lane drop — and the drop re-parents the
  thread under the target.
  - **Drag a nested child onto any column header or floor to top-level it
    again.** Nested rows drag like cards now, the hovered title strip grows
    a notch and rings amber for the family detach (the floor works too), and
    dragging the child back onto a card re-nests it — nest and detach are
    each other's undo; the card menu's Make Top-Level detaches too.

- **Mark Unread joins the pane's actions as one attached split control.**
  The header's split menus no longer clip: their carets now open visible
  dropdowns.

## [0.8.0] - 2026-10-03

### Added

- **Collapsible nested children on family cards.** The chevron folds nested
  rows into a "N child threads" pill that reopens them, and folds persist
  across sessions. A folded card reopens itself when a nested child turns
  unread or needs you.

- **Snooze: read now, unread again at a target time.** One "Snooze…" entry
  (on cards and in the pane's actions menu) opens a presets-or-picked-time
  picker, and the snoozed card dims until it wakes. Any pin/read/done/archive
  gesture lifts the snooze first, and CLI parity lands as
  `bb focus-board snooze list|set|clear`.

- **Auto-rename in the pane's title editor.** One click on the title
  editor's auto-rename button titles the thread from its first user prompt, using
  the AI service bb's thread-title task is set to (Settings → AI services)
  via the openrouter-inference plugin's `complete` bridge. A generated
  title renames and closes the editor; a failure keeps it open with a
  fallback modal that names the reason and offers another service or a
  manual rename.

- **The thread pane's actions menu pins again.** A Pin/Unpin entry joins the
  opened pane's more-actions menu with the card menu's semantics: the
  gesture lifts a snooze and clears a parked pin, and a lane move reveals
  after the pin lands.

### Changed

- **Every lane now has its sweep, each with its own destination.** Pinned
  sweeps to Unpinned, Unread to Read, and every Idle bucket to Done; Needs
  You and Working never sweep. A cancelled sweep's Undo reverses destination
  by destination.
  - **The sweep pill drops the word "Sweep."** Screen-reader labels keep the
    full sweep wording.

## [0.7.0] - 2026-10-03

### Changed

- **New threads compose inside the board.** The toolbar, column, and
  parent-lane new-thread buttons now open bb's full compose surface in a
  modal over the board and pane. A failed create keeps your draft with an
  on-screen error, and Escape closes only the modal.

## [0.6.0] - 2026-10-03

### Added

- **A family's done work renders as a projection card in the Done column.**
  Done children move under a dimmed copy of the parent's card, so a family
  lives in both spaces at once — live in its lane, done in Done. Projection
  cards refuse sweep selection.
  - **Big families scroll inside their card.** Past five child rows the
    list caps its height and scrolls.
  - **Archived children are hidden outright, everywhere.** Archiving a
    thread removes it from the board completely, matching bb's sidebar, and
    its children re-render as standalone cards.

- **Filter dropdowns with a search bar gain a select-all checkbox.** One
  click selects every visible option, clicking again deselects, and a
  partial selection shows mixed; present on the Project and Provider
  dropdowns.
  - **Enter applies a sole dropdown search match.** With one match left in
    the search, Enter selects it and closes the menu like a click.

### Changed

- **Developer toggle: pane chat scroll instrumentation.** An off-by-default
  setting logs the transcript's scroll activity, with a copyable log in the
  pane header (`docs/chat-click-jump-2026-09-29.md`).

- **The brand icon is restored as the lane-and-card mark.** The asset is
  solid alpha geometry: it themes itself on light and dark surfaces and
  renders clean at any size (`tests/brand-icon.test.ts` pins the rules).
  - **The sidebar row and pane title bar draw the mark too.** They had kept
    a placeholder icon since the plugin's first commit.

- **The sweep is rebuilt around choosing exactly what gets archived, and
  idle threads resurface instead of vanishing.** Manual selection, a mid-run
  stop, and a gentler fate for quiet threads:
  - **Sweep mode is manual: enter it any time and click the cards to
    archive.** The button stays visible even when nothing is past the
    threshold, armed sweeps pre-select the aged-out threads, and a parent
    with live children refuses with an on-screen note.
  - **The long-idle sweep now marks threads Done instead of archiving
    them.** Quiet threads resurface in the Done sweep and archive only
    after aging there; the CLI mirrors it (`sweep --json` reports
    `archived` and `markedDone` separately).
  - **A sweep can be cancelled, not only confirmed.** The X stops the run
    mid-loop, and the notice offers an exact Undo.
  - **Selecting cards for a sweep no longer reshuffles the column.** The
    list never reorders mid-gesture.
  - **Confirming a sweep archives every highlighted candidate.** The
    button reads "Sweeping N of M" until the loop finishes, and a failed
    archive keeps its card highlighted for a one-click retry.

- **Pinned cards carry their thread's state both ways: read state and
  needs-you.**
  - **Marking a card unread now returns a parked card to Pinned from any
    surface.** It also clears a contradicting Done mark.
  - **A pinned family with a member that needs you calls attention inside
    Pinned.** The parent card pulses amber, shows its question icon, and
    rises to the top of the lane until the question is answered.

### Removed

- **The thread pane's project/branch footer line is gone.** Recent bb
  builds show the working context in the composer itself; the pane ends
  with the transcript.

### Fixed

- **Menu moves bring the destination lane into view.** Every menu action
  that relocates a card now reveals its new lane, so a move never reads as
  the card silently vanishing. Passive changes still never move your
  scroll.

- **Clicking in the pane's chat no longer yanks the transcript to the
  newest message while you are scrolled up.** The click-jump guard arms on
  the click's own position read and reverts the clamp; the full mechanism
  and removal condition stay in `docs/chat-click-jump-2026-09-29.md`.

## [0.5.21] - 2026-09-30

### Added

- **Escape stops a running thread before closing the pane.** While a turn
  runs, Escape interrupts it; the pane closes only once nothing is running.
  Default on, toggle in the plugin detail page.

### Changed

- **Pinned cards take the pin when they leave the lane.** Any gesture that
  moves a pinned card out of Pinned unpins in the same gesture, so the card
  cannot bounce straight back. Mark-not-done restores the card's column,
  not the pin.
- **Columns drained to zero by nesting hide themselves.** They reappear
  when a card returns.

## [0.5.20] - 2026-09-30

### Changed

- **Dropping a card into a new column can place it there in the same drag.**
  The insertion line shows while the drag hovers over a card, and the drop
  writes the state and the rank in one gesture.

## [0.5.19] - 2026-09-29

### Added

- **Clicking in the pane's chat no longer yanks the transcript back to the
  bottom.** A guard reverts the host's clamp-to-bottom when a click lands
  while you are scrolled up; clicking the scroll pill or the composer still
  re-pins. Findings and the removal condition:
  `docs/chat-click-jump-2026-09-29.md`.

## [0.5.18] - 2026-09-29

### Fixed

- **Answering a question now clears the card from Needs you right away.**
  The board verifies every interaction change against the interaction
  records, instead of trusting a cache that could stay stale.

## [0.5.17] - 2026-09-29

### Changed

- **Parent lanes now size to fit their cards.** The selected family renders
  as a wide, readable ruler lane; context lanes wrap compact cards.
- **Panning releases the lane lock, and at rest the nearest family pins
  flush into position.** Seams stay aligned and the board settles quiet.
- **The lane-order toggle moves into the status rail as a vertical
  picker.**

## [0.5.16] - 2026-09-29

### Changed

- **No user-visible board changes.** The What's-new modal restates the
  0.5.15 notes.

## [0.5.15] - 2026-09-28

### Fixed

- **Dragging a card onto the Pinned lane now pins it.** Pinned was the one
  visible lane without a drop handler, so pinning needed the right-click
  menu. The pin writes no lane rank order; already-pinned cards keep their
  reorder gesture.

## [0.5.14] - 2026-09-28

### Added

- **Full Screen moves into the phone thread pane's actions menu.** A phone
  pane covers the board as a full-screen sheet but hid the desktop's
  maximise icon, so the main thread view was unreachable from the pane.

## [0.5.13] - 2026-09-28

### Added

- **Parent thread lanes.** The Group-by dropdown offers "Parent thread":
  each lane is a parent thread, the rows are the attention ladder (Needs
  you, Unread, Working, idle age buckets, Done). Only children render as
  cards; a catch-all "Standalone" lane holds threads with no family, and a
  persisted toggle groups lanes into project sections instead.

## [0.5.5] — 2026-09-28

### Changed

- **Inline-code workspace paths now verify against the workspace before
  they become clickable.** A path clicks only when the backend confirms the
  file exists in the thread's environment, so dead names stay plain text.

## [0.5.4] — 2026-09-28

### Added

- **Recent decisions card in the thread pane.** bb's transcript drops every
  trace of an answered question, so the pane rebuilds the last five from
  the raw event log — question and chosen answer. It auto-expands on a
  fresh answer and collapses with Escape.

## [0.5.3] — 2026-09-28

### Fixed

- **Backticked workspace paths in thread messages are now clickable in the
  board's pane.** Workspace-relative markdown files open in bb's file
  preview, styled like the main pane's links. Commit shas, `.ts` files, and
  block code stay plain.

## [0.5.2] — 2026-09-28

### Fixed

- **Right-clicking a nested child thread no longer stacks the parent
  card's menu on top of the child's.** The right-click stops at the card it
  hits, and every card menu now names its thread in a muted header line.

## [0.5.1] — 2026-09-28

### Added

- **The Done column sorts by when each thread was marked done, newest
  first.** Dragging inside Done still applies a manual order, exactly like
  every other column.

## [0.5.0] — 2026-09-28

### Added

- **The open pane now lives in the panel's URL, so bb's back arrow restores
  it.** Opening a card pushes a `…/board/t/<threadId>` route; links, a
  reload, or a shared deep link all return to the pane you left, and back
  walks the trail of cards one pane per step. Closing pushes the panel
  root, so back reopens the pane — close is never lost work — and forward
  re-closes it. The board keeps the active card in view whenever it
  relocates.
- **What's new**: a gift button in the toolbar lists recent changes after
  an update, pulsing until opened. Fresh installs are stamped silently, and
  the condensed list ships in the bundle, pinned to `package.json`'s
  version by a test.

### Fixed

- **The screenshot harness no longer render-loops.** The mock SDK handed
  back a fresh client every render, looping a thousand renders a second;
  it now returns one stable client, as the real host does.

## [0.4.6] — 2026-09-27

### Added

- **Click an empty area of the board to close the thread pane.** Clicks on
  cards, controls, and card menus are unaffected.

## [0.4.5] — 2026-09-27

### Fixed

- **The first drag-and-drop reorder in a column silently did nothing unless
  the drop landed at the top.** A move now also ranks every card above the
  drop point, so the card lands where you put it. Applies to mouse drops,
  empty-space drops, and Alt+Arrow keyboard moves.

## [0.4.4] — 2026-09-27

### Fixed

- **Thread mention links in pane messages were swallowed.** The link
  interceptor treated every relative anchor as a workspace file; it now
  mirrors the host's heuristic and strips bb's line and column suffixes
  before resolving.

## [0.4.3] — 2026-09-27

### Fixed

- **Relative file links in pane messages no longer open as broken browser
  URLs.** A left-click on a relative anchor reopens the target as a live
  workspace file in bb's preview panel. Absolute URLs keep native routing.

## [0.4.2] — 2026-09-27

### Fixed

- **Rank refusal banners can be dismissed.** They gained an X button and
  auto-dismiss after ten seconds; a repeat refusal restarts the timer.

## [0.4.1] — 2026-09-27

### Fixed

- **Selected option indicators are visible in the pane question form.**
  Selected options fill foreground-on-background, radio-shaped for
  single-select, square for multi-select. The logic was always right; the
  visual was missing.

## [0.4.0] — 2026-09-27

### Added

- **Per-column card rank ordering.** Drag cards up and down inside a
  column to order them your way instead of the board's recency order.
  - Orders are stored per column, so a card that leaves and comes back
    returns to the slot it left.
  - The Pinned and Done lanes keep one order across every grouping; other
    lanes are namespaced by grouping.
  - **Seed on first intent**: no setup step — the first drop writes the
    order, and a lane with a stored order says so in its header.
  - **Keyboard parity**: Alt+Arrow moves a focused card one slot,
    announced in a live region.
  - Drop on a card's top half to land in front of it, bottom half to land
    past it.
- **The pane question form reaches parity with the host's shipped
  QuestionForm.** Sequential questions sit behind a scrollable tab strip
  with a N-of-M counter, the body scrolls internally to keep the
  transcript's space, and number keys select options. Analysis of the
  original gaps: `docs/pane-question-gap-analysis.md`.

### Changed

- **The board's cards and lanes carry drag-testability attributes.** The
  UAT harness reads `data-column-id`, `data-column-ordered`, and
  `data-rank-slot` to drive real drag gestures.
- **The screenshot harness simulates a third unread thread.**

### Fixed

- **Screenshot runs stop failing two runs in three.** Each shot now gets
  its own page with the viewport set once.

## [0.3.5] — 2026-09-26

### Fixed

- **The selected card stays in view when the thread pane opens.** The pane
  squeezes the board, so the scroller keeps the active card visible when
  the pane opens or is drag-resized.

## [0.3.4] — 2026-09-26

### Fixed

- **Agent questions are answerable from the thread pane.** The pane renders
  a pending question as a real form and submits the answer from the board,
  where the question tool used to block until timeout while the pane showed
  nothing.

## [0.3.3] — 2026-09-26

### Added

- **New threads inherit the single selected project filter.** With no,
  several, or stale selections, bb's default project pick applies.

## [0.3.2] — 2026-09-26

### Added

- **Long filter dropdowns gain a search bar** (#8). Past five rows,
  dropdowns open with a case-insensitive search field, matching the model
  picker. Short lists keep plain rows.

## [0.3.1] — 2026-09-25

### Changed

- **The plugin is renamed to Focus Board** (#8). Package, plugin ID, CLI,
  and preference keys all move, and saved preferences reset once on
  update. The repository moves to
  [github.com/cristoslc/bb-plugin-focus-board](https://github.com/cristoslc/bb-plugin-focus-board)
  (the old URL redirects).

## [0.3.0] — 2026-09-25

### Added

- **The new `bb thread-board` CLI manages the plugin's own state** (#6). A
  third surface over the same Done/metadata store, never a re-spelling of
  `bb thread`:
  - `done list|mark|clear` — agents get free Done marking.
  - `sweep [--ids …] [--confirm]` — a dry-run prints the eligible set and
    exits 1, and `--ids` freezes the blast radius.
  - `config show|set` — sweep thresholds without learning
    `bb plugin config` syntax.

## [0.2.0] — 2026-09-25

The day's four sashays plus the nesting refinement round, merged in
sequence: done-metadata foundation → sweep → tracker mirroring → nesting
refinements.

### Added

- **Done state moves to per-thread plugin metadata** (#4), server-side and
  surviving across devices and reloads. A legacy-KV migration shim imports
  the earlier shapes on first read.
- **The sweep arms with a first click and performs with a second** (#1), on
  the Done and Awhile-ago columns. Thresholds `doneArchiveDays` (7) and
  `idleArchiveDays` (30), with a per-thread "Keep from sweep" override.
- **Ticket chips render and link out from titles and branches** (#2).
  `PROJ-123`, `#1284`, and GitHub links become chips; inert with no GitHub
  remote.
- **GitHub status dots appear on matching chips** (#2, optional), read from
  the official GitHub plugin's local cache. A missing cache degrades to
  chip-only rendering.
- **Threads spawned as children nest under their parent card** (#3),
  Jira-subissue style. A needs-you child is promoted to its own column, a
  2-level depth cap surfaces a `+N more` chip, and filtering is
  family-aware.
- **Child rows gain full titles, and archived children stay nested** (#5).
  A "Nest child threads" toolbar toggle flattens the board when you want
  independent cards.

### Changed

- **`done_list` returns richer Done records**: `{ doneIds, records }` with
  the ISO `doneAt` stamp and `keep` flag.
- **The `done-changed` realtime payload narrows to the thread**:
  `{ threadId, done }`, was `{ count }`.
- **The README's "makes no server-side writes" wording is corrected.** It
  now names what the board actually owns: pin state, read state, Done —
  never thread content.