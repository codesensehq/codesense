// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, screen } from "@testing-library/react";

import { SHORTCUT_ACTIONS } from "@/shared/lib/shortcuts/registry";
import { useShortcutsStore } from "@/shared/stores/shortcuts-store";
import { useUiStore } from "@/shared/stores/ui-store";
import { useViewerStore, type Workspace } from "@/shared/stores/viewer-store";
import { useAgentInboxRailStore } from "@/features/viewer/stores/agent-inbox-rail-store";
import { useOrgStore } from "@/shared/stores/org-store";
import { buildTeamKey } from "@/shared/lib/team-key";
import { ROW_POPUP_ATTR, TERMINAL_POPUP_ATTR } from "@/shared/lib/focus-utils";
import { matchShortcut, useShortcutHandler } from "./use-shortcut-handler";
import { hasCmd } from "@/shared/lib/shortcuts/keystroke";

it("the real split action yields to a forwarded page field", () => {
  const gate = {
    settingsPanelOpen: false,
    hasActiveWorkspace: true,
    hasTeam: true,
    rowPopupFocused: false,
  };
  const key = new KeyboardEvent("keydown", { key: "d", code: "KeyD", metaKey: true });
  expect(matchShortcut(key, {}, gate, false, true)).toBeUndefined();
  expect(matchShortcut(key, {}, gate, true, false)).toBeUndefined();
  expect(matchShortcut(key, {}, gate, false, false)?.id).toBe("viewer.split-terminal");
});

const TEST_TEAM_KEY = buildTeamKey("acme", "core");
function makeRoot(slug = "acme/web"): Workspace {
  return {
    id: `root:${slug}`,
    kind: "root",
    cwd: `/Users/dev/repos/${slug.split("/").pop()}`,
    status: "ready",
    sourceRepoSlug: slug,
  };
}
function seedActiveWorkspace() {
  useOrgStore.setState({ activeOrgSlug: "acme", activeTeamName: "core" });
  const root = makeRoot();
  useViewerStore.setState({
    workspaces: { [TEST_TEAM_KEY]: [root] },
    activeWorkspace: { [TEST_TEAM_KEY]: root.id },
  });
}
const TILE_ID = "s-1";
/** A foreground story tile as the active workspace: the CLI has something to show and focus. */
function seedForegroundTile() {
  useOrgStore.setState({ activeOrgSlug: "acme", activeTeamName: "core" });
  const tile: Workspace = { id: TILE_ID, kind: "story", cwd: "/s-1", status: "ready" };
  useViewerStore.setState({
    workspaces: { [TEST_TEAM_KEY]: [tile] },
    activeWorkspace: { [TEST_TEAM_KEY]: tile.id },
  });
}
/** The CLI host with one terminal for the seeded tile. */
function cliDom() {
  return (
    <div data-xterm-host>
      <div data-pane-id={TILE_ID}>
        <div className="xterm">
          <textarea data-testid="terminal" defaultValue="terminal content" />
        </div>
      </div>
    </div>
  );
}
function clearActiveWorkspace() {
  useOrgStore.setState({ activeOrgSlug: null, activeTeamName: null });
  useViewerStore.setState({ workspaces: {}, activeWorkspace: {} });
}

// ---------- Test rig ----------

function Harness() {
  useShortcutHandler();
  return null;
}

// Spy on one action's `run` per test, restore afterward.
function spyAction(actionId: string) {
  const action = SHORTCUT_ACTIONS.find((a) => a.id === actionId)!;
  const original = action.run;
  const spy = vi.fn();
  (action as { run: () => void }).run = spy;
  return {
    spy,
    restore: () => {
      (action as { run: () => void }).run = original;
    },
  };
}

// ---------- Setup ----------

beforeEach(() => {
  useShortcutsStore.setState({ shortcuts: {}, stateLoaded: true });
  clearActiveWorkspace();
  useUiStore.setState({ settingsPanelOpen: false });
});

// ---------- Tests ----------

