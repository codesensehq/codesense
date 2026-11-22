// SPDX-License-Identifier: MIT
/**
 * The two General rows whose feature exists only on some platforms ("Quit on window close" and
 * "Show terminal server in the menu bar") follow their capabilities: working when on; when off,
 * still shown and found by search, but disabled, showing what actually happens, with the off
 * sentence in place of the footer and never writing the setting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { useViewerStore } from "@/shared/stores/viewer-store";
import { resetPlatformCaps, setPlatformCaps } from "@/shared/lib/__test-utils__/platform-caps";
import { restorePlatform, setPlatform } from "@/test/platform";

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));
vi.mock("@/tauri/commands", () => ({
  detectTools: vi.fn().mockResolvedValue({ editors: [], terminals: [] }),
  checkForUpdate: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("0.0.0-test"),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/app/update-toast", () => ({ runUpdateCheck: vi.fn() }));

import { GeneralSection } from "./general-section";

const QUIT = "settings-quit-on-close";
const MENU_BAR = "settings-terminal-server-menu-bar";

/** The shipped reasons, so the sentence is the one people read. */
const REASONS = Object.fromEntries(
  (
    JSON.parse(
      readFileSync(resolve(__dirname, "../../../../src-tauri/platform-caps.json"), "utf8"),
    ) as { key: string; reason: string }[]
  ).map((c) => [c.key, c.reason]),
);
const QUIT_REASON = REASONS["background-on-close"] as string;
const TRAY_REASON = REASONS["terminal-server-tray"] as string;

function settings() {
  return useViewerStore.getState().settings;
}

/** The group is disabled and described by its one note, which carries `sentence`. */
function expectExplained(testId: string, sentence: string) {
  const group = screen.getByTestId(testId);
  expect(group).toHaveAttribute("aria-disabled", "true");
  expect(group).toHaveAttribute("title", sentence);
  const noteId = group.getAttribute("aria-describedby");
  expect(noteId).toBeTruthy();
  const note = document.getElementById(noteId!);
  expect(note).toHaveAttribute("role", "note");
  expect(note).toHaveTextContent(sentence);
  return { group, note: note! };
}

function checked(testId: string) {
  return screen
    .getByTestId(testId)
    .querySelector('[aria-checked="true"]')
    ?.getAttribute("data-testid");
}

