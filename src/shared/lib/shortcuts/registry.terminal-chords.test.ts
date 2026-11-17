// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";

import {
  resolveBindings,
  setDynamicShortcutActions,
  SHORTCUT_ACTIONS,
  type ShortcutAction,
} from "./registry";
import { restorePlatform, setPlatform } from "@/test/platform";

/**
 * Every built-in default binding, the chord it answers to from a focused terminal off macOS
 * ("" = no key while a terminal has focus), and on macOS (the same as the binding: today's
 * behaviour, unchanged). A new or changed default shows up as a diff here.
 */
const GENERATED_UNCHANGED: ReadonlyArray<[string, string]> = [
  ...Array.from({ length: 9 }, (_, i): [string, string] => [
    `viewer.jump-workspace-${i + 1}`,
    `CmdOrCtrl+${i + 1}`,
  ]),
  ...Array.from({ length: 9 }, (_, i): [string, string] => [
    `viewer.jump-terminal-tab-${i + 1}`,
    `CmdOrCtrl+Alt+${i + 1}`,
  ]),
  ["viewer.focus-pane-left", "CmdOrCtrl+Alt+ArrowLeft"],
  ["viewer.focus-pane-right", "CmdOrCtrl+Alt+ArrowRight"],
  ["viewer.focus-pane-up", "CmdOrCtrl+Alt+ArrowUp"],
  ["viewer.focus-pane-down", "CmdOrCtrl+Alt+ArrowDown"],
];

