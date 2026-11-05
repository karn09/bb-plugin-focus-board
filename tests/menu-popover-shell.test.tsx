// @vitest-environment jsdom
// The shared right-click menu shell (components/menu-popover): the shell
// must use whatever height the window leaves it — a fixed pixel cap cuts a
// long menu to a partial-height popover even on a tall window — and it must
// read as a raised menu, not as one more card on the board.
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MenuPopover } from "../components/menu-popover";

afterEach(cleanup);

function renderOpenMenu(entries = 3) {
  render(
    <MenuPopover open={{ x: 20, y: 20 }} onClose={() => {}} label="Thread actions" title="One thread">
      {Array.from({ length: entries }, (_, i) => (
        <button key={i} type="button" role="menuitem" onClick={() => {}}>
          Entry {i + 1}
        </button>
      ))}
    </MenuPopover>,
  );
  return screen.getByRole("menu");
}

function setViewport(height: number) {
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
}

describe("menu shell height", () => {
  it("allows the full window height (minus margins) when the window is tall", () => {
    setViewport(800);
    const menu = renderOpenMenu(40);
    expect(menu.style.maxHeight).toBe(`${800 - 16}px`);
  });

  it("still keeps a small margin on a short window", () => {
    setViewport(300);
    const menu = renderOpenMenu(40);
    expect(menu.style.maxHeight).toBe(`${300 - 16}px`);
  });
});

describe("menu shell stands apart from cards", () => {
  it("raises the shell above the card surface: the elevated shadow over the full-strength border cards use only at half", () => {
    setViewport(800);
    const menu = renderOpenMenu();
    expect(menu.className).toContain("shadow-lg");
    expect(menu.className).toContain("border-border");
    expect(menu.className).not.toContain("border-border/50");
  });

  it("separates the header line with its own rule so the shell reads as a menu, not a compact card", () => {
    setViewport(800);
    renderOpenMenu();
    const header = screen.getByText("One thread");
    expect(header.className).toContain("border-b");
  });
});
describe("menu shell keyboard", () => {
  it("moves focus to the first entry on open; Escape closes and refocuses what had focus", () => {
    function Harness() {
      const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
      return (
        <>
          <button type="button" onClick={() => setOpen({ x: 5, y: 5 })}>Opener</button>
          <MenuPopover open={open} onClose={() => setOpen(null)} label="Thread actions" title="One">
            <button type="button" role="menuitem">First</button>
            <button type="button" role="menuitem">Second</button>
          </MenuPopover>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByText("Opener");
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "First" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
