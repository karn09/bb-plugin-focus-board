// @vitest-environment jsdom
// The board's settings modal: one gear icon (gift while its What's-new pulse
// is on) opens a modal whose left rail picks the tab and the right pane shows
// its content — Behavior (the pane's Escape setting), What's new (the
// condensed changelog), About (identity + version). Deep-linking lands the
// pulse click straight on What's new; a plain gear opens Behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  APP_VERSION,
  unreleasedFingerprint,
  type WhatsNewEntry,
} from "../lib/whats-new";
import type { WallpaperSettings } from "../components/preferences";
import { SettingsModal, type SettingsTab } from "../components/settings-modal";
import { CompactViewportOverrideProvider } from "../components/ui/hooks/use-compact-viewport";

afterEach(cleanup);

const ENTRIES: readonly WhatsNewEntry[] = [
  { version: "1.1.0", items: [{ lead: "The sweep now refuses a parent with live children." }] },
];

const NULL_WALLPAPER: WallpaperSettings = { version: 1 as const, global: null };

interface RenderHandlers {
  onSetEscStopsRunningThread: ReturnType<typeof vi.fn>;
  onSetNewThreadShortcutKey: ReturnType<typeof vi.fn>;
  onSetSweep: ReturnType<typeof vi.fn>;
  onSetCardTransport: ReturnType<typeof vi.fn>;
  onSetMotionFollow: ReturnType<typeof vi.fn>;
  onSetMotionPacing: ReturnType<typeof vi.fn>;
  onSetLaneDirection: ReturnType<typeof vi.fn>;
  onWallpaperChange: ReturnType<typeof vi.fn>;
  onOpenChange: ReturnType<typeof vi.fn>;
}

const NULL_SWEEP = {
  doneArchiveValue: undefined,
  doneArchiveUnit: undefined,
  idleArchiveValue: undefined,
  idleArchiveUnit: undefined,
};

function renderModal(
  overrides: Partial<{
    open: boolean;
    tab: SettingsTab;
    entries: readonly WhatsNewEntry[];
    escStopsRunningThread: boolean | undefined;
    newThreadShortcutKey: string | undefined;
    sweep: typeof NULL_SWEEP;
    cardTransport: "none" | "teleport" | "zoom";
    follow: boolean;
    motionPacing: "reduce" | 1 | 2 | 4 | 8;
    laneDirection: "vertical" | "horizontal";
    wallpaper: WallpaperSettings;
    onSetEscStopsRunningThread: (value: boolean) => void | Promise<void>;
    onSetNewThreadShortcutKey: (value: string) => void | Promise<void>;
    onSetSweep: (write: { key: string; value: number | string }) => void | Promise<void>;
    onSetCardTransport: (value: "none" | "teleport" | "zoom") => void;
    onSetMotionFollow: (value: boolean) => void;
    onSetMotionFollow: (value: boolean) => void;
    onSetMotionPacing: (value: "reduce" | 1 | 2 | 4 | 8) => void;
    onSetLaneDirection: (value: "vertical" | "horizontal") => void;
    onWallpaperChange: (next: WallpaperSettings) => void;
    onOpenChange: (open: boolean) => void;
    jiraEnabled: boolean;
  }> = {},
  options: { compact?: boolean } = {},
): RenderHandlers {
  const handlers = {
    onSetEscStopsRunningThread: vi.fn(),
    onSetNewThreadShortcutKey: vi.fn(),
    onSetSweep: vi.fn(),
    onSetCardTransport: vi.fn(),
    onSetMotionFollow: vi.fn(),
    onSetMotionPacing: vi.fn(),
    onSetLaneDirection: vi.fn(),
    onWallpaperChange: vi.fn(),
    onOpenChange: vi.fn(),
  };
  const modal = (
    <SettingsModal
      open={true}
      tab="behavior"
      entries={ENTRIES}
      escStopsRunningThread={undefined}
      newThreadShortcutKey={undefined}
      sweep={NULL_SWEEP}
      onSetEscStopsRunningThread={handlers.onSetEscStopsRunningThread}
      onSetNewThreadShortcutKey={handlers.onSetNewThreadShortcutKey}
      onSetSweep={handlers.onSetSweep}
      cardTransport="zoom"
      follow={true}
      laneDirection="vertical"
      wallpaper={NULL_WALLPAPER}
      onSetCardTransport={handlers.onSetCardTransport}
      onSetMotionFollow={handlers.onSetMotionFollow}
      motionPacing={1}
      onSetMotionPacing={handlers.onSetMotionPacing}
      onSetLaneDirection={handlers.onSetLaneDirection}
      onWallpaperChange={handlers.onWallpaperChange}
      onOpenChange={handlers.onOpenChange}
      {...overrides}
    />
  );
  render(
    options.compact === true ? (
      <CompactViewportOverrideProvider isCompactViewport>
        {modal}
      </CompactViewportOverrideProvider>
    ) : (
      modal
    ),
  );
  return handlers;
}

