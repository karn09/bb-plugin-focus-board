// @vitest-environment jsdom
// The board card's right-click menu is assembled by a pure builder
// (lib/card-menu.ts) so the grouping — the UX itself — can be pinned
// without rendering the app. The order IS the design: the flat list
// mixed navigation, state toggles, lineage and lifecycle entries in one
// block, and "Reveal browser tab" read as a sibling of state actions
// instead of a destination. These tests pin group order, the exact
// divider heads (a divider opens each group, nothing else), the
// state-driven label/icon flips, and that Delete stays the only danger
// entry.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	cardMenuActions,
	type CardMenuHandlers,
	type CardMenuInputs,
} from "../lib/card-menu";

const noop = () => {};

function makeHandlers(): CardMenuHandlers {
	return {
		zoomToFamily: vi.fn(noop),
		togglePinned: vi.fn(noop),
		toggleRead: vi.fn(noop),
		toggleDone: vi.fn(noop),
		clearError: vi.fn(noop),
		toggleSweepKeep: vi.fn(noop),
		makeTopLevel: vi.fn(noop),
		archive: vi.fn(noop),
		requestDelete: vi.fn(noop),
		revealBrowserTabs: vi.fn(noop),
		clearSnooze: vi.fn(noop),
		openSnoozePicker: vi.fn(noop),
		openGroupPicker: vi.fn(noop),
		openNewChild: vi.fn(noop),
		openInBrowser: vi.fn(noop),
	};
}

function makeInputs(overrides?: {
	thread?: Partial<CardMenuInputs["thread"]>;
	isDone?: boolean;
	isSnoozed?: boolean;
	isKept?: boolean;
	grouped?: boolean;
	canClearError?: boolean;
	inFamily?: boolean;
}): CardMenuInputs {
	return {
		thread: {
			id: "thr_1",
			href: "/threads/thr_1",
			isPinned: false,
			isUnread: false,
			isArchived: false,
			parentThreadId: null,
			...overrides?.thread,
		},
		isDone: overrides?.isDone ?? false,
		isSnoozed: overrides?.isSnoozed ?? false,
		isKept: overrides?.isKept ?? false,
		grouped: overrides?.grouped ?? false,
		canClearError: overrides?.canClearError ?? false,
		inFamily: overrides?.inFamily ?? false,
	};
}

function action(inputs: CardMenuInputs, id: string, handlers = makeHandlers()) {
	const actions = cardMenuActions(inputs, handlers);
	const found = actions.find((entry) => entry.id === id);
	expect(found, `menu carries ${id}`).toBeTruthy();
	return found!;
}

describe("card menu: Jira's Don't nudge toggle", () => {
	it("absent with Jira off (noNudge undefined)", () => {
		const ids = cardMenuActions(makeInputs(), makeHandlers()).map((entry) => entry.id);
		expect(ids).not.toContain("no-nudge");
	});
	it("with Jira on it joins the state group after Group; the label flips and runs the toggle", () => {
		const handlers = { ...makeHandlers(), toggleNoNudge: vi.fn(noop) };
		const on = cardMenuActions({ ...makeInputs(), noNudge: false }, handlers);
		const ids = on.map((entry) => entry.id);
		expect(ids.indexOf("no-nudge")).toBe(ids.indexOf("group") + 1);
		const entry = on.find((x) => x.id === "no-nudge")!;
		expect(entry.label).toBe("Don't nudge this thread");
		expect(entry.dividerAbove).toBeUndefined();
		entry.run();
		expect(handlers.toggleNoNudge).toHaveBeenCalledTimes(1);
		expect(action({ ...makeInputs(), noNudge: true }, "no-nudge", handlers).label).toBe("Allow nudges");
	});
});

