// SPDX-License-Identifier: MIT
/**
 * Shortcut labels per platform, on the surfaces that show them. Off macOS a
 * surface shows no macOS glyph and names `Ctrl+…` for each chord a registry,
 * Mod or Control handler serves; a key only Cmd serves shows no hint. On macOS
 * each surface matches a committed snapshot of the formatter's output. The
 * attention pill is covered by `attention-alerts-controller.test.tsx`.
 */
import { act, cleanup, fireEvent, render, screen } from "@/test-utils";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Composer } from "@/features/inbox/components/composer";
import { InboxViewProvider, type InboxView } from "@/features/inbox/components/inbox-view-context";
import { HUMAN, buildDirectory } from "@/features/inbox/model";
import { NotesChrome } from "@/features/notes/components/notes-chrome";
import { NotesList } from "@/features/notes/components/notes-list";
import { NotesEmpty } from "@/features/notes/components/notes-empty";
import { SendPicker } from "@/features/notes/components/send-picker";
import { ShortcutRow } from "@/features/settings/components/shortcut-row";
import { ShortcutsSection } from "@/features/settings/components/shortcuts-section";
import { EmptyWorkbench } from "@/features/viewer/components/source-editor-inset";
import { EditorStatusBar } from "@/features/viewer/components/worktree-editor/editor-status-bar";
import type { PaneStatus } from "@/features/viewer/components/worktree-editor/worktree-file-pane";
import { SHORTCUT_ACTIONS } from "@/shared/lib/shortcuts/registry";
import { useShortcutsStore } from "@/shared/stores/shortcuts-store";
import { restorePlatform, setPlatform } from "@/test/platform";

vi.mock("@/tauri/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/tauri/commands")>()),
  loadAppState: () => Promise.resolve("{}"),
  saveAppState: () => Promise.resolve(),
  rebuildMenu: () => Promise.resolve(),
}));
vi.mock("@/features/notes/lib/note-agents", () => ({
  useNoteAgents: () => ({ agents: [], statusOf: () => "running", subagentsOf: () => 0 }),
  agentStatusLook: () => ({ word: "running", mark: "thinking" }),
}));

const noop = () => {};

function inboxView(): InboxView {
  return {
    me: HUMAN,
    targets: [],
    dir: buildDirectory([], []),
    messages: [],
    roles: [],
    held: [],
    fallbackTeam: null,
    source: "live",
    replyTo: noop,
    goTo: noop,
  };
}

const editable = {
  kind: "editable",
  dirty: true,
  saving: false,
  saveError: null,
  stale: false,
  reconciling: false,
  language: "markdown",
  lineEnding: "lf",
  indentation: { kind: "spaces", size: 2 },
  cursor: { line: 1, column: 1, selected: 0 },
  changes: null,
  baselineKnown: false,
  lineWrap: false,
} as unknown as PaneStatus;

/** Each surface that shows a shortcut label, as it renders in the app. */
const SURFACES: Record<string, () => ReactElement> = {
  "inbox composer": () => (
    <InboxViewProvider value={inboxView()}>
      <Composer defaultTo={null} />
    </InboxViewProvider>
  ),
  "inbox chat composer": () => (
    <InboxViewProvider value={inboxView()}>
      <Composer defaultTo={null} quick />
    </InboxViewProvider>
  ),
  "notes empty state": () => <NotesEmpty orgName="acme" onNew={noop} onRoutine={noop} />,
  "source editor help": () => <EmptyWorkbench onQuickOpen={noop} />,
  "editor status bar": () => (
    <EditorStatusBar
      location="local"
      machineLabel={null}
      branch={null}
      status={editable}
      wrap={false}
      onToggleWrap={noop}
      onGoToLine={noop}
    />
  ),
  "notes chrome": () => (
    <NotesChrome
      wide={false}
      listOpen={false}
      outline={null}
      onToggleList={noop}
      onFind={noop}
      agentMenu={null}
      noteMenu={null}
    />
  ),
  "send picker": () => (
    <SendPicker
      open
      anchor={{ top: 0, left: 0, width: 1, height: 1 }}
      placeLabel="Team"
      includeContext={false}
      onIncludeContextChange={noop}
      onSendToAgent={noop}
      onStartNew={noop}
      onPasteTerminal={noop}
      onClose={noop}
    />
  ),
  "settings shortcuts": () => <ShortcutsSection query="" />,
};

/** What a surface shows: its text, then every title and aria-label. */
function labels(ui: ReactElement): string {
  render(ui);
  const attrs = Array.from(document.body.querySelectorAll("[title], [aria-label]")).flatMap((el) =>
    [el.getAttribute("title"), el.getAttribute("aria-label")].filter(Boolean),
  );
  const text = [document.body.textContent ?? "", ...attrs].join("\n");
  cleanup();
  return text;
}

