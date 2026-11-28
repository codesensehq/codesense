// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";

import {
  formatControlDisplay,
  formatKeystrokeDisplay,
  formatMetaOnlyDisplay,
  formatModifiersDisplay,
  formatModifierClick,
} from "./keystroke";
import { restorePlatform, setPlatform } from "@/test/platform";

afterEach(restorePlatform);

describe("formatControlDisplay (display-only Control)", () => {
  it("renders ⌃ glyphs on macOS", () => {
    setPlatform("MacIntel");
    expect(formatControlDisplay("G")).toBe("⌃G");
    expect(formatControlDisplay("Tab")).toBe("⌃⇥");
    expect(formatControlDisplay("Shift+Tab")).toBe("⌃⇧⇥");
  });

  it.each(["Win32", "Linux x86_64"])("renders Ctrl+ on %s", (platform) => {
    setPlatform(platform);
    expect(formatControlDisplay("G")).toBe("Ctrl+G");
    expect(formatControlDisplay("Tab")).toBe("Ctrl+⇥");
    expect(formatControlDisplay("Shift+Tab")).toBe("Ctrl+Shift+⇥");
  });

  it("returns an empty string for an empty keystroke", () => {
    expect(formatControlDisplay("")).toBe("");
  });
});

describe("formatModifierClick", () => {
  it("renders a glyph-click on macOS", () => {
    setPlatform("MacIntel");
    expect(formatModifierClick("Alt")).toBe("⌥-click");
    expect(formatModifierClick("Shift")).toBe("⇧-click");
    expect(formatModifierClick("CmdOrCtrl")).toBe("⌘-click");
  });

  it.each(["Win32", "Linux x86_64"])("renders Name+click on %s", (platform) => {
    setPlatform(platform);
    expect(formatModifierClick("Alt")).toBe("Alt+click");
    expect(formatModifierClick("Shift")).toBe("Shift+click");
    expect(formatModifierClick("CmdOrCtrl")).toBe("Ctrl+click");
  });
});

describe("the workspace tray's reorder hint", () => {
  it("formats Alt+arrow per platform", () => {
    setPlatform("MacIntel");
    expect(formatKeystrokeDisplay("Alt+ArrowLeft")).toBe("⌥←");
    setPlatform("Win32");
    expect(formatKeystrokeDisplay("Alt+ArrowLeft")).toBe("Alt+←");
  });
});

describe("formatMetaOnlyDisplay (a hint for a key only Cmd serves)", () => {
  it("formats the chord on macOS", () => {
    setPlatform("MacIntel");
    expect(formatMetaOnlyDisplay("CmdOrCtrl+W")).toBe("⌘W");
    expect(formatMetaOnlyDisplay("CmdOrCtrl+Alt+Enter")).toBe("⌘⌥⏎");
  });

  it.each(["Win32", "Linux x86_64"])("is empty on %s, where Ctrl would do nothing", (platform) => {
    setPlatform(platform);
    expect(formatMetaOnlyDisplay("CmdOrCtrl+W")).toBe("");
  });
});

describe("formatModifiersDisplay (the held modifiers before a key)", () => {
  const held = { cmdOrCtrl: true, shift: true, alt: false };

  it("renders glyphs on macOS", () => {
    setPlatform("MacIntel");
    expect(formatModifiersDisplay(held)).toBe("⌘⇧");
  });

  it.each(["Win32", "Linux x86_64"])("renders names ending in + on %s", (platform) => {
    setPlatform(platform);
    expect(formatModifiersDisplay(held)).toBe("Ctrl+Shift+");
    expect(formatModifiersDisplay({ cmdOrCtrl: false, shift: false, alt: false })).toBe("");
  });
});

describe("formatModifiersDisplay with ⌃ held beside ⌘", () => {
  const held = { ctrl: true, cmdOrCtrl: true, shift: true, alt: true };

  it("draws ⌃ before the other glyphs on macOS", () => {
    setPlatform("MacIntel");
    expect(formatModifiersDisplay(held)).toBe("⌃⌘⇧⌥");
    expect(formatModifiersDisplay({ ...held, shift: false })).toBe("⌃⌘⌥");
  });

  it.each(["Win32", "Linux x86_64"])("names Ctrl and Meta on %s", (platform) => {
    setPlatform(platform);
    expect(formatModifiersDisplay(held)).toBe("Ctrl+Meta+Shift+Alt+");
  });

  it("treats ctrl left out as not held", () => {
    setPlatform("MacIntel");
    expect(formatModifiersDisplay({ cmdOrCtrl: true, shift: false, alt: false })).toBe("⌘");
    expect(formatModifiersDisplay({ ctrl: false, cmdOrCtrl: true, shift: false, alt: false })).toBe(
      "⌘",
    );
  });
});

describe("formatControlDisplay beside the ⌃ modifier", () => {
  it("is unchanged: a display-only Control key without ⌘", () => {
    setPlatform("MacIntel");
    expect(formatControlDisplay("Shift+Tab")).toBe("⌃⇧⇥");
    expect(formatKeystrokeDisplay("Ctrl+CmdOrCtrl+Shift+Tab")).toBe("⌃⌘⇧⇥");
  });
});