/** [action id, default binding, terminal chord off macOS]. */
const TABLE: ReadonlyArray<[string, string, string]> = [
  ["settings.open", "CmdOrCtrl+,", "CmdOrCtrl+,"],
  ["nav.open-machines", "CmdOrCtrl+Alt+C", "CmdOrCtrl+Alt+C"],
  ["nav.open-source-repos", "CmdOrCtrl+Alt+R", "CmdOrCtrl+Alt+R"],
  ["nav.open-teams", "CmdOrCtrl+Alt+T", "CmdOrCtrl+Alt+T"],
  ["nav.open-workspaces", "CmdOrCtrl+Alt+W", "CmdOrCtrl+Alt+W"],
  ["nav.open-workspace", "CmdOrCtrl+K", "CmdOrCtrl+Shift+K"],
  ["nav.quick-open", "CmdOrCtrl+P", "CmdOrCtrl+Shift+P"],
  ["nav.open-note-switcher", "CmdOrCtrl+O", "CmdOrCtrl+Shift+O"],
  ["nav.goto-heading", "CmdOrCtrl+Shift+O", ""],
  ["nav.open-command-palette", "CmdOrCtrl+Shift+P", ""],
  ["nav.focus-left-search", "CmdOrCtrl+Shift+F", ""],
  ["nav.switch-org", "CmdOrCtrl+Shift+G", "CmdOrCtrl+Shift+G"],
  ["nav.switch-team", "CmdOrCtrl+Alt+Shift+T", "CmdOrCtrl+Alt+Shift+T"],
  ["viewer.toggle-terminal", "CmdOrCtrl+\\", "CmdOrCtrl+Shift+\\"],
  ["viewer.toggle-nav", "CmdOrCtrl+B", "CmdOrCtrl+Shift+B"],
  ["viewer.toggle-right-pane", "CmdOrCtrl+J", "CmdOrCtrl+Shift+J"],
  ["viewer.toggle-pane-full-screen", "", ""],
  ["viewer.toggle-console", "CmdOrCtrl+Shift+\\", ""],
  ["viewer.open-story-dashboard", "", ""],
  ["viewer.cycle-foreground-layout", "CmdOrCtrl+Shift+L", "CmdOrCtrl+Shift+L"],
  ["weft.jump-to-next-needs-you", "CmdOrCtrl+Alt+Shift+J", "CmdOrCtrl+Alt+Shift+J"],
  ["viewer.focus-tile-question", "CmdOrCtrl+Shift+J", ""],
  ["viewer.toggle-story-hud", "CmdOrCtrl+Shift+H", "CmdOrCtrl+Shift+H"],
  ["viewer.toggle-story-hud-size", "CmdOrCtrl+Shift+U", "CmdOrCtrl+Shift+U"],
  ["viewer.toggle-source-diff", "CmdOrCtrl+Shift+D", ""],
  ["viewer.toggle-code-editor", "CmdOrCtrl+Shift+C", ""],
  ["viewer.toggle-agent-inbox", "CmdOrCtrl+I", "CmdOrCtrl+Shift+I"],
  ["viewer.open-group-chat", "CmdOrCtrl+Alt+G", "CmdOrCtrl+Alt+G"],
  ["viewer.toggle-inbox-rollup", "CmdOrCtrl+Shift+I", ""],
  ["viewer.toggle-terminal-zoom", "CmdOrCtrl+Shift+M", "CmdOrCtrl+Shift+M"],
  ["viewer.cycle-workspace-next", "CmdOrCtrl+Alt+]", "CmdOrCtrl+Alt+]"],
  ["viewer.cycle-workspace-prev", "CmdOrCtrl+Alt+[", "CmdOrCtrl+Alt+["],
  ["viewer.cycle-terminal-tab-next", "CmdOrCtrl+Shift+]", "CmdOrCtrl+Shift+]"],
  ["viewer.cycle-terminal-tab-prev", "CmdOrCtrl+Shift+[", "CmdOrCtrl+Shift+["],
  ["viewer.cycle-epic-next", "CmdOrCtrl+Alt+Shift+]", "CmdOrCtrl+Alt+Shift+]"],
  ["viewer.cycle-epic-prev", "CmdOrCtrl+Alt+Shift+[", "CmdOrCtrl+Alt+Shift+["],
  ["viewer.jump-root-workspace", "CmdOrCtrl+0", "CmdOrCtrl+0"],
  ["viewer.close-workspace", "CmdOrCtrl+Shift+W", "CmdOrCtrl+Shift+W"],
  ["viewer.hard-close-workspace", "CmdOrCtrl+Shift+Backspace", "CmdOrCtrl+Shift+Backspace"],
  ["viewer.edit-file", "CmdOrCtrl+E", "CmdOrCtrl+Shift+E"],
  ["viewer.export-pdf", "CmdOrCtrl+Shift+E", ""],
  ["viewer.flip-last-workspace", "CmdOrCtrl+Alt+;", "CmdOrCtrl+Alt+;"],
  ["viewer.new-terminal-tab", "CmdOrCtrl+T", "CmdOrCtrl+Shift+T"],
  ["viewer.new-terminal-on-machine", "CmdOrCtrl+Shift+N", "CmdOrCtrl+Shift+N"],
  ["viewer.split-terminal", "CmdOrCtrl+D", "CmdOrCtrl+Shift+D"],
  ["viewer.reopen-closed-tab", "CmdOrCtrl+Shift+T", ""],
  ["viewer.rename-terminal-tab", "F2", "F2"],
  ["viewer.find-in-terminal", "CmdOrCtrl+F", "CmdOrCtrl+Shift+F"],
  ["viewer.clear-terminal", "CmdOrCtrl+Shift+K", ""],
  ["story.launch-agent", "CmdOrCtrl+Shift+A", "CmdOrCtrl+Shift+A"],
  ["nav.context-back", "CmdOrCtrl+[", ""],
  ["nav.context-forward", "CmdOrCtrl+]", ""],
  ...GENERATED_UNCHANGED.map(([id, chord]): [string, string, string] => [id, chord, chord]),
];

afterEach(restorePlatform);