describe("GeneralSection — rows gated on platform capabilities", () => {
  beforeEach(() => {
    useViewerStore.setState({
      settings: { ...settings(), quitOnClose: false, terminalServerMenuBar: true },
    });
  });
  afterEach(() => {
    resetPlatformCaps();
    restorePlatform();
  });

  it("with both capabilities on, both rows work and keep their footers", () => {
    setPlatformCaps();
    render(<GeneralSection query="" />);
    for (const id of [QUIT, MENU_BAR]) {
      expect(screen.getByTestId(id)).not.toHaveAttribute("aria-disabled");
      expect(screen.getByTestId(id)).not.toHaveAttribute("aria-describedby");
    }
    expect(document.querySelector("[data-capability-off]")).toBeNull();
    fireEvent.click(screen.getByTestId(`${QUIT}-on`));
    expect(settings().quitOnClose).toBe(true);
    fireEvent.click(screen.getByTestId(`${MENU_BAR}-off`));
    expect(settings().terminalServerMenuBar).toBe(false);
  });

  it("on Windows with both off, both rows are explained and show what actually happens", () => {
    setPlatform("Win32");
    setPlatformCaps({ "background-on-close": QUIT_REASON, "terminal-server-tray": TRAY_REASON });
    render(<GeneralSection query="" />);
    const quit = expectExplained(QUIT, `Not yet available on Windows: ${QUIT_REASON}.`);
    const tray = expectExplained(MENU_BAR, `Not yet available on Windows: ${TRAY_REASON}.`);
    // The stored values say the opposite: what shows is what happens on this OS.
    expect(checked(QUIT)).toBe(`${QUIT}-on`);
    expect(checked(MENU_BAR)).toBe(`${MENU_BAR}-off`);
    // The note replaces the footers: it is the only thing after each group.
    for (const { group, note } of [quit, tray]) {
      expect(group.nextElementSibling).toBe(note);
      expect(note.nextElementSibling).toBeNull();
    }
    expect(screen.queryByText(/Shows whether the terminal server is running/)).toBeNull();
    expect(document.querySelectorAll("[data-capability-off]")).toHaveLength(2);
  });

  it("on Linux without a tray, only the tray row is explained", () => {
    setPlatform("Linux x86_64");
    setPlatformCaps({ "terminal-server-tray": TRAY_REASON });
    render(<GeneralSection query="" />);
    expectExplained(MENU_BAR, `Not yet available on Linux: ${TRAY_REASON}.`);
    expect(screen.getByTestId(QUIT)).not.toHaveAttribute("aria-disabled");
    expect(screen.getByText(/with no tray icon, closing the window quits/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`${QUIT}-on`));
    expect(settings().quitOnClose).toBe(true);
  });

  it.each([
    [QUIT, "background-on-close", "quitOnClose", false, "on"],
    [MENU_BAR, "terminal-server-tray", "terminalServerMenuBar", true, "off"],
  ] as const)(
    "%s while off: focusable, but clicks and keys never write the setting",
    (testId, cap, key, stored, shown) => {
      setPlatformCaps({ [cap]: "r" });
      render(<GeneralSection query="" />);
      const group = screen.getByTestId(testId);
      const selected = screen.getByTestId(`${testId}-${shown}`);
      expect(selected).toHaveAttribute("tabIndex", "0");
      selected.focus();
      expect(selected).toHaveFocus();
      for (const option of ["on", "off"]) {
        fireEvent.click(screen.getByTestId(`${testId}-${option}`));
        expect(settings()[key]).toBe(stored);
      }
      for (const k of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
        fireEvent.keyDown(group, { key: k });
        expect(settings()[key]).toBe(stored);
      }
      expect(checked(testId)).toBe(`${testId}-${shown}`);
      expect(selected).toHaveFocus();
    },
  );

  it("only the radios dim: the note has no dimmed ancestor, and a focused radio gets a ring", () => {
    setPlatform("Win32");
    setPlatformCaps({ "background-on-close": "r", "terminal-server-tray": "r" });
    render(<GeneralSection query="" />);
    for (const testId of [QUIT, MENU_BAR]) {
      const { group, note } = expectExplained(testId, "Not yet available on Windows: r.");
      for (let el: HTMLElement | null = note; el; el = el.parentElement) {
        expect(el.className).not.toMatch(/(^|\s)opacity-/);
      }
      for (const radio of group.querySelectorAll<HTMLElement>('[role="radio"]')) {
        expect(radio.className).toMatch(/(^|\s)opacity-50(\s|$)/);
        expect(radio.className).toMatch(/focus-visible:opacity-100/);
        expect(radio.className).toMatch(/focus-visible:ring-2/);
      }
    }
  });

  it("a search that matches only off rows still shows them and counts them", () => {
    setPlatformCaps({ "background-on-close": "r", "terminal-server-tray": "r" });
    render(<GeneralSection query="quit" />);
    expect(screen.queryByTestId("settings-general-empty")).toBeNull();
    expect(screen.getByTestId(QUIT)).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("settings-search-count")).toHaveTextContent("1 settings shown");
  });

  it("the same search with the caps on shows the row and counts it", () => {
    setPlatformCaps();
    render(<GeneralSection query="quit" />);
    expect(screen.getByTestId(QUIT)).toBeInTheDocument();
    expect(screen.queryByTestId("settings-general-empty")).toBeNull();
    expect(screen.getByTestId("settings-search-count")).toHaveTextContent("1 settings shown");
  });
});