function railTabs(): HTMLElement[] {
  const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
  expect(tabs.length).toBeGreaterThan(0);
  return tabs;
}

describe("settings modal: rail", () => {
  it("carries exactly the Behavior, Appearance, What's new, and About tabs, in that order", () => {
    renderModal();
    const labels = railTabs().map((tab) => tab.textContent);
    expect(labels).toEqual(["Behavior", "Appearance", "What's new", "About"]);
  });

  it("renders the tab the app deep-linked, and reports the selection on switch", () => {
    const deepLinked = renderModal({ tab: "whats-new" });
    expect(deepLinked).toBeDefined();
    // Deep-linked: the feed is up (its entry version header shows), and
    // Behavior's toggle is not (it lives on the unselected tab).
    expect(screen.getByText(/Version 1\.1\.0/)).not.toBeNull();
    expect(screen.queryByText(/Thread pane: Escape stops/)).toBeNull();

    cleanup();
    renderModal({ tab: "about" });
    expect(screen.getByText("Focus Board")).not.toBeNull();
  });

  it("clicking a rail tab re-selects it through the onTabChange handler", () => {
    const onTabChange = vi.fn();
    render(
      <SettingsModal
        open={true}
        tab="behavior"
        entries={ENTRIES}
        escStopsRunningThread={undefined}
        newThreadShortcutKey={undefined}
        onSetEscStopsRunningThread={vi.fn()}
        onSetNewThreadShortcutKey={vi.fn()}
        onOpenChange={vi.fn()}
        onTabChange={onTabChange}
      />,
    );
    fireEvent.click(screen.getByText("About"));
    expect(onTabChange).toHaveBeenCalledWith("about");
  });
});

