// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

import { SHORTCUT_ACTIONS } from "@/shared/lib/shortcuts/registry";
import { useShortcutsStore } from "@/shared/stores/shortcuts-store";
import { useUiStore } from "@/shared/stores/ui-store";
import { useViewerStore, type Workspace } from "@/shared/stores/viewer-store";
import { useOrgStore } from "@/shared/stores/org-store";
import { buildTeamKey } from "@/shared/lib/team-key";
import { matchShortcut, useShortcutHandler } from "./use-shortcut-handler";
import { restorePlatform, setPlatform } from "@/test/platform";

const TEAM_KEY = buildTeamKey("acme", "core");

function Harness({ inTerminal }: { inTerminal: boolean }) {
  useShortcutHandler();
  return inTerminal ? (
    <div className="xterm">
      <textarea data-testid="field" />
    </div>
  ) : (
    <textarea data-testid="field" />
  );
}

/** Every action's `run` replaced by a spy, so a key that reaches any action is seen. */
function spyOnAllActions(): { runs: Map<string, ReturnType<typeof vi.fn>>; restore: () => void } {
  const runs = new Map<string, ReturnType<typeof vi.fn>>();
  const originals = SHORTCUT_ACTIONS.map((action) => {
    const spy = vi.fn();
    runs.set(action.id, spy);
    const original = action.run;
    (action as { run: () => void }).run = spy;
    return () => {
      (action as { run: () => void }).run = original;
    };
  });
  return { runs, restore: () => originals.forEach((undo) => undo()) };
}

function fired(runs: Map<string, ReturnType<typeof vi.fn>>): string[] {
  return [...runs].filter(([, spy]) => spy.mock.calls.length > 0).map(([id]) => id);
}

/**
 * A keydown whose AltGraph state is given, as a browser reports it: happy-dom reports the Alt
 * key's state for AltGraph, which would make every Ctrl+Alt chord look like AltGr.
 */
function keydown(init: KeyboardEventInit & { key: string }, altGraph = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "getModifierState", {
    value: (name: string) => name === "AltGraph" && altGraph,
  });
  return event;
}

function press(init: KeyboardEventInit & { key: string }, altGraph = false): KeyboardEvent {
  const event = keydown(init, altGraph);
  const field = document.querySelector<HTMLElement>('[data-testid="field"]')!;
  act(() => {
    field.dispatchEvent(event);
  });
  return event;
}

let rig: ReturnType<typeof spyOnAllActions>;

beforeEach(() => {
  useShortcutsStore.setState({ shortcuts: {}, stateLoaded: true });
  useUiStore.setState({ settingsPanelOpen: false });
  useOrgStore.setState({ activeOrgSlug: "acme", activeTeamName: "core" });
  const tile: Workspace = { id: "s-1", kind: "story", cwd: "/s-1", status: "ready" };
  useViewerStore.setState({
    workspaces: { [TEAM_KEY]: [tile] },
    activeWorkspace: { [TEAM_KEY]: tile.id },
  });
  rig = spyOnAllActions();
});

afterEach(() => {
  rig.restore();
  restorePlatform();
});

function focusField(): void {
  document.querySelector<HTMLElement>('[data-testid="field"]')!.focus();
}