describe("useShortcutHandler", () => {
  it("a workspace action needs a workspace in the active team: another team's does not count", () => {
    const other = buildTeamKey("acme", "other");
    const ws: Workspace = { id: "s-1", kind: "story", cwd: "/s-1", status: "ready" };
    useOrgStore.setState({ activeOrgSlug: "acme", activeTeamName: "core" });
    useViewerStore.setState({
      openedTeams: [TEST_TEAM_KEY, other],
      workspaces: { [TEST_TEAM_KEY]: [], [other]: [ws] },
      activeWorkspace: { [other]: ws.id },
      softClosedWorkspaces: {},
    });
    const newTab = spyAction("viewer.new-terminal-tab");
    try {
      render(<Harness />);
      const t = new KeyboardEvent("keydown", {
        key: "t",
        code: "KeyT",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        document.dispatchEvent(t);
      });
      // The key falls through: nothing in the active team could take it.
      expect(newTab.spy).not.toHaveBeenCalled();
      expect(t.defaultPrevented).toBe(false);
      // Once that team is the active one, ⌘T acts on its workspace.
      act(() => useOrgStore.setState({ activeTeamName: "other" }));
      const again = new KeyboardEvent("keydown", {
        key: "t",
        code: "KeyT",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        document.dispatchEvent(again);
      });
      expect(newTab.spy).toHaveBeenCalledTimes(1);
      expect(again.defaultPrevented).toBe(true);
    } finally {
      newTab.restore();
      useViewerStore.setState({ openedTeams: [] });
    }
  });

  describe("with focus in a row popup of the Agents pane, no CLI, tile, tray or workspace key acts", () => {
    const keys: [string, Partial<KeyboardEventInit>][] = [
      ["viewer.new-terminal-tab", { key: "t", code: "KeyT" }],
      ["viewer.find-in-terminal", { key: "f", code: "KeyF" }],
      ["nav.open-workspace", { key: "k", code: "KeyK" }],
      ["viewer.toggle-terminal-zoom", { key: "M", code: "KeyM", shiftKey: true }],
      ["viewer.cycle-foreground-layout", { key: "L", code: "KeyL", shiftKey: true }],
      ["viewer.jump-workspace-1", { key: "1", code: "Digit1" }],
      ["viewer.cycle-workspace-next", { key: "]", code: "BracketRight", altKey: true }],
      ["viewer.cycle-workspace-prev", { key: "[", code: "BracketLeft", altKey: true }],
      ["viewer.flip-last-workspace", { key: ";", code: "Semicolon", altKey: true }],
      ["viewer.jump-root-workspace", { key: "0", code: "Digit0" }],
      ["viewer.focus-tile-question", { key: "J", code: "KeyJ", shiftKey: true }],
      ["viewer.split-terminal", { key: "d", code: "KeyD" }],
      ["viewer.new-terminal-on-machine", { key: "N", code: "KeyN", shiftKey: true }],
      ["viewer.clear-terminal", { key: "K", code: "KeyK", shiftKey: true }],
      ["viewer.close-workspace", { key: "W", code: "KeyW", shiftKey: true }],
      ["viewer.hard-close-workspace", { key: "Backspace", code: "Backspace", shiftKey: true }],
      ["viewer.cycle-terminal-tab-next", { key: "}", code: "BracketRight", shiftKey: true }],
      ["viewer.cycle-terminal-tab-prev", { key: "{", code: "BracketLeft", shiftKey: true }],
      ["viewer.jump-terminal-tab-1", { key: "¡", code: "Digit1", altKey: true }],
      ["viewer.focus-pane-left", { key: "ArrowLeft", code: "ArrowLeft", altKey: true }],
    ];

    /** A focused textarea: in the quick view's xterm, in the inbox chat, or a plain one. */
    function focusTextarea(where: "quick view" | "inbox chat" | "outside"): HTMLTextAreaElement {
      const host = document.createElement("div");
      if (where === "quick view") host.setAttribute(TERMINAL_POPUP_ATTR, "");
      if (where !== "outside") host.setAttribute(ROW_POPUP_ATTR, "");
      host.innerHTML =
        where === "inbox chat"
          ? "<textarea></textarea>"
          : '<div class="xterm"><textarea></textarea></div>';
      document.body.appendChild(host);
      const textarea = host.querySelector("textarea")!;
      textarea.focus();
      return textarea;
    }

    describe.each(["quick view", "inbox chat"] as const)("the %s", (where) => {
      it.each(keys)("%s", (id, init) => {
        seedActiveWorkspace();
        const { spy, restore } = spyAction(id);
        try {
          render(<Harness />);
          const inPopup = focusTextarea(where);
          act(() => {
            fireEvent.keyDown(inPopup, { ...init, metaKey: true });
          });
          expect(spy).not.toHaveBeenCalled();
          // The same key outside the popup acts.
          const outside = focusTextarea("outside");
          act(() => {
            fireEvent.keyDown(outside, { ...init, metaKey: true });
          });
          expect(spy).toHaveBeenCalledTimes(1);
        } finally {
          restore();
          document.body.innerHTML = "";
        }
      });

      it.each([
        ["settings.open", { key: ",", code: "Comma" }],
        ["nav.open-command-palette", { key: "P", code: "KeyP", shiftKey: true }],
      ] as [string, Partial<KeyboardEventInit>][])("%s still opens over it", (id, init) => {
        seedActiveWorkspace();
        const { spy, restore } = spyAction(id);
        try {
          render(<Harness />);
          const inPopup = focusTextarea(where);
          act(() => {
            fireEvent.keyDown(inPopup, { ...init, metaKey: true });
          });
          expect(spy).toHaveBeenCalledTimes(1);
        } finally {
          restore();
          document.body.innerHTML = "";
        }
      });
    });
  });

  it("fires a global action's run() when its default keystroke is pressed", () => {
    const { spy, restore } = spyAction("settings.open");
    try {
      render(<Harness />);
      act(() => {
        fireEvent.keyDown(document, { key: ",", metaKey: true });
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("does NOT fire a workspace-scoped action when no workspace is focused", () => {
    // toggle-terminal-zoom is workspace-scoped (it needs a foreground tile),
    // unlike the team-scoped layout toggles below.
    const { spy, restore } = spyAction("viewer.toggle-terminal-zoom");
    try {
      render(<Harness />);
      act(() => {
        fireEvent.keyDown(document, { key: "M", metaKey: true, shiftKey: true });
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("DOES fire a workspace-scoped action when a workspace IS focused", () => {
    const { spy, restore } = spyAction("viewer.toggle-terminal-zoom");
    try {
      seedActiveWorkspace();
      render(<Harness />);
      act(() => {
        fireEvent.keyDown(document, { key: "M", metaKey: true, shiftKey: true });
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("SW-EW-35: a team-scoped layout toggle (Cmd+\\) fires in the empty state — team active, no focused workspace", () => {
    const { spy, restore } = spyAction("viewer.toggle-terminal");
    try {
      // Last workspace closed → team open but nothing focused. The terminal /
      // right-pane / nav / console toggles are TEAM surfaces, so they must still
      // fire here (would have been skipped when they were workspace-scoped).
      useOrgStore.setState({ activeOrgSlug: "acme", activeTeamName: "core" });
      useViewerStore.setState({ workspaces: {}, activeWorkspace: {} });
      render(<Harness />);
      act(() => {
        fireEvent.keyDown(document, { key: "\\", metaKey: true });
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("SW-EW-33: a team-scoped action (Cmd+1) fires with a team active but NO focused workspace", () => {
    const { spy, restore } = spyAction("viewer.jump-workspace-1");
    try {
      // Team open, but every workspace minimized → no focused workspace.
      useOrgStore.setState({ activeOrgSlug: "acme", activeTeamName: "core" });
      useViewerStore.setState({ workspaces: {}, activeWorkspace: {} });
      render(<Harness />);
      act(() => {
        fireEvent.keyDown(document, { key: "1", metaKey: true });
      });
      expect(spy).toHaveBeenCalledTimes(1); // would have been skipped if scope were "workspace"
    } finally {
      restore();
    }
  });

  it("SW-EW-33: a team-scoped action does NOT fire when no team is active", () => {
    const { spy, restore } = spyAction("viewer.jump-workspace-1");
    try {
      clearActiveWorkspace(); // also clears org/team
      render(<Harness />);
      act(() => {
        fireEvent.keyDown(document, { key: "1", metaKey: true });
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("respects user override — new keystroke fires, old default does NOT", () => {
    const { spy, restore } = spyAction("settings.open");
    try {
      // Rebind settings.open to CmdOrCtrl+Shift+.
      useShortcutsStore.setState({
        shortcuts: { "settings.open": "CmdOrCtrl+Shift+." },
        stateLoaded: true,
      });
      render(<Harness />);
      // New keystroke → fires
      act(() => {
        fireEvent.keyDown(document, { key: ".", metaKey: true, shiftKey: true });
      });
      expect(spy).toHaveBeenCalledTimes(1);

      // Old default (CmdOrCtrl+,) → does NOT fire
      act(() => {
        fireEvent.keyDown(document, { key: ",", metaKey: true });
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("preventDefault runs when a match is found", () => {
    render(<Harness />);
    let event: KeyboardEvent | null = null;
    const handler = (e: KeyboardEvent) => {
      event = e;
    };
    document.addEventListener("keydown", handler);
    act(() => {
      fireEvent.keyDown(document, { key: ",", metaKey: true });
    });
    document.removeEventListener("keydown", handler);
    // The global handler fires first (earlier registration on document)
    // and calls preventDefault before the observer listener sees it.
    expect(event).not.toBeNull();
    expect(event!.defaultPrevented).toBe(true);
  });

  it("leaves a key a focused text editor already handled to the editor (⌘I italic)", () => {
    const { spy, restore } = spyAction("settings.open");
    const editor = document.createElement("div");
    editor.className = "ProseMirror";
    editor.setAttribute("contenteditable", "true");
    document.body.appendChild(editor);
    const claim = (e: Event) => e.preventDefault();
    editor.addEventListener("keydown", claim);
    try {
      render(<Harness />);
      act(() => {
        fireEvent.keyDown(editor, { key: ",", metaKey: true });
      });
      expect(spy).not.toHaveBeenCalled();
      // Not claimed by the editor: the shortcut still fires from inside it.
      editor.removeEventListener("keydown", claim);
      act(() => {
        fireEvent.keyDown(editor, { key: ",", metaKey: true });
      });
      expect(spy).toHaveBeenCalledTimes(1);
      // Claimed outside any editor (a plain button): the shortcut still fires.
      const button = document.createElement("button");
      document.body.appendChild(button);
      button.addEventListener("keydown", claim);
      act(() => {
        fireEvent.keyDown(button, { key: ",", metaKey: true });
      });
      expect(spy).toHaveBeenCalledTimes(2);
      button.remove();
    } finally {
      editor.remove();
      restore();
    }
  });

  it("treats any editable host (contenteditable, plaintext-only) as an editor, not ='false'", () => {
    const { spy, restore } = spyAction("settings.open");
    const claim = (e: Event) => e.preventDefault();
    const make = (value: string) => {
      const el = document.createElement("div");
      el.setAttribute("contenteditable", value);
      el.addEventListener("keydown", claim);
      document.body.appendChild(el);
      return el;
    };
    const bare = make("");
    const plain = make("plaintext-only");
    const off = make("false");
    try {
      render(<Harness />);
      act(() => {
        fireEvent.keyDown(bare, { key: ",", metaKey: true });
        fireEvent.keyDown(plain, { key: ",", metaKey: true });
      });
      expect(spy).not.toHaveBeenCalled();
      act(() => {
        fireEvent.keyDown(off, { key: ",", metaKey: true });
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      for (const el of [bare, plain, off]) el.remove();
      restore();
    }
  });

  it("ignores keydown fired during IME composition", () => {
    const { spy, restore } = spyAction("settings.open");
    try {
      render(<Harness />);
      act(() => {
        fireEvent.keyDown(document, { key: ",", metaKey: true, isComposing: true });
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("lets in-tree handlers claim a keystroke via stopPropagation (bubble phase)", () => {
    const { spy, restore } = spyAction("settings.open");
    try {
      const claimer = (e: KeyboardEvent) => {
        if (hasCmd(e) && e.key === ",") e.stopPropagation();
      };
      // Listener attached to body bubbles to document; if document's
      // global handler is also bubble-phase, stopPropagation keeps the
      // event from reaching it.
      document.body.addEventListener("keydown", claimer);
      render(<Harness />);
      act(() => {
        fireEvent.keyDown(document.body, { key: ",", metaKey: true });
      });
      document.body.removeEventListener("keydown", claimer);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("does not match unrelated keys — no spurious dispatch", () => {
    const { spy, restore } = spyAction("settings.open");
    try {
      render(<Harness />);
      act(() => {
        fireEvent.keyDown(document, { key: "a", metaKey: true });
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("does NOT fire a document workspace action (⌘⇧E export) on the Settings tab", () => {
    const { spy, restore } = spyAction("viewer.export-pdf");
    try {
      seedActiveWorkspace();
      useUiStore.setState({ settingsPanelOpen: true });
      render(<Harness />);
      act(() => {
        fireEvent.keyDown(document, { key: "E", metaKey: true, shiftKey: true });
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("⌘T on the Settings tab opens a terminal tab in the focused workspace", () => {
    const { spy, restore } = spyAction("viewer.new-terminal-tab");
    try {
      seedActiveWorkspace();
      useUiStore.setState({ settingsPanelOpen: true });
      render(<Harness />);
      act(() => {
        fireEvent.keyDown(document, { key: "t", metaKey: true });
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("⌘\\ on the Settings tab is a plain toggle: reveals from hidden, hides from visible, hides from CLI focus", async () => {
    // Real listener + registry + action integration through ordinary rendered DOM, with no
    // action spy or helper stub: the real store transitions prove it.
    seedForegroundTile();
    useViewerStore.setState({
      layoutMode: "viewer",
      terminalVisible: false,
      lastTerminalMode: "shared",
    });
    useUiStore.setState({ settingsPanelOpen: true });

    const { unmount } = render(
      <div>
        <Harness />
        <input data-testid="settings-control" />
        {cliDom()}
      </div>,
    );

    const settingsControl = screen.getByTestId("settings-control");
    const terminal = screen.getByTestId("terminal");

    // 1. Settings focus with the CLI hidden -> reveal the CLI and focus the terminal.
    act(() => settingsControl.focus());
    act(() => {
      fireEvent.keyDown(document, { key: "\\", metaKey: true });
    });
    expect(useViewerStore.getState().layoutMode).toBe("shared");
    expect(useViewerStore.getState().terminalVisible).toBe(true);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(document.activeElement).toBe(terminal);

    // 2. Settings focus with the CLI visible -> hide it; Settings keeps focus.
    act(() => settingsControl.focus());
    act(() => {
      fireEvent.keyDown(document, { key: "\\", metaKey: true });
    });
    expect(useViewerStore.getState().layoutMode).toBe("viewer");
    expect(useViewerStore.getState().terminalVisible).toBe(false);
    expect(document.activeElement).toBe(settingsControl);
    expect((terminal as HTMLTextAreaElement).value).toBe("terminal content");

    // 3. Terminal focus with the CLI visible -> hide via the real listener/registry/action.
    act(() => {
      useViewerStore.getState().setLayoutMode("shared");
    });
    act(() => terminal.focus());
    act(() => {
      fireEvent.keyDown(document, { key: "\\", metaKey: true });
    });
    expect(useViewerStore.getState().layoutMode).toBe("viewer");
    expect(useViewerStore.getState().terminalVisible).toBe(false);

    unmount();
  });

  it("keeps the document-only team action ⌘E blocked on the Settings tab", () => {
    const { spy, restore } = spyAction("viewer.edit-file");
    try {
      seedActiveWorkspace();
      useUiStore.setState({ settingsPanelOpen: true });
      render(<Harness />);
      act(() => {
        fireEvent.keyDown(document, { key: "e", metaKey: true });
      });
      expect(spy).not.toHaveBeenCalled();
      // Off the Settings tab the same key dispatches.
      act(() => useUiStore.setState({ settingsPanelOpen: false }));
      act(() => {
        fireEvent.keyDown(document, { key: "e", metaKey: true });
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("STILL fires a global action when Settings is open", () => {
    const { spy, restore } = spyAction("settings.open");
    try {
      useUiStore.setState({ settingsPanelOpen: true });
      render(<Harness />);
      act(() => {
        fireEvent.keyDown(document, { key: ",", metaKey: true });
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("detaches the listener on unmount", () => {
    const { spy, restore } = spyAction("settings.open");
    try {
      const { unmount } = render(<Harness />);
      unmount();
      act(() => {
        fireEvent.keyDown(document, { key: ",", metaKey: true });
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

// ---------- ⌘\\ is a plain toggle in every focus context ----------

const nextFrame = () => act(async () => void (await new Promise((r) => requestAnimationFrame(r))));
const cmdBackslash = (target: Element | Document = document) =>
  act(() => {
    fireEvent.keyDown(target, { key: "\\", code: "Backslash", metaKey: true });
  });
const layout = () => useViewerStore.getState().layoutMode;

type FocusTarget = {
  name: string;
  /** Mount the focus target; returns the element to focus. */
  mount: () => HTMLElement;
};

function mountEditor(cls: "cm-content" | "ProseMirror"): HTMLElement {
  const wrap = document.createElement("div");
  wrap.innerHTML =
    cls === "cm-content"
      ? '<div class="cm-editor"><div class="cm-content" contenteditable="true" tabindex="0">some text</div></div>'
      : '<div class="ProseMirror" contenteditable="true" tabindex="0">some text</div>';
  document.body.appendChild(wrap);
  return wrap.querySelector<HTMLElement>(`.${cls}`)!;
}

const TARGETS: FocusTarget[] = [
  {
    name: "an Inbox composer",
    mount: () => {
      const t = document.createElement("textarea");
      t.value = "draft";
      document.body.appendChild(t);
      return t;
    },
  },
  {
    name: "an HTML document frame",
    mount: () => {
      const f = document.createElement("iframe");
      document.body.appendChild(f);
      return f;
    },
  },
  { name: "a CodeMirror editor", mount: () => mountEditor("cm-content") },
  { name: "a ProseMirror editor", mount: () => mountEditor("ProseMirror") },
];

describe("⌘\\ toggles the CLI from any focus", () => {
  beforeEach(() => {
    seedForegroundTile();
    useViewerStore.setState({ lastTerminalMode: "shared" });
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe.each(TARGETS)("with focus in $name", ({ mount }) => {
    it("hides a visible CLI and leaves focus and the selection where they were", () => {
      useViewerStore.setState({ layoutMode: "shared", terminalVisible: true });
      render(
        <div>
          <Harness />
          {cliDom()}
        </div>,
      );
      const target = mount();
      act(() => target.focus());
      expect(document.activeElement).toBe(target);
      const text = target.firstChild;
      if (text) {
        const range = document.createRange();
        range.setStart(text, 2);
        range.setEnd(text, 5);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
      }
      cmdBackslash(target);
      expect(layout()).toBe("viewer");
      expect(document.activeElement).toBe(target);
      if (text) {
        const after = window.getSelection()!.getRangeAt(0);
        expect([after.startContainer, after.startOffset, after.endOffset]).toEqual([text, 2, 5]);
      }
    });

    it("reveals a hidden CLI and focuses its terminal", async () => {
      useViewerStore.setState({ layoutMode: "viewer", terminalVisible: false });
      render(
        <div>
          <Harness />
          {cliDom()}
        </div>,
      );
      const target = mount();
      act(() => target.focus());
      cmdBackslash(target);
      expect(layout()).toBe("shared");
      await nextFrame();
      expect(document.activeElement).toBe(screen.getByTestId("terminal"));
    });
  });

  // A row popup drawn outside the Agents pane (the title-bar host agent menu), so it does not
  // unmount with the CLI. Popups inside the pane are covered by the workbench seam test.
  describe("with focus in a title-bar agent menu popup", () => {
    function mountPopup() {
      const popup = document.createElement("div");
      popup.setAttribute(ROW_POPUP_ATTR, "");
      popup.innerHTML = "<textarea>popup draft</textarea>";
      document.body.appendChild(popup);
      return { popup, draft: popup.querySelector("textarea")! };
    }

    it("hides a visible CLI; the popup keeps focus and its draft", () => {
      useViewerStore.setState({ layoutMode: "shared", terminalVisible: true });
      render(
        <div>
          <Harness />
          {cliDom()}
        </div>,
      );
      const { popup, draft } = mountPopup();
      act(() => draft.focus());
      cmdBackslash(draft);
      expect(layout()).toBe("viewer");
      expect(document.activeElement).toBe(draft);
      expect(draft.value).toBe("popup draft");
      expect(document.body.contains(popup)).toBe(true);
    });

    it("reveals a hidden CLI and focuses its terminal; the popup stays open with its draft", async () => {
      useViewerStore.setState({ layoutMode: "viewer", terminalVisible: false });
      render(
        <div>
          <Harness />
          {cliDom()}
        </div>,
      );
      const { popup, draft } = mountPopup();
      act(() => draft.focus());
      cmdBackslash(draft);
      expect(layout()).toBe("shared");
      await nextFrame();
      expect(document.activeElement).toBe(screen.getByTestId("terminal"));
      expect(draft.value).toBe("popup draft");
      expect(document.body.contains(popup)).toBe(true);
    });
  });

  it("restores a full-screen CLI when that was the last terminal mode", async () => {
    useViewerStore.setState({
      layoutMode: "viewer",
      terminalVisible: false,
      lastTerminalMode: "console",
    });
    render(
      <div>
        <Harness />
        <input data-testid="outside" />
        {cliDom()}
      </div>,
    );
    act(() => screen.getByTestId("outside").focus());
    cmdBackslash();
    expect(layout()).toBe("console");
    await nextFrame();
    expect(document.activeElement).toBe(screen.getByTestId("terminal"));
  });

  it("a rebound chord toggles from outside the CLI, and the old default does not", () => {
    useShortcutsStore.setState({
      shortcuts: { "viewer.toggle-terminal": "CmdOrCtrl+Shift+Y" },
      stateLoaded: true,
    });
    useViewerStore.setState({ layoutMode: "shared", terminalVisible: true });
    render(
      <div>
        <Harness />
        <input data-testid="outside" />
        {cliDom()}
      </div>,
    );
    const outside = screen.getByTestId("outside");
    act(() => outside.focus());
    cmdBackslash(outside);
    expect(layout()).toBe("shared");
    act(() => {
      fireEvent.keyDown(outside, { key: "Y", code: "KeyY", metaKey: true, shiftKey: true });
    });
    expect(layout()).toBe("viewer");
    expect(document.activeElement).toBe(outside);
  });

  it("a plain backslash types a backslash: no toggle, and the key is not prevented", () => {
    useViewerStore.setState({ layoutMode: "shared", terminalVisible: true });
    render(
      <div>
        <Harness />
        <textarea data-testid="composer" />
        {cliDom()}
      </div>,
    );
    const composer = screen.getByTestId("composer");
    act(() => composer.focus());
    const ev = new KeyboardEvent("keydown", {
      key: "\\",
      code: "Backslash",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      composer.dispatchEvent(ev);
    });
    expect(layout()).toBe("shared");
    expect(ev.defaultPrevented).toBe(false);
  });
});

// ---------- ⌘I is unchanged (pinned) ----------

describe("⌘I (Toggle Agent Inbox) across focus contexts", () => {
  const cmdI = (target: Element, beforeDispatch?: (e: KeyboardEvent) => void) => {
    const ev = new KeyboardEvent("keydown", {
      key: "i",
      code: "KeyI",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    beforeDispatch?.(ev);
    act(() => {
      target.dispatchEvent(ev);
    });
    return ev;
  };

  beforeEach(() => {
    seedForegroundTile();
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each(TARGETS.slice(0, 2))("fires from $name", ({ mount }) => {
    const { spy, restore } = spyAction("viewer.toggle-agent-inbox");
    try {
      render(<Harness />);
      const target = mount();
      act(() => target.focus());
      cmdI(target);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("fires from the CLI terminal", () => {
    const { spy, restore } = spyAction("viewer.toggle-agent-inbox");
    try {
      render(
        <div>
          <Harness />
          {cliDom()}
        </div>,
      );
      const terminal = screen.getByTestId("terminal");
      act(() => terminal.focus());
      cmdI(terminal);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it.each(TARGETS.slice(2))(
    "leaves a Mod-i the editor prevents to the editor in $name",
    ({ mount }) => {
      const { spy, restore } = spyAction("viewer.toggle-agent-inbox");
      try {
        render(<Harness />);
        const target = mount();
        act(() => target.focus());
        // Stands in for the editor keymap, which handles Mod-i (italic) and prevents the default.
        target.addEventListener("keydown", (e) => e.preventDefault());
        cmdI(target);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    },
  );

  it("stays blocked in an Agents row popup", () => {
    const { spy, restore } = spyAction("viewer.toggle-agent-inbox");
    try {
      render(<Harness />);
      const popup = document.createElement("div");
      popup.setAttribute(ROW_POPUP_ATTR, "");
      popup.innerHTML = "<textarea></textarea>";
      document.body.appendChild(popup);
      const draft = popup.querySelector("textarea")!;
      act(() => draft.focus());
      cmdI(draft);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("runs but changes nothing unless the active tab is a running agent", () => {
    const action = SHORTCUT_ACTIONS.find((x) => x.id === "viewer.toggle-agent-inbox")!;
    const original = action.run;
    const ran = vi.fn(original);
    (action as { run: () => void }).run = ran;
    try {
      render(<Harness />);
      const before = JSON.stringify(useAgentInboxRailStore.getState().bySession);
      cmdI(document.body);
      expect(ran).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(useAgentInboxRailStore.getState().bySession)).toBe(before);
    } finally {
      (action as { run: () => void }).run = original;
    }
  });
});