describe("settings modal: Behavior tab", () => {
  it("shows the Escape setting as ON when the stored value is unset (default ON)", () => {
    renderModal({ escStopsRunningThread: undefined });
    const toggle = document.querySelector(
      'button[aria-label="Escape stops a running thread first"]',
    ) as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(toggle?.textContent).toContain("On");
  });

  it("shows the explicit stored false as OFF", () => {
    renderModal({ escStopsRunningThread: false });
    const toggle = document.querySelector(
      'button[aria-label="Escape stops a running thread first"]',
    ) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("toggling writes the flipped value through the setting handler", () => {
    const { onSetEscStopsRunningThread } = renderModal({
      escStopsRunningThread: false,
    });
    const toggle = document.querySelector(
      'button[aria-label="Escape stops a running thread first"]',
    ) as HTMLButtonElement;
    fireEvent.click(toggle);
    expect(onSetEscStopsRunningThread).toHaveBeenCalledTimes(1);
    expect(onSetEscStopsRunningThread).toHaveBeenCalledWith(true);
  });

  it("a failed write surfaces the failure inline, not as a silent revert", async () => {
    const { onSetEscStopsRunningThread } = renderModal({
      escStopsRunningThread: true,
    });
    onSetEscStopsRunningThread.mockRejectedValueOnce(
      new Error("the host refused the write"),
    );
    const toggle = document.querySelector(
      'button[aria-label="Escape stops a running thread first"]',
    ) as HTMLButtonElement;
    fireEvent.click(toggle);
    await screen.findByText(/the host refused the write/);
  });
});

describe("settings modal: Behavior tab's New Thread shortcut row", () => {
  it("shows the default key field and ON toggle when nothing is stored yet (loading)", () => {
    renderModal();
    const field = document.querySelector(
      'input[aria-label="New Thread composer shortcut key"]',
    ) as HTMLInputElement | null;
    expect(field).not.toBeNull();
    expect(field?.value).toBe("c");
    const toggle = document.querySelector(
      'button[aria-label="New Thread composer shortcut enabled"]',
    ) as HTMLButtonElement | null;
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
  });

  it("an explicitly empty stored value shows the toggle OFF", () => {
    renderModal({ newThreadShortcutKey: "" });
    const toggle = document.querySelector(
      'button[aria-label="New Thread composer shortcut enabled"]',
    ) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("shows the stored key, normalized to lowercase", () => {
    renderModal({ newThreadShortcutKey: "N" });
    const field = document.querySelector(
      'input[aria-label="New Thread composer shortcut key"]',
    ) as HTMLInputElement;
    expect(field.value).toBe("n");
  });

  it("a valid single-key edit commits on blur with the normalized key", () => {
    const { onSetNewThreadShortcutKey } = renderModal();
    const field = document.querySelector(
      'input[aria-label="New Thread composer shortcut key"]',
    ) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "N" } });
    fireEvent.blur(field);
    expect(onSetNewThreadShortcutKey).toHaveBeenCalledTimes(1);
    expect(onSetNewThreadShortcutKey).toHaveBeenCalledWith("n");
  });

  it("clearing the field commits the off state (empty string)", () => {
    const { onSetNewThreadShortcutKey } = renderModal({
      newThreadShortcutKey: "c",
    });
    const field = document.querySelector(
      'input[aria-label="New Thread composer shortcut key"]',
    ) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);
    expect(onSetNewThreadShortcutKey).toHaveBeenCalledWith("");
  });

  it("an invalid edit writes nothing, surfaces the failure inline, and snaps back", () => {
    const { onSetNewThreadShortcutKey } = renderModal();
    const field = document.querySelector(
      'input[aria-label="New Thread composer shortcut key"]',
    ) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "cn" } });
    fireEvent.blur(field);
    expect(onSetNewThreadShortcutKey).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Saving failed: Use a single letter or digit/),
    ).not.toBeNull();
    expect(field.value).toBe("c");
  });

  it("toggling off writes the empty string; toggling on writes the default C", () => {
    const { onSetNewThreadShortcutKey } = renderModal();
    const toggle = document.querySelector(
      'button[aria-label="New Thread composer shortcut enabled"]',
    ) as HTMLButtonElement;
    fireEvent.click(toggle);
    expect(onSetNewThreadShortcutKey).toHaveBeenCalledWith("");

    cleanup();
    const reHandlers = renderModal({ newThreadShortcutKey: "" });
    const reToggle = document.querySelector(
      'button[aria-label="New Thread composer shortcut enabled"]',
    ) as HTMLButtonElement;
    fireEvent.click(reToggle);
    expect(reHandlers.onSetNewThreadShortcutKey).toHaveBeenCalledWith("c");
  });

  it("a failed write surfaces the failure inline, not as a silent revert", async () => {
    const { onSetNewThreadShortcutKey } = renderModal();
    onSetNewThreadShortcutKey.mockRejectedValueOnce(
      new Error("the host refused the write"),
    );
    const toggle = document.querySelector(
      'button[aria-label="New Thread composer shortcut enabled"]',
    ) as HTMLButtonElement;
    fireEvent.click(toggle);
    await screen.findByText(/the host refused the write/);
  });
});

