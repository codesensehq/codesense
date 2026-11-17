// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";

import { isTerminalBracketKey, terminalChord } from "./terminal-chord";

const originalPlatform = navigator.platform;

function setPlatform(value: string): void {
  Object.defineProperty(navigator, "platform", { value, configurable: true, writable: true });
}

afterEach(() => setPlatform(originalPlatform));

describe("terminalChord off macOS", () => {
  const all = ["CmdOrCtrl+T", "CmdOrCtrl+Shift+T", "CmdOrCtrl+K", "CmdOrCtrl+Shift+P"];

  it("adds Shift to a bare Ctrl letter", () => {
    setPlatform("Win32");
    expect(terminalChord("CmdOrCtrl+K", all)).toBe("CmdOrCtrl+Shift+K");
  });

  it("adds Shift to Ctrl with [, \\, ] and Space", () => {
    setPlatform("Linux x86_64");
    for (const key of ["[", "\\", "]", "Space"]) {
      expect(terminalChord(`CmdOrCtrl+${key}`, [])).toBe(`CmdOrCtrl+Shift+${key}`);
    }
  });

  it("leaves chords that are not bare Ctrl control keys alone", () => {
    setPlatform("Win32");
    for (const chord of [
      "CmdOrCtrl+,",
      "CmdOrCtrl+1",
      "CmdOrCtrl+Tab",
      "CmdOrCtrl+Alt+]",
      "CmdOrCtrl+Alt+Shift+T",
      "CmdOrCtrl+ArrowLeft",
    ]) {
      expect(terminalChord(chord, [])).toBe(chord);
    }
  });

  it("gives the chord to the lifted action and leaves the displaced one without a key", () => {
    setPlatform("Win32");
    expect(terminalChord("CmdOrCtrl+T", all)).toBe("CmdOrCtrl+Shift+T");
    expect(terminalChord("CmdOrCtrl+Shift+T", all)).toBe("");
    expect(terminalChord("CmdOrCtrl+Shift+P", all)).toBe("CmdOrCtrl+Shift+P");
  });

  it("keeps Ctrl+Shift+C and Ctrl+Shift+V for the terminal's copy and paste", () => {
    setPlatform("Win32");
    expect(terminalChord("CmdOrCtrl+Shift+C", [])).toBe("");
    expect(terminalChord("CmdOrCtrl+Shift+V", [])).toBe("");
    expect(terminalChord("CmdOrCtrl+C", [])).toBe("");
    expect(terminalChord("CmdOrCtrl+V", [])).toBe("");
  });

  it("has no chord for an unbound action", () => {
    setPlatform("Win32");
    expect(terminalChord("", all)).toBe("");
  });
});

describe("terminalChord on macOS", () => {
  it("is the binding itself", () => {
    setPlatform("MacIntel");
    const all = ["CmdOrCtrl+T", "CmdOrCtrl+Shift+T", "CmdOrCtrl+Shift+C"];
    for (const chord of all) expect(terminalChord(chord, all)).toBe(chord);
  });
});

describe("isTerminalBracketKey", () => {
  const base = { key: "[", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };

  it("is a bare Ctrl+[ or Ctrl+]", () => {
    expect(isTerminalBracketKey(base)).toBe(true);
    expect(isTerminalBracketKey({ ...base, key: "]" })).toBe(true);
  });

  it("is not once another modifier is held or the key differs", () => {
    expect(isTerminalBracketKey({ ...base, altKey: true })).toBe(false);
    expect(isTerminalBracketKey({ ...base, shiftKey: true })).toBe(false);
    expect(isTerminalBracketKey({ ...base, metaKey: true })).toBe(false);
    expect(isTerminalBracketKey({ ...base, key: "\\" })).toBe(false);
  });
});