describe("off macOS with a terminal focused", () => {
  beforeEach(() => setPlatform("Win32"));

  it.each(["c", "d", "z", "r", "l", "w", "k", "a", "e", "u", "t", "f", "p", "o", "b", "j", "i"])(
    "Ctrl+%s goes to the PTY: no action, not prevented",
    (key) => {
      render(<Harness inTerminal />);
      focusField();
      const event = press({ key, code: `Key${key.toUpperCase()}`, ctrlKey: true });
      expect(fired(rig.runs)).toEqual([]);
      expect(event.defaultPrevented).toBe(false);
    },
  );

  it.each([
    ["[", "BracketLeft"],
    ["]", "BracketRight"],
    ["\\", "Backslash"],
    [" ", "Space"],
  ])("Ctrl+%j goes to the PTY", (key, code) => {
    render(<Harness inTerminal />);
    focusField();
    const event = press({ key, code, ctrlKey: true });
    expect(fired(rig.runs)).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it("Ctrl+Shift+T opens a terminal tab", () => {
    render(<Harness inTerminal />);
    focusField();
    const event = press({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true });
    expect(fired(rig.runs)).toEqual(["viewer.new-terminal-tab"]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("Ctrl+Shift+K opens Open Workspace, and the displaced Clear Terminal has no key", () => {
    render(<Harness inTerminal />);
    focusField();
    press({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true });
    expect(fired(rig.runs)).toEqual(["nav.open-workspace"]);
  });

  it("Ctrl+Shift+C and Ctrl+Shift+V reach no action", () => {
    render(<Harness inTerminal />);
    focusField();
    press({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });
    press({ key: "V", code: "KeyV", ctrlKey: true, shiftKey: true });
    expect(fired(rig.runs)).toEqual([]);
  });

  it("a Ctrl+Alt chord that is not a shell key still works: Ctrl+Alt+] cycles the workspace", () => {
    render(<Harness inTerminal />);
    focusField();
    press({ key: "]", code: "BracketRight", ctrlKey: true, altKey: true });
    expect(fired(rig.runs)).toEqual(["viewer.cycle-workspace-next"]);
  });

  it("an AltGr chord is never a shortcut", () => {
    render(<Harness inTerminal />);
    focusField();
    const event = press({ key: "[", code: "Digit8", ctrlKey: true, altKey: true }, true);
    expect(fired(rig.runs)).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("off macOS outside a terminal", () => {
  beforeEach(() => setPlatform("Win32"));

  it("Ctrl+K opens Open Workspace and Ctrl+Shift+K does not", () => {
    render(<Harness inTerminal={false} />);
    focusField();
    press({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true });
    expect(fired(rig.runs)).toEqual(["viewer.clear-terminal"]);
    for (const spy of rig.runs.values()) spy.mockClear();
    press({ key: "k", code: "KeyK", ctrlKey: true });
    expect(fired(rig.runs)).toEqual(["nav.open-workspace"]);
  });

  it("an AltGr chord is never a shortcut", () => {
    render(<Harness inTerminal={false} />);
    focusField();
    press({ key: "[", code: "Digit8", ctrlKey: true, altKey: true }, true);
    expect(fired(rig.runs)).toEqual([]);
  });
});

describe("matchShortcut off macOS", () => {
  const gate = {
    settingsPanelOpen: false,
    hasActiveWorkspace: true,
    hasTeam: true,
    rowPopupFocused: false,
  };

  it("matches Ctrl+T outside a terminal and Ctrl+Shift+T in one", () => {
    setPlatform("Win32");
    const outside = render(<Harness inTerminal={false} />);
    const plain = keydown({ key: "t", code: "KeyT", ctrlKey: true });
    expect(matchShortcut(plain, {}, gate)?.id).toBe("viewer.new-terminal-tab");
    outside.unmount();
    render(<Harness inTerminal />);
    focusField();
    expect(matchShortcut(plain, {}, gate)).toBeUndefined();
    const shifted = new KeyboardEvent("keydown", {
      key: "T",
      code: "KeyT",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(matchShortcut(shifted, {}, gate)?.id).toBe("viewer.new-terminal-tab");
  });

  it("macOS: Cmd+T still matches from a terminal and Ctrl+T does not", () => {
    setPlatform("MacIntel");
    render(<Harness inTerminal />);
    focusField();
    const cmd = new KeyboardEvent("keydown", { key: "t", code: "KeyT", metaKey: true });
    const ctrl = new KeyboardEvent("keydown", { key: "t", code: "KeyT", ctrlKey: true });
    expect(matchShortcut(cmd, {}, gate)?.id).toBe("viewer.new-terminal-tab");
    expect(matchShortcut(ctrl, {}, gate)).toBeUndefined();
  });
});