describe("settings modal: Behavior tab's Sweep block", () => {
  it("Jira on: the long-idle row is hidden (reminders replace it); the Done row stays", () => {
    renderModal({ jiraEnabled: true });
    expect(screen.queryByLabelText("Sweep: mark long-idle threads Done after count")).toBeNull();
    expect(screen.getByLabelText("Sweep: archive Done threads after count")).toBeTruthy();
  });

  it("renders both arms with the defaults when nothing is stored yet (loading)", () => {
    renderModal();
    const doneCount = screen.getByLabelText("Sweep: archive Done threads after count") as HTMLInputElement;
    const doneUnit = screen.getByLabelText("Sweep: archive Done threads after unit") as HTMLSelectElement;
    expect(doneCount.value).toBe("2");
    expect([...doneUnit.options].find((o) => o.selected)?.value).toBe("days");
    expect([...doneUnit.options].map((o) => o.value)).toEqual(["hours", "days", "weeks"]);
    const idleCount = screen.getByLabelText("Sweep: mark long-idle threads Done after count") as HTMLInputElement;
    const idleUnit = screen.getByLabelText("Sweep: mark long-idle threads Done after unit") as HTMLSelectElement;
    expect(idleCount.value).toBe("2");
    expect([...idleUnit.options].find((o) => o.selected)?.value).toBe("days");
  });

  it("renders the stored effective values over the defaults", () => {
    renderModal({
      sweep: { ...NULL_SWEEP, doneArchiveValue: 5, doneArchiveUnit: "hours" },
    });
    expect(
      (screen.getByLabelText("Sweep: archive Done threads after count") as HTMLInputElement).value,
    ).toBe("5");
    const doneUnit = screen.getByLabelText("Sweep: archive Done threads after unit") as HTMLSelectElement;
    expect(doneUnit.value).toBe("hours");
  });

  it("a valid edited count commits on blur with the right key and number", () => {
    const { onSetSweep } = renderModal({
      sweep: { ...NULL_SWEEP, idleArchiveValue: 10 },
    });
    const idle = screen.getByLabelText("Sweep: mark long-idle threads Done after count") as HTMLInputElement;
    fireEvent.change(idle, { target: { value: "30" } });
    fireEvent.blur(idle);
    expect(onSetSweep).toHaveBeenCalledTimes(1);
    expect(onSetSweep).toHaveBeenCalledWith({ key: "idleArchiveValue", value: 30 });
  });

  it("an out-of-range edit writes nothing, surfaces the failure inline, and snaps the field back", () => {
    const { onSetSweep } = renderModal();
    const done = screen.getByLabelText("Sweep: archive Done threads after count") as HTMLInputElement;
    fireEvent.change(done, { target: { value: "9999" } });
    fireEvent.blur(done);
    expect(onSetSweep).not.toHaveBeenCalled();
    expect(screen.getByText(/Expected an integer between 1 and 365/)).not.toBeNull();
    expect(done.value).toBe("2");
  });

  it("a unit select change writes the right key immediately", () => {
    const { onSetSweep } = renderModal();
    const doneUnit = screen.getByLabelText("Sweep: archive Done threads after unit") as HTMLSelectElement;
    fireEvent.change(doneUnit, { target: { value: "weeks" } });
    expect(onSetSweep).toHaveBeenCalledWith({ key: "doneArchiveUnit", value: "weeks" });
  });

  it("a rejected write surfaces the failure inline, not as a silent revert", async () => {
    const { onSetSweep } = renderModal();
    onSetSweep.mockRejectedValueOnce(new Error("the host refused the write"));
    const doneUnit = screen.getByLabelText("Sweep: archive Done threads after unit") as HTMLSelectElement;
    fireEvent.change(doneUnit, { target: { value: "weeks" } });
    await screen.findByText(/the host refused the write/);
  });

  it("points developer-only settings at the configuration page, without rendering them", () => {
    renderModal();
    expect(screen.getByText(/Developer-only switches/)).not.toBeNull();
    expect(screen.queryByText(/instrument pane chat scrolling/i)).toBeNull();
  });
});

describe("settings modal: What's new tab", () => {
  it("renders the condensed feed: version headers with leads (children nested)", () => {
    renderModal({
      tab: "whats-new",
      entries: [
        {
          version: "1.1.0",
          items: [{ lead: "The lead line.", children: ["A sub-bullet."] }],
        },
      ],
    });
    expect(screen.getByText(/Version 1\.1\.0/)).not.toBeNull();
    expect(screen.getByText("The lead line.")).not.toBeNull();
    expect(screen.getByText("A sub-bullet.")).not.toBeNull();
  });

  it("describes an empty feed as the running version, not as 'recent changes'", () => {
    renderModal({ tab: "whats-new", entries: [] });
    expect(screen.getByText(new RegExp(`version ${APP_VERSION}`))).not.toBeNull();
  });

  it("the far-left case: without an unseen set the unreleased group renders amber wholesale (legacy shape)", () => {
    renderModal({
      tab: "whats-new",
      entries: [
        { version: "1.2.1-dev", unreleased: true, items: [{ lead: "Carried over." }] },
      ],
    });
    const carried = screen.getByText("Carried over.") as HTMLElement;
    expect(carried.className).toContain("text-amber");
  });

  it("amber follows the unseen set: fresh lines light, already-seen lines stay muted", () => {
    renderModal({
      tab: "whats-new",
      entries: [
        {
          version: "1.2.1-dev",
          unreleased: true,
          unseenLeads: new Set([unreleasedFingerprint(["Fresh line."])]),
          items: [{ lead: "Fresh line." }, { lead: "Carried over." }],
        },
      ],
    });
    const fresh = screen.getByText("Fresh line.") as HTMLElement;
    expect(fresh.className).toContain("text-amber");
    const carried = screen.getByText("Carried over.") as HTMLElement;
    expect(carried.className).not.toContain("text-amber");
  });

  it("a subheading is amber when any bullet under it is amber, muted when none is", () => {
    const makeEntry = (leads: ReadonlySet<string>) => ({
      version: "1.2.1-dev",
      unreleased: true,
      unseenLeads: leads,
      items: [{ lead: "Fresh.", group: "Fresh surface" }, { lead: "Stale.", group: "Stale surface" }],
    });
    renderModal({
      tab: "whats-new",
      entries: [
        makeEntry(new Set([unreleasedFingerprint(["Fresh."])])) as WhatsNewEntry,
      ],
    });
    expect(screen.getByText("Fresh surface").className).toContain("text-amber");
    expect(screen.getByText("Stale surface").className).not.toContain("text-amber");
    // The entry header follows the same rule.
    expect(screen.getByText(/Unreleased 1\.2\.1-dev/).className).toContain("text-amber");

    cleanup();
    renderModal({
      tab: "whats-new",
      entries: [makeEntry(new Set()) as WhatsNewEntry],
    });
    expect(screen.getByText("Fresh surface").className).not.toContain("text-amber");
    expect(screen.getByText("Stale surface").className).not.toContain("text-amber");
    expect(screen.getByText(/Unreleased 1\.2\.1-dev/).className).not.toContain("text-amber");
  });
});

