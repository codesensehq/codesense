// SPDX-License-Identifier: MIT
/**
 * The "Show terminal server in the menu bar" row — off by default, an
 * On | Off radio writing `updateSettings({ terminalServerMenuBar })`, shown
 * only where the tray capability is on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { useViewerStore } from "@/shared/stores/viewer-store";
import { resetPlatformCaps, setPlatformCaps } from "@/shared/lib/__test-utils__/platform-caps";

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
  afterEach(() => resetPlatformCaps());

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

  it("is not offered where the tray capability is off", () => {
    setPlatformCaps({ "terminal-server-tray": "no tray" });
    render(<GeneralSection query="menu bar" />);
    expect(screen.queryByTestId("settings-terminal-server-menu-bar")).not.toBeInTheDocument();
  });
});
