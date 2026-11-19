// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";

import { formatControlDisplay, formatKeystrokeDisplay, formatModifierClick } from "./keystroke";
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