describe("settings modal: About tab", () => {
  it("names the plugin and shows the running version", () => {
    renderModal({ tab: "about" });
    expect(screen.getByText("Focus Board")).not.toBeNull();
    expect(screen.getByText(new RegExp(APP_VERSION))).not.toBeNull();
  });

  it("marks a prerelease build as a dev build", () => {
    // APP_VERSION is "1.1.1-dev" in dev trees; the About panel must say so.
    renderModal({ tab: "about" });
    if (/-.+$/.test(APP_VERSION)) {
      expect(screen.getByText(/dev build/i)).not.toBeNull();
    }
  });

  it("points at the plugin repository", () => {
    renderModal({ tab: "about" });
    const link = document.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/cristoslc/bb-plugin-focus-board"]',
    );
    expect(link).not.toBeNull();
  });
});

describe("settings modal: Appearance tab", () => {
  it("offers the three transport choices with the shipped zoom default selected", () => {
    renderModal({ tab: "appearance" });
    const group = document.querySelector('[role="radiogroup"][aria-label="Card animations"]');
    expect(group).not.toBeNull();
    const radios = [...document.querySelectorAll('[role="radio"][aria-checked]')].filter(
      (el) => group?.contains(el),
    );
    expect(radios.map((el) => el.textContent)).toEqual(["None", "Teleport", "Zoom out / in"]);
    const zoom = radios.find((el) => el.textContent === "Zoom out / in");
    expect(zoom?.getAttribute("aria-checked")).toBe("true");
  });

  it("picking a transport choice reports it through the handler", () => {
    const { onSetCardTransport } = renderModal({ tab: "appearance", cardTransport: "teleport" });
    const none = screen.getByRole("radio", { name: "None" });
    fireEvent.click(none);
    expect(onSetCardTransport).toHaveBeenCalledWith("none");
    fireEvent.click(screen.getByRole("radio", { name: "Zoom out / in" }));
    expect(onSetCardTransport).toHaveBeenCalledWith("zoom");
  });

  it("the zoom choice selects and deselects like the others (it maps to the navbar's zoom variant)", () => {
    // The build runs every transport variant (zoom included), so the tab
    // never offers a choice the board cannot play.
    render(
      <SettingsModal
        open={true}
        tab="appearance"
        entries={ENTRIES}
        escStopsRunningThread={undefined}
        newThreadShortcutKey={undefined}
        sweep={NULL_SWEEP}
        onSetSweep={vi.fn()}
        cardTransport="teleport"
        follow={true}
        laneDirection="vertical"
        wallpaper={NULL_WALLPAPER}
        onSetEscStopsRunningThread={vi.fn()}
        onSetNewThreadShortcutKey={vi.fn()}
        onSetCardTransport={vi.fn()}
        onSetMotionFollow={vi.fn()}
        motionPacing={1}
        onSetMotionPacing={vi.fn()}
        onSetLaneDirection={vi.fn()}
        onWallpaperChange={vi.fn()}
        onOpenChange={vi.fn()}
      />,
    );
    const zoom = screen.getByRole("radio", { name: "Zoom out / in" });
    expect(zoom.getAttribute("aria-disabled")).toBeNull();
    const checked = document
      .querySelector('[role="radiogroup"][aria-label="Card animations"]')
      ?.querySelectorAll('[role="radio"][aria-checked="true"]');
    expect(checked).toHaveLength(1);
  });

  it("the Motion control is a follow-system checkbox over a notched slider", () => {
    renderModal({ tab: "appearance" });
    // The checkbox defaults to following the system.
    const checkbox = screen.getByRole("checkbox", { name: "Follow my system setting" }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    // The slider replaces the old tri-state: leftmost notch is reduce, the
    // second is stock 1x, and the notches right of stock stretch logarithmically.
    const slider = screen.getByRole("slider", { name: "Motion" }) as HTMLInputElement;
    expect(slider.value).toBe("1"); // notch index 1 = 1x stock
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("4");
    expect(slider.disabled).toBe(true);
    // The readout names the notch.
    expect(document.body.textContent).toContain("Stock (1x)");
  });

  it("unchecking follow-system enables the notched slider, and notching it reports", () => {
    const { onSetMotionFollow, onSetMotionPacing } = renderModal({ tab: "appearance", follow: false });
    expect(screen.getByRole("slider", { name: "Motion" }).getAttribute("aria-disabled")).toBeNull();
    const slider = screen.getByRole("slider", { name: "Motion" }) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "4" } });
    expect(onSetMotionPacing).toHaveBeenCalledWith(8);
    fireEvent.change(slider, { target: { value: "0" } });
    expect(onSetMotionPacing).toHaveBeenCalledWith("reduce");
    const checkbox = screen.getByRole("checkbox", { name: "Follow my system setting" });
    fireEvent.click(checkbox);
    expect(onSetMotionFollow).toHaveBeenCalledWith(true);
  });

  it("the slider reads a seeded manual pacing and its follow state from the props", () => {
    renderModal({ tab: "appearance", follow: false, motionPacing: 4 });
    const slider = screen.getByRole("slider", { name: "Motion" }) as HTMLInputElement;
    expect(slider.value).toBe("3"); // notch index 3 = 4x
    expect(slider.disabled).toBe(false);
    const checkbox = screen.getByRole("checkbox", { name: "Follow my system setting" }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it("offers the two lane-direction choices with the vertical default selected", () => {
    renderModal({ tab: "appearance" });
    const group = document.querySelector('[role="radiogroup"][aria-label="Lane direction"]');
    expect(group).not.toBeNull();
    const radios = [...document.querySelectorAll('[role="radio"][aria-checked]')].filter(
      (el) => group?.contains(el),
    );
    expect(radios.map((el) => el.textContent)).toEqual(["Vertical", "Horizontal"]);
    expect(radios[0]?.getAttribute("aria-checked")).toBe("true");
  });

  it("picking a lane direction reports it through the handler", () => {
    const { onSetLaneDirection } = renderModal({ tab: "appearance", laneDirection: "vertical" });
    fireEvent.click(screen.getByRole("radio", { name: "Horizontal" }));
    expect(onSetLaneDirection).toHaveBeenCalledWith("horizontal");
  });

  it("mounts the wallpaper picker contents inline in the tab content", () => {
    renderModal({ tab: "appearance", wallpaper: NULL_WALLPAPER });
    // The Appearance tab is the wallpaper's only surface: the picker is not
    // a toolbar-style popover here — its contents (preset swatches and the
    // free-form url field) render directly in the tab's scroll.
    expect(
      document.querySelectorAll('button[aria-label^="Wallpaper preset:"]').length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("textbox", { name: "Wallpaper image url" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Wallpaper" })).toBeNull();
  });
});

describe("settings modal: shell", () => {
  it("closing asks the app to close (onOpenChange(false))", () => {
    const { onOpenChange } = renderModal();
    fireEvent.click(screen.getByText("Close"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders nothing while closed (open=false renders no tabs)", () => {
    renderModal({ open: false });
    expect(document.querySelectorAll('[role="tab"]').length).toBe(0);
  });

  it("carries no tagline — the description line is gone, the title speaks alone", () => {
    renderModal();
    expect(screen.queryByText(/How the board behaves/)).toBeNull();
    expect(screen.queryByText(/one icon opens these/)).toBeNull();
  });

  it("the selected rail tab marks itself as navigation state (aria-current + accent bar)", () => {
    renderModal({ tab: "appearance" });
    const active = document.querySelector('[role="tab"][aria-current="page"]');
    expect(active?.textContent).toBe("Appearance");
    // The indicator is the accent bar (border-primary), not a content-driven
    // color; the unselected tabs carry a transparent bar so the text column
    // never shifts.
    expect(active?.className).toContain("border-primary");
    const unselected = document.querySelector('[role="tab"]:not([aria-current])');
    expect(unselected).not.toBeNull();
    expect(unselected?.className).not.toContain("border-primary");
  });

  it("carries a fixed body height on every tab — switching does not resize the modal", () => {
    // The rail+pane row declares its height as an inline fixed dimension
    // (data-settings-body); jsdom has no layout, so the contract is the
    // dimension itself, identical for the short Behavior/About tabs and the
    // tall What's-new tab. Content scrolls inside the fixed frame instead
    // of growing it.
    const height = (tab: SettingsTab): string => {
      renderModal({ tab });
      const body = document.querySelector<HTMLElement>('[data-settings-body]');
      if (body === null) throw new Error("modal body not found");
      const value = body.style.height;
      cleanup();
      return value;
    };
    const behaviorHeight = height("behavior");
    expect(behaviorHeight).toMatch(/^\d+px$/);
    expect(height("whats-new")).toBe(behaviorHeight);
    expect(height("about")).toBe(behaviorHeight);
  });

  it("the What's-new feed flows into the fixed body — its own per-tab height cap is gone", () => {
    renderModal({ tab: "whats-new" });
    const feed = document.querySelector<HTMLElement>('[data-whats-new-feed]');
    expect(feed).not.toBeNull();
    // The old max-h-[55vh] cap made each tab size itself; the fixed body
    // carries the scroll now.
    expect(feed?.className).not.toContain("max-h-");
  });
});

describe("settings modal: compact viewport", () => {
  // The dialog already switches to a bottom sheet below 768px
  // (components/ui/dialog.tsx), so the inner layout has to stack with it:
  // a 160px side rail beside a 180px panel left the Appearance tab a sliver
  // at a 390px phone width, with the wallpaper picker overflowing its box.
  it("stacks the tabs over the panel: a horizontal strip, not a 160px side rail", async () => {
    renderModal({ tab: "appearance" }, { compact: true });
    // The drawer realizes its content a couple of frames after opening.
    const rail = await screen.findByRole("tablist");
    expect(rail.className).toContain("flex-row");
    expect(rail.className).not.toContain("w-40");
    // A strip wider than the sheet scrolls sideways rather than wrapping the
    // four tabs into rows.
    expect(rail.className).toContain("overflow-x-auto");
    for (const tab of railTabs()) {
      expect(tab.className).toContain("shrink-0");
      expect(tab.className).toContain("whitespace-nowrap");
      // The accent-bar idiom survives, rotated under the label.
      expect(tab.className).toContain("border-b-2");
      expect(tab.className).not.toContain("border-l-2");
    }
  });

  it("drops the 440px body pin so the sheet, not a 440px box, holds the content", async () => {
    renderModal({ tab: "appearance" }, { compact: true });
    await screen.findByRole("tablist");
    const body = document.querySelector<HTMLElement>("[data-settings-body]");
    if (body === null) throw new Error("modal body not found");
    expect(body.style.height).toBe("");
    expect(body.className).toContain("flex-col");
    // One scroll surface, not a fixed box clipping a nested scroller.
    const panel = document.querySelector<HTMLElement>('[role="tabpanel"]');
    expect(panel?.className).toContain("overflow-visible");
    expect(panel?.className).not.toContain("overflow-y-auto");
  });

  it("keeps the desktop rail and body pin (inverse: a wide viewport is untouched)", async () => {
    renderModal({ tab: "appearance" }, { compact: false });
    const rail = await screen.findByRole("tablist");
    expect(rail.className).toContain("w-40");
    expect(rail.className).toContain("flex-col");
    expect(rail.className).not.toContain("overflow-x-auto");
    const body = document.querySelector<HTMLElement>("[data-settings-body]");
    expect(body?.style.height).toBe("440px");
    expect(body?.className).not.toContain("flex-col");
    expect(document.querySelector<HTMLElement>('[role="tabpanel"]')?.className).toContain(
      "overflow-y-auto",
    );
  });
});
