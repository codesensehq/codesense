// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

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

const OFF = { "pdf-export": "printing isn't built here" } as const;
const SENTENCE = "Not yet available on Windows: printing isn't built here.";

describe("Settings → Shortcuts with PDF export off", () => {
  it("shows the row with the off sentence in place of the chord, and Edit does nothing", () => {
    setPlatformCaps(OFF);
    render(<ShortcutsSection query="" />);
    const row = screen.getByTestId(EXPORT_ROW);
    const note = within(row).getByRole("note");
    expect(note).toHaveTextContent(SENTENCE);
    expect(within(row).queryByTestId(`${EXPORT_ROW}-current`)).toBeNull();
    const edit = within(row).getByTestId(`${EXPORT_ROW}-edit`);
    expect(edit).toHaveAttribute("aria-disabled", "true");
    expect(edit).toHaveAttribute("title", SENTENCE);
    expect(edit).toHaveAttribute("aria-describedby", note.id);
    fireEvent.click(edit);
    expect(within(row).queryByTestId(`${EXPORT_ROW}-capture`)).toBeNull();
  });

  it("shows the chord again when the capability is on, and before the capabilities load", () => {
    render(<ShortcutsSection query="" />);
    expect(screen.getByTestId(`${EXPORT_ROW}-current`)).toHaveTextContent("Ctrl+Shift+E");
    act(() => setPlatformCaps(OFF));
    expect(screen.queryByTestId(`${EXPORT_ROW}-current`)).toBeNull();
    act(() => setPlatformCaps());
    expect(screen.getByTestId(`${EXPORT_ROW}-current`)).toBeInTheDocument();
    expect(within(screen.getByTestId(EXPORT_ROW)).queryByRole("note")).toBeNull();
  });

  it("keeps a dashboard command's row though its available() is false", () => {
    setPlatformCaps(OFF);
    render(<ShortcutsSection query="" />);
    expect(screen.getByTestId(`shortcut-row-${ARCHIVE}`)).toBeInTheDocument();
  });

  it("frees the export chord: the dashboard command takes it with no conflict", () => {
    setPlatformCaps(OFF);
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

  it("still finds the Export to PDF row", () => {
    setPlatformCaps(OFF);
    render(sidebar("export to pdf"));
    expect(screen.getByTestId("settings-nav-shortcuts")).not.toHaveAttribute("aria-disabled");
  });

  it("still matches a dashboard command whose available() is false", () => {
    setPlatformCaps(OFF);
    render(sidebar("archive thread"));
    expect(screen.getByTestId("settings-nav-shortcuts")).not.toHaveAttribute("aria-disabled");
  });
});
