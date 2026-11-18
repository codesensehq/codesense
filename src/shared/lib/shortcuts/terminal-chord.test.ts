// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";

import { isTerminalBracketKey, terminalChord, terminalClipboardAction } from "./terminal-chord";
import { restorePlatform, setPlatform } from "@/test/platform";

afterEach(restorePlatform);

describe("terminalChord off macOS", () => {
  const all = ["CmdOrCtrl+T", "CmdOrCtrl+Shift+T", "CmdOrCtrl+K", "CmdOrCtrl+Shift+P"];

  it("adds Shift to a bare Ctrl letter", () => {
    setPlatform("Win32");
    expect(terminalChord("CmdOrCtrl+K", { builtIns: all })).toBe("CmdOrCtrl+Shift+K");
  });

  it("adds Shift to Ctrl with \\ and Space", () => {
    setPlatform("Linux x86_64");
    for (const key of ["\\", "Space"]) {
      expect(terminalChord(`CmdOrCtrl+${key}`, { builtIns: [] })).toBe(`CmdOrCtrl+Shift+${key}`);
    }
  });

  it("gives Ctrl+[ and Ctrl+] no key and leaves Ctrl+Shift+[ and ] alone", () => {
    setPlatform("Win32");
    const all = ["CmdOrCtrl+[", "CmdOrCtrl+]", "CmdOrCtrl+Shift+[", "CmdOrCtrl+Shift+]"];
    expect(terminalChord("CmdOrCtrl+[", { builtIns: all })).toBe("");
    expect(terminalChord("CmdOrCtrl+]", { builtIns: all })).toBe("");
    expect(terminalChord("CmdOrCtrl+Shift+[", { builtIns: all })).toBe("CmdOrCtrl+Shift+[");
    expect(terminalChord("CmdOrCtrl+Shift+]", { builtIns: all })).toBe("CmdOrCtrl+Shift+]");
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
      expect(terminalChord(chord, { builtIns: [] })).toBe(chord);
    }
  });

  it("gives the chord to the lifted action and leaves the displaced one without a key", () => {
    setPlatform("Win32");
    expect(terminalChord("CmdOrCtrl+T", { builtIns: all })).toBe("CmdOrCtrl+Shift+T");
    expect(terminalChord("CmdOrCtrl+Shift+T", { builtIns: all })).toBe("");
    expect(terminalChord("CmdOrCtrl+Shift+P", { builtIns: all })).toBe("CmdOrCtrl+Shift+P");
  });

  it("keeps Ctrl+Shift+C and Ctrl+Shift+V for the terminal's copy and paste", () => {
    setPlatform("Win32");
    expect(terminalChord("CmdOrCtrl+Shift+C", { builtIns: [] })).toBe("");
    expect(terminalChord("CmdOrCtrl+Shift+V", { builtIns: [] })).toBe("");
    expect(terminalChord("CmdOrCtrl+C", { builtIns: [] })).toBe("");
    expect(terminalChord("CmdOrCtrl+V", { builtIns: [] })).toBe("");
  });

  it("has no chord for an unbound action", () => {
    setPlatform("Win32");
    expect(terminalChord("", { builtIns: all })).toBe("");
  });
});

describe("terminalChord on macOS", () => {
  it("is the binding itself", () => {
    setPlatform("MacIntel");
    const all = ["CmdOrCtrl+T", "CmdOrCtrl+Shift+T", "CmdOrCtrl+Shift+C"];
    for (const chord of all) expect(terminalChord(chord, { builtIns: all })).toBe(chord);
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

describe("terminalChord for a dashboard command", () => {
  const builtIns = ["CmdOrCtrl+Shift+H", "CmdOrCtrl+K"];

  it("never takes a built-in's own Ctrl+Shift chord", () => {
    setPlatform("Win32");
    expect(terminalChord("CmdOrCtrl+H", { builtIns }, true)).toBe("");
  });

  it("is not lifted onto the chord another built-in is lifted onto either", () => {
    setPlatform("Win32");
    expect(terminalChord("CmdOrCtrl+Shift+K", { builtIns }, true)).toBe("");
  });

  it("is lifted when no built-in holds the chord", () => {
    setPlatform("Win32");
    expect(terminalChord("CmdOrCtrl+Y", { builtIns }, true)).toBe("CmdOrCtrl+Shift+Y");
  });

  it("keeps the built-in's chord: a built-in lifted over a command wins too", () => {
    setPlatform("Win32");
    expect(terminalChord("CmdOrCtrl+Shift+Y", { builtIns: ["CmdOrCtrl+Y"] }, true)).toBe("");
    expect(terminalChord("CmdOrCtrl+Shift+H", { builtIns }, false)).toBe("CmdOrCtrl+Shift+H");
  });
});

describe("terminalChord between dashboard commands", () => {
  it("lifts the bare Ctrl command over the other's own Ctrl+Shift chord", () => {
    setPlatform("Win32");
    const commands = ["CmdOrCtrl+Y", "CmdOrCtrl+Shift+Y"];
    expect(terminalChord("CmdOrCtrl+Y", { builtIns: [], commands }, true)).toBe(
      "CmdOrCtrl+Shift+Y",
    );
    expect(terminalChord("CmdOrCtrl+Shift+Y", { builtIns: [], commands }, true)).toBe("");
  });
});

describe("terminalClipboardAction", () => {
  const base = { ctrlKey: true, shiftKey: true, metaKey: false, altKey: false };

  it("is copy on Ctrl+Shift+C and paste on Ctrl+Shift+V", () => {
    expect(terminalClipboardAction({ ...base, key: "C", code: "KeyC" })).toBe("copy");
    expect(terminalClipboardAction({ ...base, key: "V", code: "KeyV" })).toBe("paste");
  });

  it("follows the physical key on a layout with no Latin letters", () => {
    expect(terminalClipboardAction({ ...base, key: "С", code: "KeyC" })).toBe("copy");
    expect(terminalClipboardAction({ ...base, key: "М", code: "KeyV" })).toBe("paste");
  });

  it("follows the physical key where the key types a sign, as an Arabic layout does", () => {
    expect(terminalClipboardAction({ ...base, key: "}", code: "KeyC" })).toBe("copy");
    expect(terminalClipboardAction({ ...base, key: "{", code: "KeyV" })).toBe("paste");
  });

  it("does not follow the physical key where the key types another Latin letter", () => {
    expect(terminalClipboardAction({ ...base, key: "K", code: "KeyV" })).toBeNull();
    expect(terminalClipboardAction({ ...base, key: "J", code: "KeyC" })).toBeNull();
    expect(terminalClipboardAction({ ...base, key: "k", code: "KeyV" })).toBeNull();
    expect(terminalClipboardAction({ ...base, key: "j", code: "KeyC" })).toBeNull();
  });

  it("needs Ctrl: Shift alone on C or V is not a clipboard key", () => {
    expect(terminalClipboardAction({ ...base, ctrlKey: false, key: "C", code: "KeyC" })).toBeNull();
    expect(terminalClipboardAction({ ...base, ctrlKey: false, key: "V", code: "KeyV" })).toBeNull();
  });

  it("needs Ctrl and Shift and nothing else", () => {
    expect(terminalClipboardAction({ ...base, shiftKey: false, key: "c" })).toBeNull();
    expect(terminalClipboardAction({ ...base, altKey: true, key: "C" })).toBeNull();
    expect(terminalClipboardAction({ ...base, metaKey: true, key: "C" })).toBeNull();
  });
});
