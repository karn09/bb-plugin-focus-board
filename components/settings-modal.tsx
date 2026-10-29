import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MotionPacing, WallpaperSettings } from "@/components/preferences";
import { WhatsNewFeed } from "@/components/whats-new-feed";
import {
  CardTransportChoice,
  LaneDirectionChoice,
  MotionControl,
  WallpaperGroup,
} from "@/components/appearance-controls";
import { APP_VERSION, type WhatsNewEntry } from "@/lib/whats-new";
import {
  ARCHIVE_UNITS,
  type ArchiveUnit,
} from "@/lib/duration";
import {
  SWEEP_CAPS,
  sweepUnitFromSetting,
  sweepValueFromSetting,
  DEFAULT_NEW_THREAD_SHORTCUT_KEY,
  newThreadShortcutKeyFromSetting,
  parseNewThreadShortcutDraft,
  type SweepSettingKey,
  type SweepValueKey,
  type SweepUnitKey,
} from "@/components/preferences";
import { cn } from "@/lib/utils";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";

/**
 * Focus Board's settings: one modal with a left tab rail (Behavior,
 * Appearance, What's new, About) and the selected tab's content on the right
 * — "how the board behaves always", not a view-mode surface. The app opens
 * it on the tab the icon asked for: a pulsing gift deep-links to What's new,
 * a plain gear opens on Behavior. State lives in the app shell; this
 * component renders the selection it is given and reports switches back.
 *
 * Below 768px the dialog already renders a bottom sheet (components/ui/
 * dialog.tsx), so the inner layout stacks to match: the rail turns into a
 * horizontally scrolling strip above the panel, the body drops the desktop's
 * pinned 440px and lets the sheet carry the height, and the panel stops
 * being its own nested scroller so the sheet is the one scroll surface.
 */
export type SettingsTab = "behavior" | "appearance" | "whats-new" | "about";

/** The board's identity copy, for the About tab. */
const PLUGIN_NAME = "Focus Board";
const PLUGIN_DESCRIPTION = "A kanban board of your threads, focused on what needs you first.";
const PLUGIN_REPO_URL = "https://github.com/cristoslc/bb-plugin-focus-board";

const TABS: readonly { id: SettingsTab; label: string }[] = [
  { id: "behavior", label: "Behavior" },
  { id: "appearance", label: "Appearance" },
  { id: "whats-new", label: "What's new" },
  { id: "about", label: "About" },
];

export interface SweepStoredValues {
  doneArchiveValue: string | number | boolean | undefined;
  doneArchiveUnit: string | number | boolean | undefined;
  idleArchiveValue: string | number | boolean | undefined;
  idleArchiveUnit: string | number | boolean | undefined;
}

const DEFAULT_SWEEP: SweepStoredValues = {
  doneArchiveValue: undefined,
  doneArchiveUnit: undefined,
  idleArchiveValue: undefined,
  idleArchiveUnit: undefined,
};

/** A Sweep key the Behavior tab can write, and the values it writes. */
export type SweepWrite = {
  key: SweepSettingKey;
  value: number | ArchiveUnit;
};