describe("default bindings", () => {
  it("the table lists every built-in action once, with its default", () => {
    expect(TABLE.map(([id]) => id).sort()).toEqual(SHORTCUT_ACTIONS.map((a) => a.id).sort());
    for (const [id, binding] of TABLE) {
      expect(SHORTCUT_ACTIONS.find((a) => a.id === id)?.defaultKeystroke, id).toBe(binding);
    }
  });

  it.each([
    ["macOS", "MacIntel"],
    ["Windows", "Win32"],
    ["Linux", "Linux x86_64"],
  ])("%s: outside a terminal every action answers to its binding", (_name, platform) => {
    setPlatform(platform);
    const bindings = resolveBindings({});
    for (const [id, binding] of TABLE) expect(bindings.get(id)?.keystroke, id).toBe(binding);
  });

  it("macOS: in a terminal every action answers to its binding, as before", () => {
    setPlatform("MacIntel");
    const bindings = resolveBindings({});
    for (const [id, binding] of TABLE)
      expect(bindings.get(id)?.terminalKeystroke, id).toBe(binding);
  });

  it.each([
    ["Windows", "Win32"],
    ["Linux", "Linux x86_64"],
  ])("%s: in a terminal every action answers to its terminal chord", (_name, platform) => {
    setPlatform(platform);
    const bindings = resolveBindings({});
    for (const [id, , chord] of TABLE) expect(bindings.get(id)?.terminalKeystroke, id).toBe(chord);
  });

  it("off macOS the actions with no key in a terminal are the ones the shell or the terminal keeps", () => {
    setPlatform("Win32");
    const bindings = resolveBindings({});
    const keyless = TABLE.filter(([id, binding]) => binding && !bindings.get(id)?.terminalKeystroke)
      .map(([id]) => id)
      .sort();
    expect(keyless).toEqual(
      [
        "nav.context-back",
        "nav.context-forward",
        "nav.focus-left-search",
        "nav.goto-heading",
        "nav.open-command-palette",
        "viewer.clear-terminal",
        "viewer.export-pdf",
        "viewer.focus-tile-question",
        "viewer.reopen-closed-tab",
        "viewer.toggle-code-editor",
        "viewer.toggle-console",
        "viewer.toggle-inbox-rollup",
        "viewer.toggle-source-diff",
      ].sort(),
    );
  });

  it("no action answers to a bare Ctrl letter, Ctrl+[, Ctrl+\\, Ctrl+] or Ctrl+Space in a terminal off macOS", () => {
    setPlatform("Win32");
    for (const [id, binding] of resolveBindings({})) {
      expect(binding.terminalKeystroke, id).not.toMatch(/^CmdOrCtrl\+(?:[A-Z]|\[|\\|\]|Space)$/);
    }
  });

  it("a user override moves with the same rule", () => {
    setPlatform("Win32");
    const bindings = resolveBindings({ "viewer.clear-terminal": "CmdOrCtrl+L" });
    expect(bindings.get("viewer.clear-terminal")?.keystroke).toBe("CmdOrCtrl+L");
    expect(bindings.get("viewer.clear-terminal")?.terminalKeystroke).toBe("CmdOrCtrl+Shift+L");
  });
});

describe("a dashboard command in a terminal", () => {
  const pageCommand: ShortcutAction = {
    id: "page/hud-size",
    label: "Resize",
    defaultKeystroke: "CmdOrCtrl+U",
    scope: "global",
    command: {
      dashboard: "page",
      dashboardTitle: "Page",
      dashboardScope: "built-in",
      humanOnly: false,
      active: true,
    },
    run: () => {},
  };

  afterEach(() => setDynamicShortcutActions([]));

  it("never takes a built-in's own Ctrl+Shift chord", () => {
    setPlatform("Win32");
    setDynamicShortcutActions([pageCommand]);
    const bindings = resolveBindings({});
    expect(bindings.get("page/hud-size")?.keystroke).toBe("CmdOrCtrl+U");
    expect(bindings.get("page/hud-size")?.terminalKeystroke).toBe("");
    expect(bindings.get("viewer.toggle-story-hud-size")?.terminalKeystroke).toBe(
      "CmdOrCtrl+Shift+U",
    );
  });
});