const GLYPH = /[⌘⌥⇧⌃↵↩]/;

/** The chords each surface names off macOS (registry, Mod, Control and plain). */
const OFF_MAC: Record<string, string[]> = {
  "inbox composer": ["Send Ctrl+⏎"],
  "inbox chat composer": ["⏎ send", "Shift+⏎ new line", "Send (⏎)"],
  "notes empty state": ["New noteCtrl+N", "Ctrl+⏎sends the line"],
  "source editor help": ["Ctrl+P", "Go to lineCtrl+G", "Ctrl+FCtrl+Alt+F", "Next tabCtrl+⇥"],
  "editor status bar": [
    "Unsaved changes — Ctrl+S to save",
    "Go to line (Ctrl+G)",
    "Word wrap off (Alt+Z)",
  ],
  "notes chrome": ["Find a noteCtrl+O", "Notes list (Ctrl+B)"],
  "send picker": ["Paste into focused terminal"],
  "settings shortcuts": ["Ctrl+O", "Ctrl+Shift+O"],
};

beforeEach(() => useShortcutsStore.setState({ shortcuts: {}, stateLoaded: true }));
afterEach(() => {
  cleanup();
  restorePlatform();
});

describe.each(["Win32", "Linux x86_64"])("shortcut labels on %s", (platform) => {
  it.each(Object.keys(SURFACES))("%s shows Ctrl chords and no macOS glyph", (surface) => {
    setPlatform(platform);
    const shown = labels(SURFACES[surface]());
    expect(shown).not.toMatch(GLYPH);
    for (const chord of OFF_MAC[surface]) expect(shown).toContain(chord);
  });

  it("the send picker shows no hint for its Cmd-only paste key", () => {
    setPlatform(platform);
    render(SURFACES["send picker"]());
    const paste = document.body.querySelector(".nt-row-sub");
    expect(paste).toBeNull();
  });
});

describe("shortcut labels on macOS", () => {
  it.each(Object.keys(SURFACES).filter((s) => s !== "settings shortcuts"))(
    "%s matches the formatter's macOS output",
    (surface) => {
      setPlatform("MacIntel");
      expect(labels(SURFACES[surface]())).toMatchSnapshot();
    },
  );

  it("settings shortcuts names the note switcher and heading jump as macOS chords", () => {
    setPlatform("MacIntel");
    render(SURFACES["settings shortcuts"]());
    const current = (id: string) =>
      document.body.querySelector(`[data-testid="shortcut-row-${id}-current"]`)?.textContent;
    expect([current("nav.open-note-switcher"), current("nav.goto-heading")]).toMatchSnapshot();
  });
});

describe.each([
  ["MacIntel", "⌘O", "⌃⌘⇧", "⌃⌘⌥→"],
  ["Win32", "Ctrl+O", "Ctrl+Shift+", "Ctrl+Meta+Alt+→"],
])("logic-bearing hints on %s", (platform, switcher, captured, ctrlChord) => {
  beforeEach(() => setPlatform(platform));

  it("the wide notes list's search names the note switcher", () => {
    render(
      <NotesList
        notes={[]}
        activeNoteId={null}
        summaries={new Map()}
        now={0}
        variant="column"
        onSelect={noop}
        onCreate={noop}
        onRename={noop}
        onRequestDelete={noop}
        onTogglePin={noop}
      />,
    );
    expect(document.body.querySelector(".nt-list-search")).toHaveTextContent(switcher);
  });

  it("the Settings capture preview names the held modifiers", () => {
    const action = SHORTCUT_ACTIONS.find((a) => a.id === "settings.open");
    if (!action) throw new Error("no settings.open action");
    render(<ShortcutRow action={action} />);
    fireEvent.click(screen.getByTestId("shortcut-row-settings.open-edit"));
    act(() => {
      fireEvent.keyDown(screen.getByTestId("shortcut-row-settings.open-capture"), {
        key: "Control",
        ctrlKey: true,
        metaKey: platform === "MacIntel",
        shiftKey: true,
      });
    });
    expect(screen.getByTestId("shortcut-row-settings.open-capture")).toHaveTextContent(captured);
  });

  it("Settings → Shortcuts shows a saved ⌃ chord with its ⌃", () => {
    useShortcutsStore.setState({
      shortcuts: { "settings.open": "Ctrl+CmdOrCtrl+Alt+ArrowRight" },
      stateLoaded: true,
    });
    render(<ShortcutsSection query="" />);
    expect(
      document.body.querySelector('[data-testid="shortcut-row-settings.open-current"]'),
    ).toHaveTextContent(ctrlChord);
  });
});
