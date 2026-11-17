// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";

import {
  hasAnyModifier,
  hasCmd,
  hasCommandModifier,
  hasMod,
  hasPlatformMod,
  matchesKeystroke,
  modifiersFrom,
} from "./keystroke";
import { restorePlatform, setPlatform } from "@/test/platform";

afterEach(restorePlatform);

const none = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

describe("mod helpers", () => {
  it("hasMod is Meta or Ctrl", () => {
    expect(hasMod(none)).toBe(false);
    expect(hasMod({ ...none, metaKey: true })).toBe(true);
    expect(hasMod({ ...none, ctrlKey: true })).toBe(true);
    expect(hasMod({ ...none, altKey: true, shiftKey: true })).toBe(false);
  });

  it("hasCmd is the Meta key only", () => {
    expect(hasCmd({ ...none, metaKey: true })).toBe(true);
    expect(hasCmd({ ...none, ctrlKey: true })).toBe(false);
  });

  it("hasPlatformMod is Meta on macOS and Ctrl elsewhere", () => {
    setPlatform("MacIntel");
    expect(hasPlatformMod({ ...none, metaKey: true })).toBe(true);
    expect(hasPlatformMod({ ...none, ctrlKey: true })).toBe(false);
    setPlatform("Win32");
    expect(hasPlatformMod({ ...none, metaKey: true })).toBe(false);
    expect(hasPlatformMod({ ...none, ctrlKey: true })).toBe(true);
  });

  it("hasAnyModifier covers all four modifiers", () => {
    expect(hasAnyModifier(none)).toBe(false);
    for (const k of ["metaKey", "ctrlKey", "altKey", "shiftKey"] as const) {
      expect(hasAnyModifier({ ...none, [k]: true })).toBe(true);
    }
  });

  it("hasCommandModifier ignores Shift", () => {
    expect(hasCommandModifier({ ...none, shiftKey: true })).toBe(false);
    for (const k of ["metaKey", "ctrlKey", "altKey"] as const) {
      expect(hasCommandModifier({ ...none, [k]: true })).toBe(true);
    }
  });

  it("treats a flag left out as not held", () => {
    expect(hasMod({})).toBe(false);
    expect(hasMod({ ctrlKey: true })).toBe(true);
    expect(hasAnyModifier({ shiftKey: true })).toBe(true);
  });
});

describe("modifiersFrom", () => {
  it("returns the four flags of a posted message", () => {
    expect(
      modifiersFrom({ key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }),
    ).toEqual({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: true });
  });

  it("returns null when any flag is not a boolean", () => {
    expect(modifiersFrom({ metaKey: true, ctrlKey: false, altKey: false })).toBeNull();
    expect(
      modifiersFrom({ metaKey: 1, ctrlKey: false, altKey: false, shiftKey: false }),
    ).toBeNull();
  });
});

describe("AltGr", () => {
  function chord(altGraph: boolean): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key: "[", ctrlKey: true, altKey: true });
    Object.defineProperty(event, "getModifierState", {
      value: (name: string) => name === "AltGraph" && altGraph,
    });
    return event;
  }

  it("is never a host shortcut off macOS", () => {
    setPlatform("Win32");
    expect(matchesKeystroke(chord(true), "CmdOrCtrl+Alt+[")).toBe(false);
  });

  it("leaves a real Ctrl+Alt chord alone", () => {
    setPlatform("Win32");
    expect(matchesKeystroke(chord(false), "CmdOrCtrl+Alt+[")).toBe(true);
  });

  it("does not change macOS", () => {
    setPlatform("MacIntel");
    const event = new KeyboardEvent("keydown", { key: "[", metaKey: true, altKey: true });
    Object.defineProperty(event, "getModifierState", { value: () => true });
    expect(matchesKeystroke(event, "CmdOrCtrl+Alt+[")).toBe(true);
  });
});
