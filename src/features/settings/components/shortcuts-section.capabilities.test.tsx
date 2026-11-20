// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";

import { resetPlatformCaps, setPlatformCaps } from "@/shared/lib/__test-utils__/platform-caps";
import { setDynamicShortcutActions, type ShortcutAction } from "@/shared/lib/shortcuts/registry";
import { useShortcutsStore } from "@/shared/stores/shortcuts-store";

import { SettingsSidebar } from "./settings-sidebar";
import { ShortcutsSection } from "./shortcuts-section";

vi.mock("@/tauri/commands", () => ({
  loadAppState: () => Promise.resolve("{}"),
  saveAppState: () => Promise.resolve(),
  rebuildMenu: () => Promise.resolve(),
}));
vi.mock("@/shared/lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/components/ui/tooltip", () => ({
  InfoTip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const EXPORT_ROW = "shortcut-row-viewer.export-pdf";
const INBOX = "dashboard:team:acme:dev/inbox";
const ARCHIVE = `${INBOX}/archive`;
/** Export to PDF's default chord. */
const EXPORT_CHORD = "CmdOrCtrl+Shift+E";

/** A dashboard command that is never `available()`: its dashboard isn't focused while Settings
 *  is open. It wants the export chord, so it also shows whether that chord is held. */
const archive: ShortcutAction = {
  id: ARCHIVE,
  label: "Archive thread",
  defaultKeystroke: EXPORT_CHORD,
  scope: "global",
  command: {
    dashboard: INBOX,
    dashboardTitle: "Inbox",
    dashboardScope: "team",
    humanOnly: false,
    active: true,
  },
  available: () => false,
  run: () => {},
};

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  useShortcutsStore.setState({ shortcuts: {}, stateLoaded: true });
  setDynamicShortcutActions([archive]);
});
afterEach(() => {
  setDynamicShortcutActions([]);
  resetPlatformCaps();
  vi.restoreAllMocks();
});

describe("Settings → Shortcuts with PDF export off", () => {
  it("has no Export to PDF row, and the row comes back when the capability is on", () => {
    setPlatformCaps({ "pdf-export": "printing isn't built here" });
    render(<ShortcutsSection query="" />);
    expect(screen.queryByTestId(EXPORT_ROW)).toBeNull();
    act(() => setPlatformCaps());
    expect(screen.getByTestId(EXPORT_ROW)).toBeInTheDocument();
  });

  it("shows the row before the capabilities load (fail open)", () => {
    render(<ShortcutsSection query="" />);
    expect(screen.getByTestId(EXPORT_ROW)).toBeInTheDocument();
  });

  it("keeps a dashboard command's row though its available() is false", () => {
    setPlatformCaps({ "pdf-export": "printing isn't built here" });
    render(<ShortcutsSection query="" />);
    expect(screen.getByTestId(`shortcut-row-${ARCHIVE}`)).toBeInTheDocument();
  });

  it("frees the export chord: the dashboard command takes it with no conflict", () => {
    setPlatformCaps({ "pdf-export": "printing isn't built here" });
    render(<ShortcutsSection query="" />);
    expect(screen.queryByTestId("shortcuts-conflicts")).toBeNull();
    expect(screen.getByTestId(`shortcut-row-${ARCHIVE}-current`)).toHaveTextContent("Ctrl+Shift+E");
  });

  it("with the capability on, the export action holds the chord and the command is a conflict", () => {
    setPlatformCaps();
    render(<ShortcutsSection query="" />);
    const conflicts = screen.getByTestId("shortcuts-conflicts");
    expect(within(conflicts).getByText(/used by Export to PDF/)).toBeInTheDocument();
  });
});

describe("the Settings sidebar index with PDF export off", () => {
  const sidebar = (query: string) => (
    <SettingsSidebar
      activeSection="general"
      onSectionChange={() => {}}
      query={query}
      collapsed={false}
    />
  );

  it("doesn't match Shortcuts on the hidden row, and does once the capability is on", () => {
    setPlatformCaps({ "pdf-export": "printing isn't built here" });
    render(sidebar("export to pdf"));
    expect(screen.getByTestId("settings-nav-shortcuts")).toHaveAttribute("aria-disabled", "true");
    act(() => setPlatformCaps());
    expect(screen.getByTestId("settings-nav-shortcuts")).not.toHaveAttribute("aria-disabled");
  });

  it("still matches a dashboard command whose available() is false", () => {
    setPlatformCaps({ "pdf-export": "printing isn't built here" });
    render(sidebar("archive thread"));
    expect(screen.getByTestId("settings-nav-shortcuts")).not.toHaveAttribute("aria-disabled");
  });
});
