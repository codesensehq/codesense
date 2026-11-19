// SPDX-License-Identifier: MIT
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NotesChrome } from "./notes-chrome";
import { useShortcutsStore } from "@/shared/stores/shortcuts-store";
import { restorePlatform, setPlatform } from "@/test/platform";

function renderChrome() {
  return render(
    <NotesChrome
      wide={false}
      listOpen={false}
      outline={null}
      onToggleList={() => {}}
      onFind={() => {}}
      agentMenu={null}
      noteMenu={null}
    />,
  );
}

/** The chord the "Find a note" button shows, or null when it shows none. */
const findChord = () =>
  screen.getByRole("button", { name: "Find a note" }).querySelector("kbd")?.textContent ?? null;

beforeEach(() => useShortcutsStore.setState({ shortcuts: {} }));
afterEach(() => {
  cleanup();
  restorePlatform();
});

describe("the notes chrome's note-switcher hint", () => {
  it("shows the effective binding per platform", () => {
    setPlatform("MacIntel");
    renderChrome();
    expect(findChord()).toBe("⌘O");
    cleanup();
    setPlatform("Win32");
    renderChrome();
    expect(findChord()).toBe("Ctrl+O");
  });

  it("follows a rebind live, and hides when unbound", () => {
    setPlatform("Win32");
    renderChrome();
    act(() =>
      useShortcutsStore.setState({ shortcuts: { "nav.open-note-switcher": "CmdOrCtrl+Shift+K" } }),
    );
    expect(findChord()).toBe("Ctrl+Shift+K");
    act(() => useShortcutsStore.setState({ shortcuts: { "nav.open-note-switcher": "" } }));
    expect(findChord()).toBeNull();
  });
});