describe("card menu grouping", () => {
	it("the base thread's actions sit in the group order: destinations, state, lineage, lifecycle", () => {
		const ids = cardMenuActions(makeInputs(), makeHandlers()).map((entry) => entry.id);
		expect(ids).toEqual([
			"open-in-browser",
			"reveal-browser-tab",
			"pin",
			"read",
			"done",
			"snooze",
			"group",
			"new-child",
			"sweep-keep",
			"archive",
			"delete",
		]);
	});

	it("dividers open exactly the four group heads — nothing else carries one", () => {
		const actions = cardMenuActions(makeInputs(), makeHandlers());
		const byId = Object.fromEntries(actions.map((entry) => [entry.id, entry]));
		expect(byId["open-in-browser"].dividerAbove).toBe(true);
		expect(byId["reveal-browser-tab"].dividerAbove).toBeUndefined();
		expect(byId["pin"].dividerAbove).toBe(true);
		expect(byId["read"].dividerAbove).toBeUndefined();
		expect(byId["done"].dividerAbove).toBeUndefined();
		// Snooze and group fold into the state group here (both open
		// pickers); the pane's actions menu keeps the shared snooze
		// builder's own divider above its entry.
		expect(byId["snooze"].dividerAbove).toBeUndefined();
		expect(byId["group"].dividerAbove).toBeUndefined();
		expect(byId["new-child"].dividerAbove).toBe(true);
		expect(byId["sweep-keep"].dividerAbove).toBe(true);
		expect(byId["archive"].dividerAbove).toBeUndefined();
		expect(byId["delete"].dividerAbove).toBeUndefined();
	});

	it("a nested thread carries Make Top-Level right after New child thread…, inside the lineage group", () => {
		const actions = cardMenuActions(
			makeInputs({ thread: { parentThreadId: "thr_parent" } }),
			makeHandlers(),
		);
		const ids = actions.map((entry) => entry.id);
		expect(ids.indexOf("unnest")).toBe(ids.indexOf("new-child") + 1);
		expect(ids.indexOf("unnest")).toBeLessThan(ids.indexOf("sweep-keep"));
	});

	it("Delete is the only danger entry", () => {
		const actions = cardMenuActions(makeInputs(), makeHandlers());
		const dangerous = actions.filter((entry) => entry.danger).map((entry) => entry.id);
		expect(dangerous).toEqual(["delete"]);
	});

	it("Open in browser routes through the shared open handler with the card's href", () => {
		const handlers = makeHandlers();
		action(makeInputs({ thread: { href: "/threads/thr_9" } }), "open-in-browser", handlers).run();
		// The builder owns order and labels only; the handler performs the
		// one open gesture — the raw window.open the desktop window guard
		// routes to the system browser.
		expect(handlers.openInBrowser).toHaveBeenCalledWith("/threads/thr_9");
	});

	it("every state and lineage entry runs its handler", () => {
		const handlers = makeHandlers();
		const actions = cardMenuActions(makeInputs(), handlers);
		const run = (id: string) => actions.find((entry) => entry.id === id)!.run();
		run("reveal-browser-tab");
		run("pin");
		run("read");
		run("done");
		run("snooze");
		run("group");
		run("new-child");
		run("sweep-keep");
		run("archive");
		run("delete");
		expect(handlers.revealBrowserTabs).toHaveBeenCalledTimes(1);
		expect(handlers.togglePinned).toHaveBeenCalledTimes(1);
		expect(handlers.toggleRead).toHaveBeenCalledTimes(1);
		expect(handlers.toggleDone).toHaveBeenCalledTimes(1);
		expect(handlers.openSnoozePicker).toHaveBeenCalledTimes(1);
		expect(handlers.openGroupPicker).toHaveBeenCalledTimes(1);
		expect(handlers.openNewChild).toHaveBeenCalledTimes(1);
		expect(handlers.toggleSweepKeep).toHaveBeenCalledTimes(1);
		expect(handlers.archive).toHaveBeenCalledTimes(1);
		expect(handlers.requestDelete).toHaveBeenCalledTimes(1);
	});
});

describe("card menu state-driven labels and icons", () => {
	it("a pinned card offers Unpin (PinOff); an unpinned one offers Pin", () => {
		const pinned = action(makeInputs({ thread: { isPinned: true } }), "pin");
		expect(pinned.label).toBe("Unpin");
		expect(pinned.icon).toBe("PinOff");
		const unpinned = action(makeInputs(), "pin");
		expect(unpinned.label).toBe("Pin");
		expect(unpinned.icon).toBe("Pin");
	});

	it("an unread card offers Mark Read (MailOpen); a read one offers Mark Unread", () => {
		const unread = action(makeInputs({ thread: { isUnread: true } }), "read");
		expect(unread.label).toBe("Mark Read");
		expect(unread.icon).toBe("MailOpen");
		const read = action(makeInputs(), "read");
		expect(read.label).toBe("Mark Unread");
		expect(read.icon).toBe("Mail");
	});

	it("a done card offers Mark Not Done (CircleCheck); an open one Mark Done", () => {
		const done = action(makeInputs({ isDone: true }), "done");
		expect(done.label).toBe("Mark Not Done");
		expect(done.icon).toBe("CircleCheck");
		const open = action(makeInputs(), "done");
		expect(open.label).toBe("Mark Done");
		expect(open.icon).toBe("Check");
	});

	it("a snoozed card edits its snooze; an unsnoozed one opens the picker", () => {
		const snoozed = action(makeInputs({ isSnoozed: true }), "snooze-edit");
		expect(snoozed.label).toBe("Edit snooze…");
		expect(snoozed.icon).toBe("ClockArrowUp");
		const unsnoozed = action(makeInputs(), "snooze");
		expect(unsnoozed.label).toBe("Snooze…");
		expect(unsnoozed.icon).toBe("Clock");
	});

	it("a grouped card offers Change group…; an ungrouped one Group… — a picker-opening group entry next to snooze", () => {
		const grouped = action(makeInputs({ grouped: true }), "group-change");
		expect(grouped.label).toBe("Change group…");
		expect(grouped.icon).toBe("Tag");
		const ungrouped = action(makeInputs(), "group");
		expect(ungrouped.label).toBe("Group…");
		expect(ungrouped.icon).toBe("Tag");
	});

	it("a kept card offers Allow sweep (Archive); a swept one Keep from sweep (Pin)", () => {
		const kept = action(makeInputs({ isKept: true }), "sweep-keep");
		expect(kept.label).toBe("Allow sweep");
		expect(kept.icon).toBe("Archive");
		const swept = action(makeInputs(), "sweep-keep");
		expect(swept.label).toBe("Keep from sweep");
		expect(swept.icon).toBe("Pin");
	});

	it("an archived card offers Unarchive (ArchiveRestore); a live one Archive", () => {
		const archived = action(makeInputs({ thread: { isArchived: true } }), "archive");
		expect(archived.label).toBe("Unarchive");
		expect(archived.icon).toBe("ArchiveRestore");
		const live = action(makeInputs(), "archive");
		expect(live.label).toBe("Archive");
		expect(live.icon).toBe("Archive");
	});
});

