// SPDX-License-Identifier: MIT
/**
 * The two General rows whose feature exists only on some platforms ("Quit on window close" and
 * "Show terminal server in the menu bar") follow their capabilities: shown when on, hidden when
 * off, and left out of the search count.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

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

const QUIT = "settings-quit-on-close";
const MENU_BAR = "settings-terminal-server-menu-bar";

describe("GeneralSection — rows gated on platform capabilities", () => {
  afterEach(() => resetPlatformCaps());

  it.each([
    { off: {}, quit: true, menuBar: true },
    {
      off: { "background-on-close": "r", "terminal-server-tray": "r" },
      quit: false,
      menuBar: false,
    },
    { off: { "background-on-close": "r" }, quit: false, menuBar: true },
    { off: { "terminal-server-tray": "r" }, quit: true, menuBar: false },
  ])("off $off → quit row $quit, menu-bar row $menuBar", ({ off, quit, menuBar }) => {
    setPlatformCaps(off);
    render(<GeneralSection query="" />);
    expect(screen.queryByTestId(QUIT) !== null).toBe(quit);
    expect(screen.queryByTestId(MENU_BAR) !== null).toBe(menuBar);
  });

  it("a search that matches only off rows shows the empty state and counts none", () => {
    setPlatformCaps({ "background-on-close": "r", "terminal-server-tray": "r" });
    render(<GeneralSection query="quit" />);
    expect(screen.getByTestId("settings-general-empty")).toBeInTheDocument();
    expect(screen.getByTestId("settings-search-count")).toHaveTextContent("0 settings shown");
  });

  it("the same search with the caps on shows the row and counts it", () => {
    setPlatformCaps();
    render(<GeneralSection query="quit" />);
    expect(screen.getByTestId(QUIT)).toBeInTheDocument();
    expect(screen.queryByTestId("settings-general-empty")).toBeNull();
    expect(screen.getByTestId("settings-search-count")).toHaveTextContent("1 settings shown");
  });
});
