import { type ReactNode, useEffect, useRef } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * The fixed-position right-click menu shell: a click-away backdrop, a
 * viewport-clamped popover, and the header line naming what the menu acts
 * on. Entry buttons are the caller's children — the shell knows nothing
 * about actions (thread cards, group boxes, and future menus can render
 * whatever rows they own). The anchor wrapper stays with the caller, so
 * each surface keeps its own propagation stop (a nested card's menu must
 * never also open its ancestor's).
 */
export function MenuPopover({
  open,
  onClose,
  label,
  title,
  children,
}: {
  /**
   * The pointer position the menu opens at, or null (closed). State held
   * by the caller — several surfaces can render at once and the caller
   * decides which (if any) one is open.
   */
  open: { x: number; y: number } | null;
  /** Close on backdrop click, backdrop right-click, or after any entry ran. */
  onClose: () => void;
  /** The popover's accessible name, e.g. "Thread actions" / "Group actions". */
  label: string;
  /** The header line naming what the menu acts on (the thread or group). */
  title: ReactNode;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const isOpen = open !== null;
  // Keyboard: focus the first entry on open; Escape closes and hands focus
  // back to whatever held it when the menu opened (the opener, usually).
  useEffect(() => {
    if (!isOpen) return;
    const before = document.activeElement;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeRef.current();
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen]);
  if (open === null) return null;
  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
        aria-hidden
      />
      <div
        role="menu"
        aria-label={label}
        // Raised above the card surface: cards draw `bg-card` at half-
        // strength borders, the menu draws the popover surface at full-
        // strength under the elevated shadow, and its header rule bounds
        // the menu as a menu rather than one more card.
        className="fixed z-50 min-w-44 rounded-md border border-border bg-popover p-1 shadow-lg"
        style={{
          left: open.x,
          top: open.y,
          // Whatever height the window leaves (minus its edges), not a
          // fixed pixel cap: a tall window shows a long menu whole, a
          // short one scrolls (the ref clamp below keeps it on screen).
          maxHeight: window.innerHeight - 16,
          overflowY: "auto",
        }}
        ref={(node) => {
          menuRef.current = node;
          if (node === null) return;
          const rect = node.getBoundingClientRect();
          const clampedX = Math.min(open.x, window.innerWidth - rect.width - 8);
          const clampedY = Math.min(open.y, window.innerHeight - rect.height - 8);
          if (clampedX !== node.offsetLeft) node.style.left = `${Math.max(8, clampedX)}px`;
          if (clampedY !== node.offsetTop) node.style.top = `${Math.max(8, clampedY)}px`;
        }}
      >
        <div
          aria-hidden
          className="max-w-64 truncate border-b border-border px-2 pb-1.5 pt-1.5 text-[11px] font-medium text-muted-foreground"
        >
          {title}
        </div>
        {children}
      </div>
    </>
  );
}

/**
 * One entry row, matching the menu grammar everywhere in the app: icon,
 * label, and the shared styling (danger tone, divider above). Callers own
 * what clicking it does — this button just closes nothing; the caller
 * closes via its own onClose in the row's onClick.
 */
export function MenuPopoverEntry({
  label,
  icon,
  onRun,
  danger,
  dividerAbove,
}: {
  label: string;
  icon: string;
  onRun: () => void;
  /** Destructive or state-arming entries draw in the danger tone. */
  danger?: boolean;
  dividerAbove?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onRun}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent",
        dividerAbove && "mt-1 border-t border-border pt-2",
        danger && "text-destructive",
      )}
    >
      <Icon name={icon} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      {label}
    </button>
  );
}