describe("card menu Zoom to family (issue #170)", () => {
	it("a family member's card opens the lineage group with Zoom to family ahead of New child thread…", () => {
		const actions = cardMenuActions(makeInputs({ inFamily: true }), makeHandlers());
		const ids = actions.map((entry) => entry.id);
		expect(ids).toEqual([
			"open-in-browser",
			"reveal-browser-tab",
			"pin",
			"read",
			"done",
			"snooze",
			"group",
			"zoom-to-family",
			"new-child",
			"sweep-keep",
			"archive",
			"delete",
		]);
	});

	it("Zoom to family is the lineage divider's head; New child thread… follows undivided", () => {
		const actions = cardMenuActions(makeInputs({ inFamily: true }), makeHandlers());
		const byId = Object.fromEntries(actions.map((entry) => [entry.id, entry]));
		expect(byId["zoom-to-family"].dividerAbove).toBe(true);
		expect(byId["new-child"].dividerAbove).toBeUndefined();
	});

	it("the entry reads Zoom to family (ZoomIn)", () => {
		const entry = action(makeInputs({ inFamily: true }), "zoom-to-family");
		expect(entry.label).toBe("Zoom to family");
		expect(entry.icon).toBe("ZoomIn");
	});

	it("a card outside any multi-member family carries no zoom entry", () => {
		const actions = cardMenuActions(makeInputs({ inFamily: false }), makeHandlers());
		expect(actions.find((entry) => entry.id === "zoom-to-family")).toBeUndefined();
	});

	it("running Zoom to family invokes the caller's handler once", () => {
		const handlers = makeHandlers();
		action(makeInputs({ inFamily: true }), "zoom-to-family", handlers).run();
		expect(handlers.zoomToFamily).toHaveBeenCalledTimes(1);
	});
});

describe("card menu Clear error (issue #157)", () => {
	it("a card whose attention comes from error signals alone offers Clear error beside the state toggles", () => {
		const actions = cardMenuActions(makeInputs({ canClearError: true }), makeHandlers());
		const read = actions.findIndex((a) => a.id === "read");
		const clear = actions.findIndex((a) => a.id === "clear-error");
		const done = actions.findIndex((a) => a.id === "done");
		expect(clear).toBeGreaterThan(read);
		expect(clear).toBeLessThan(done);
		const entry = actions[clear]!;
		expect(entry.label).toBe("Clear error");
		expect(entry.icon).toBe("BellOff");
		expect(entry.dividerAbove).toBeUndefined();
	});

	it("a card without error-signal attention offers no Clear error", () => {
		const actions = cardMenuActions(makeInputs({ canClearError: false }), makeHandlers());
		expect(actions.find((a) => a.id === "clear-error")).toBeUndefined();
	});

	it("running Clear error invokes the caller's handler (one acknowledgment)", () => {
		const handlers = makeHandlers();
		const entry = cardMenuActions(makeInputs({ canClearError: true }), handlers).find(
			(a) => a.id === "clear-error",
		);
		expect(entry).toBeDefined();
		entry!.run();
		expect(handlers.clearError).toHaveBeenCalledTimes(1);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});