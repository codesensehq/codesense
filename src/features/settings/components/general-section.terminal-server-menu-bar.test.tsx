// SPDX-License-Identifier: MIT
/**
 * The "Show terminal server in the menu bar" row ("in the tray" off macOS) — off
 * by default, an On | Off radio writing `updateSettings({ terminalServerMenuBar })`,
 * explained and disabled where the tray capability is off. Also the Quit on window close
 * footer, which says how a closed window comes back on this OS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

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

describe("GeneralSection — terminal server in the menu bar", () => {
  beforeEach(() => {
    setPlatformCaps();
    useViewerStore.setState({
      settings: { ...useViewerStore.getState().settings, terminalServerMenuBar: undefined },
    });
  });
  afterEach(() => {
    resetPlatformCaps();
    restorePlatform();
  });

  it("is off by default and writes the setting on toggle", () => {
    render(<GeneralSection query="menu bar" />);
    expect(screen.getByTestId("settings-terminal-server-menu-bar-off")).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.click(screen.getByTestId("settings-terminal-server-menu-bar-on"));
    expect(useViewerStore.getState().settings.terminalServerMenuBar).toBe(true);

    fireEvent.click(screen.getByTestId("settings-terminal-server-menu-bar-off"));
    expect(useViewerStore.getState().settings.terminalServerMenuBar).toBe(false);
  });

  it("is still found, but explained and disabled, where the tray capability is off", () => {
    setPlatform("Win32");
    setPlatformCaps({ "terminal-server-tray": "no tray" });
    render(<GeneralSection query="menu bar" />);
    const row = screen.getByTestId("settings-terminal-server-menu-bar");
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveAttribute("title", "Not yet available on Windows: no tray.");
    fireEvent.click(screen.getByTestId("settings-terminal-server-menu-bar-on"));
    expect(useViewerStore.getState().settings.terminalServerMenuBar).toBeUndefined();
  });

  it.each([
    ["MacIntel", "Show terminal server in the menu bar", /dock icon reopens it/],
    [
      "Linux x86_64",
      "Show terminal server in the tray",
      /while the terminal server's tray icon shows .*with no tray icon, closing the window quits/,
    ],
  ])("on %s is labelled %s, and the Quit on close footer matches", (platform, label, footer) => {
    setPlatform(platform);
    render(<GeneralSection query="" />);
    const row = screen.getByTestId("settings-terminal-server-menu-bar");
    expect(row).toHaveAttribute("aria-label", label);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(footer)).toBeInTheDocument();
  });

  it("is found by searching for the tray on Linux", () => {
    setPlatform("Linux x86_64");
    render(<GeneralSection query="tray" />);
    expect(screen.getByTestId("settings-terminal-server-menu-bar")).toBeInTheDocument();
  });
});