export function SettingsModal({
  open,
  onOpenChange,
  tab,
  onTabChange,
  entries,
  escStopsRunningThread,
  newThreadShortcutKey,
  sweep = DEFAULT_SWEEP,
  cardTransport,
  follow,
  motionPacing,
  laneDirection,
  wallpaper,
  onSetEscStopsRunningThread,
  onSetNewThreadShortcutKey,
  onSetSweep,
  onSetCardTransport,
  onSetMotionFollow,
  onSetMotionPacing,
  onSetLaneDirection,
  onWallpaperChange,
  jiraEnabled = false,
}: {
  /** Jira on: reminders replace the long-idle sweep, so its row is hidden. */
  jiraEnabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The selected tab; the app owns it so a deep link can land on content. */
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  entries: readonly WhatsNewEntry[];
  /**
   * The server-declared escape setting's raw stored value. `undefined` (or
   * anything but an explicit false) means the ON default applies — the same
   * rule as the board's runtime read (components/preferences.ts).
   */
  escStopsRunningThread: string | number | boolean | undefined;
  /**
   * The server-declared New Thread composer shortcut's raw stored value
   * (components/preferences.ts): unset/loading shows the C default, an
   * explicit stored empty string shows the shortcut off.
   */
  newThreadShortcutKey: string | number | boolean | undefined;
  /**
   * Called with the value to write to the host setting: a lowercased single
   * letter or digit, or the empty string for off. A failed write is
   * surfaced inline under the row, never as a silent revert.
   */
  onSetNewThreadShortcutKey: (value: string) => void | Promise<void>;
  /**
   * The four sweep threshold settings' raw stored values, read with the
   * same unset-means-default rule (components/preferences.ts) at render —
   * loading or a foreign stored shape shows the 2-days default, never a
   * coerced guess.
   */
  sweep: SweepStoredValues;
  /**
   * Called with the sweep key and value to write to the host settings; a
   * failed write surfaces inline under the row, never as a silent revert.
   */
  onSetSweep: (write: SweepWrite) => void | Promise<void>;
  /**
   * Called with the value to write to the host setting. A failed write is
   * surfaced inline under the toggle, never as a silent revert.
   */
  onSetEscStopsRunningThread: (value: boolean) => void | Promise<void>;
  /** The Appearance tab's card-transport choice (components/preferences.ts). */
  cardTransport: "none" | "teleport" | "zoom";
  /** The Appearance tab's follow-system checkbox (components/preferences.ts). */
  follow: boolean;
  /** The Appearance tab's notched motion slider (components/preferences.ts). */
  motionPacing: MotionPacing;
  /** The Appearance tab's lane-direction choice (components/preferences.ts). */
  laneDirection: "vertical" | "horizontal";
  /** The board wallpaper document, rendered by the same picker the toolbar hosts. */
  wallpaper: WallpaperSettings;
  onSetCardTransport: (value: "none" | "teleport" | "zoom") => void;
  onSetMotionFollow: (value: boolean) => void;
  onSetMotionPacing: (value: MotionPacing) => void;
  onSetLaneDirection: (value: "vertical" | "horizontal") => void;
  onWallpaperChange: (next: WallpaperSettings) => void;
}) {
  const isCompactViewport = useIsCompactViewport();
  if (!open) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Focus Board settings</DialogTitle>
        </DialogHeader>
        <div
          data-settings-body
          // The desktop dialog frames a fixed-height body so switching tabs
          // never resizes the modal. A phone sheet has no such frame to
          // defend: a pinned 440px inside it was shorter than the content and
          // taller than the sheet's own content, so compact lets the sheet
          // size itself. The inline pin is omitted, not set to "auto", so the
          // compact body carries no phantom height.
          style={isCompactViewport ? undefined : { height: "440px" }}
          className={cn(
            "flex min-w-0 gap-4",
            isCompactViewport ? "flex-col" : "overflow-hidden",
          )}
        >
          <div
            role="tablist"
            aria-label="Focus Board settings sections"
            className={cn(
              isCompactViewport
                ? "flex min-w-0 shrink-0 flex-row items-stretch gap-1 overflow-x-auto pb-1"
                : "flex w-40 shrink-0 flex-col items-stretch gap-1 self-start",
            )}
          >
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                aria-current={tab === entry.id ? "page" : undefined}
                onClick={() => onTabChange(entry.id)}
                className={cn(
                  "text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isCompactViewport
                    ? // A strip: the desktop's left accent bar rotates under
                      // the label, and each tab keeps its own width so four
                      // short labels stay on one row and scroll sideways
                      // instead of wrapping.
                      "shrink-0 whitespace-nowrap rounded-md border-b-2 px-3 py-2"
                    : "w-full rounded-r-md border-l-2 py-2 pl-3 pr-2 text-left",
                  tab === entry.id
                    ? "border-primary bg-accent/60 text-foreground"
                    : cn(
                        "border-transparent text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                        isCompactViewport ? "" : "pl-3.5",
                      ),
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            className={cn(
              "min-w-0 flex-1 pr-1",
              isCompactViewport ? "overflow-visible" : "overflow-y-auto",
            )}
          >
            {tab === "behavior" && (
              <div className="space-y-5">
                <EscStopsRunningRow
                  storedValue={escStopsRunningThread}
                  onSet={onSetEscStopsRunningThread}
                />
                <NewThreadShortcutRow
                  storedValue={newThreadShortcutKey}
                  onSet={onSetNewThreadShortcutKey}
                />
                <SweepThresholdRow
                  arm="done"
                  numberKey="doneArchiveValue"
                  unitKey="doneArchiveUnit"
                  storedValues={sweep}
                  onSet={onSetSweep}
                />
                {jiraEnabled ? null : (
                  <SweepThresholdRow
                    arm="idle"
                    numberKey="idleArchiveValue"
                    unitKey="idleArchiveUnit"
                    storedValues={sweep}
                    onSet={onSetSweep}
                  />
                )}
                <p className="text-xs leading-relaxed text-muted-foreground/80">
                  Developer-only switches (pane chat scroll instrumentation)
                  live in Focus Board&apos;s configuration page; the
                  sidebar&apos;s footer gear opens it.
                </p>
              </div>
            )}
            {tab === "appearance" && (
              <AppearanceContent
                cardTransport={cardTransport}
                follow={follow}
                motionPacing={motionPacing}
                laneDirection={laneDirection}
                wallpaper={wallpaper}
                onSetCardTransport={onSetCardTransport}
                onSetMotionFollow={onSetMotionFollow}
                onSetMotionPacing={onSetMotionPacing}
                onSetLaneDirection={onSetLaneDirection}
                onWallpaperChange={onWallpaperChange}
              />
            )}
            {tab === "whats-new" && <WhatsNewFeed entries={entries} />}
            {tab === "about" && <AboutContent />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Appearance tab: what the board's movements and backdrop look like.
 * The rows come from components/appearance-controls.tsx, the same anatomy
 * the plugin detail page's configuration section renders, so both surfaces
 * present identical controls: card animations pick the transporter's read,
 * motion overrides the OS reduce-motion media query for the board's own
 * animations, and the wallpaper hosts the inline picker (the toolbar
 * carries none — the Appearance tab is the wallpaper's only surface).
 */
/**
 * The Appearance tab: what the board's movements and backdrop look like.
 * The rows come from components/appearance-controls.tsx, the same anatomy
 * the plugin detail page's configuration section renders, so both surfaces
 * present identical controls: card animations pick the transporter's read,
 * the Motion control (a follow-system checkbox over the notched slider)
 * decides whether the board's animations play, how long they run, or
 * whether the OS reduce-motion media query rules instead, and the wallpaper
 * hosts the inline picker (the toolbar carries none — the Appearance tab is
 * the wallpaper's only surface).
 */
function AppearanceContent({
  cardTransport,
  follow,
  motionPacing,
  laneDirection,
  wallpaper,
  onSetCardTransport,
  onSetMotionFollow,
  onSetMotionPacing,
  onSetLaneDirection,
  onWallpaperChange,
}: {
  cardTransport: "none" | "teleport" | "zoom";
  follow: boolean;
  motionPacing: MotionPacing;
  laneDirection: "vertical" | "horizontal";
  wallpaper: WallpaperSettings;
  onSetCardTransport: (value: "none" | "teleport" | "zoom") => void;
  onSetMotionFollow: (value: boolean) => void;
  onSetMotionPacing: (value: MotionPacing) => void;
  onSetLaneDirection: (value: "vertical" | "horizontal") => void;
  onWallpaperChange: (next: WallpaperSettings) => void;
}) {
  return (
    <div className="space-y-5">
      <CardTransportChoice
        selected={cardTransport}
        onSelect={onSetCardTransport}
      />
      <MotionControl
        follow={follow}
        onFollowChange={onSetMotionFollow}
        pacing={motionPacing}
        onPacingChange={onSetMotionPacing}
      />
      <LaneDirectionChoice selected={laneDirection} onSelect={onSetLaneDirection} />
      <WallpaperGroup wallpaper={wallpaper} onWallpaperChange={onWallpaperChange} />
    </div>
  );
}

/** The Behavior tab's Escape row: the pane's Escape behavior setting. */function EscStopsRunningRow({
  storedValue,
  onSet,
}: {
  storedValue: string | number | boolean | undefined;
  onSet: (value: boolean) => void | Promise<void>;
}) {
  const enabled = storedValue !== false;
  const [saveError, setSaveError] = useState<string | null>(null);
  const toggle = () => {
    setSaveError(null);
    Promise.resolve(onSet(!enabled)).catch((error: unknown) => {
      // Fail loud at the point of choice: the write failed, the toggle
      // stays true to the stored value, and the reason shows right here.
      setSaveError(
        error instanceof Error ? error.message : String(error),
      );
    });
  };
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">
          Thread pane: Escape stops a running thread first
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          While a thread is running, Escape interrupts its turn instead of
          closing the pane; the pane closes with Escape once nothing is
          running, and a rapid double-tap never closes it.
        </p>
        {saveError !== null && (
          <p className="mt-2 text-xs text-destructive" role="alert">
            Saving failed: {saveError}
          </p>
        )}
      </div>
      <button
        type="button"
        aria-label="Escape stops a running thread first"
        aria-pressed={enabled}
        onClick={toggle}
        className={cn(
          "inline-flex h-6 shrink-0 items-center rounded-md border px-2 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          enabled
            ? "border-transparent bg-primary text-primary-foreground hover:bg-primary/90"
            : "bg-background text-muted-foreground hover:bg-accent",
        )}
      >
        {enabled ? "On" : "Off"}
      </button>
    </div>
  );
}

/** The Behavior tab's New Thread shortcut row: the board-composer hotkey
 *  setting (the key field plus an on/off toggle — clearing the field and
 *  the toggle write the same off state, so both surfaces stay truthful).
 *  The field commits on blur or Enter like the sweep rows; an invalid draft
 *  (anything but one letter or digit) writes nothing, surfaces inline, and
 *  snaps back to the effective key. */
function NewThreadShortcutRow({
  storedValue,
  onSet,
}: {
  storedValue: string | number | boolean | undefined;
  onSet: (value: string) => void | Promise<void>;
}) {
  const effective = newThreadShortcutKeyFromSetting(storedValue);
  const enabled = effective !== null;
  const [draft, setDraft] = useState<string>(effective ?? "");
  const [saveError, setSaveError] = useState<string | null>(null);
  // The host's confirmation re-renders this row; while loading or before
  // the write confirms, the field keeps what the user typed.
  useEffect(() => {
    setDraft(effective ?? "");
  }, [effective]);

  const commit = () => {
    setSaveError(null);
    const parsed = parseNewThreadShortcutDraft(draft);
    if (parsed === null) {
      setDraft(effective ?? "");
      setSaveError(
        "Use a single letter or digit; clear the field or use the toggle to turn the shortcut off.",
      );
      return;
    }
    if (parsed === (effective ?? "")) return;
    Promise.resolve(onSet(parsed)).catch((error: unknown) => {
      // Fail loud at the point of choice: the write failed, the field stays
      // true to the stored value, and the reason shows right here.
      setSaveError(error instanceof Error ? error.message : String(error));
    });
  };
  const toggleOff = () => {
    setSaveError(null);
    if (effective === null) return;
    Promise.resolve(onSet("")).catch((error: unknown) => {
      setSaveError(error instanceof Error ? error.message : String(error));
    });
  };
  const toggleOn = () => {
    setSaveError(null);
    Promise.resolve(onSet(DEFAULT_NEW_THREAD_SHORTCUT_KEY)).catch(
      (error: unknown) => {
        setSaveError(error instanceof Error ? error.message : String(error));
      },
    );
  };
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">
          Board: New Thread composer shortcut
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          A single letter or digit that opens the New Thread composer while
          the overview board is showing with no pane open. Default C; clear
          the field (or toggle off) to turn the shortcut off.
        </p>
        <input
          type="text"
          aria-label="New Thread composer shortcut key"
          value={draft}
          maxLength={1}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
          className="mt-2 w-16 rounded-md border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {saveError !== null && (
          <p className="mt-2 text-xs text-destructive" role="alert">
            Saving failed: {saveError}
          </p>
        )}
      </div>
      <button
        type="button"
        aria-label="New Thread composer shortcut enabled"
        aria-pressed={enabled}
        onClick={enabled ? toggleOff : toggleOn}
        className={cn(
          "inline-flex h-6 shrink-0 items-center rounded-md border px-2 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          enabled
            ? "border-transparent bg-primary text-primary-foreground hover:bg-primary/90"
            : "bg-background text-muted-foreground hover:bg-accent",
        )}
      >
        {enabled ? "On" : "Off"}
      </button>
    </div>
  );
}

/** The two sweep arms' label copy, mirroring the declared descriptors' labels. */
const SWEEP_ARMS: Record<"done" | "idle", { label: string; description: string }> = {
  done: {
    label: "Sweep: archive Done threads after",
    description:
      "How long a thread stays Done before the sweep offers to archive it.",
  },
  idle: {
    label: "Sweep: mark long-idle threads Done after",
    description:
      "How long a thread stays quiet before the sweep offers to mark it Done.",
  },
};

/**
 * One sweep threshold pair on the Behavior tab: a count field plus the unit
 * select, both writing the same declared settings the configuration panel
 * edits (the host's schema is the write authority; the modal's cap only
 * keeps obvious garbage out of the input). Field commits happen on blur or
 * Enter: an out-of-range or non-integer entry shows the failure inline and
 * snaps the field back to the effective stored value; a unit select commits
 * immediately. A failed host write surfaces inline, the Escape toggle's
 * existing pattern.
 */
function SweepThresholdRow({
  arm,
  numberKey,
  unitKey,
  storedValues,
  onSet,
}: {
  arm: "done" | "idle";
  numberKey: SweepValueKey;
  unitKey: SweepUnitKey;
  storedValues: SweepStoredValues;
  onSet: (write: SweepWrite) => void | Promise<void>;
}) {
  const effective = sweepValueFromSetting(
    storedValues[numberKey],
    numberKey,
  );
  const unit = sweepUnitFromSetting(storedValues[unitKey]);
  const [draft, setDraft] = useState(String(effective));
  const [saveError, setSaveError] = useState<string | null>(null);
  // The host's confirmation re-renders this row; while loading or before
  // the write confirms, the field keeps what the user typed.
  useEffect(() => {
    setDraft(String(effective));
  }, [effective]);

  const cap = SWEEP_CAPS[numberKey];
  const commitValue = () => {
    setSaveError(null);
    const parsed = Number(draft);
    if (parsed === effective && Number.isInteger(parsed)) return;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > cap) {
      setDraft(String(effective));
      setSaveError(
        `Expected an integer between 1 and ${cap} (in the chosen unit).`,
      );
      return;
    }
    Promise.resolve(onSet({ key: numberKey, value: parsed })).catch(
      (error: unknown) => {
        setDraft(String(effective));
        setSaveError(
          error instanceof Error ? error.message : String(error),
        );
      },
    );
  };

  const commitUnit = (next: ArchiveUnit) => {
    if (next === unit) return;
    // The count field commits first: its pending edit rides along with the
    // unit change instead of dying uncommitted when the modal closes.
    commitValue();
    setSaveError(null);
    Promise.resolve(onSet({ key: unitKey, value: next })).catch(
      (error: unknown) => {
        setSaveError(
          error instanceof Error ? error.message : String(error),
        );
      },
    );
  };

  return (
    <div>
      <p className="text-xs font-medium text-foreground">
        {SWEEP_ARMS[arm].label}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {SWEEP_ARMS[arm].description}
      </p>
      {saveError !== null && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          Saving failed: {saveError}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <input
          type="number"
          aria-label={`${SWEEP_ARMS[arm].label} count`}
          min={1}
          max={cap}
          step={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitValue}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            event.currentTarget.blur();
          }}
          className="w-20 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <select
          aria-label={`${SWEEP_ARMS[arm].label} unit`}
          value={unit}
          onChange={(event) => commitUnit(event.target.value as ArchiveUnit)}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {ARCHIVE_UNITS.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** The About tab: identity, build, and where the source lives. */
function AboutContent() {
  const isDevBuild = /-[^.]+$/.test(APP_VERSION);
  return (
    <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
      <p className="text-sm font-semibold text-foreground">{PLUGIN_NAME}</p>
      <p>
        {PLUGIN_DESCRIPTION}
      </p>
      <p>
        Version {APP_VERSION}
        {isDevBuild ? " (dev build)" : ""} — the What&apos;s new tab lists what
        changed.
      </p>
      <p>
        MIT licensed. Source and the full CHANGELOG.md live at{" "}
        <a
          href={PLUGIN_REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline-offset-2 hover:underline"
        >
          github.com/cristoslc/bb-plugin-focus-board
        </a>
        .
      </p>
    </div>
  );
}
