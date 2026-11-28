// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";

import {
  hasAnyModifier,
  hasCmd,
  hasCommandModifier,
  hasCtrlAndCmd,
  hasMod,
  hasPlatformMod,
  isCtrlChordUnavailable,
  keydownEvent,
  matchesKeystroke,
  modifiersFrom,
} from "./keystroke";
import { restorePlatform, setPlatform } from "@/test/platform";
import { keydown } from "@/test/keydown";

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

  it("hasCtrlAndCmd is Meta and Ctrl held together, on every platform", () => {
    expect(hasCtrlAndCmd(none)).toBe(false);
    expect(hasCtrlAndCmd({ ...none, metaKey: true })).toBe(false);
    expect(hasCtrlAndCmd({ ...none, ctrlKey: true })).toBe(false);
    expect(hasCtrlAndCmd({ metaKey: true, ctrlKey: true })).toBe(true);
    setPlatform("Win32");
    expect(hasCtrlAndCmd({ metaKey: true, ctrlKey: true })).toBe(true);
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
  const chord = (altGraph: boolean) =>
    keydown({ key: "[", ctrlKey: true, altKey: true }, { altGraph });

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
    const event = keydown({ key: "[", metaKey: true, altKey: true }, { altGraph: true });
    expect(matchesKeystroke(event, "CmdOrCtrl+Alt+[")).toBe(true);
  });
});

describe("keydownEvent", () => {
  it("answers AltGraph from modifierAltGraph, not from the Alt key", () => {
    const init = { key: "[", code: "Digit8", ctrlKey: true, altKey: true };
    expect(keydownEvent({ ...init, modifierAltGraph: true }).getModifierState("AltGraph")).toBe(
      true,
    );
    expect(keydownEvent({ ...init, modifierAltGraph: false }).getModifierState("AltGraph")).toBe(
      false,
    );
    expect(keydownEvent(init).getModifierState("AltGraph")).toBe(false);
  });

  it("keeps the init's key, code and modifiers", () => {
    const event = keydownEvent({
      key: "[",
      code: "Digit8",
      ctrlKey: true,
      altKey: true,
      modifierAltGraph: true,
    });
    expect(event.type).toBe("keydown");
    expect(event).toMatchObject({
      key: "[",
      code: "Digit8",
      metaKey: false,
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
    });
    expect(event.getModifierState("Control")).toBe(true);
    expect(event.getModifierState("Shift")).toBe(false);
  });

  it("is what the matcher refuses off macOS and accepts on macOS", () => {
    setPlatform("Linux x86_64");
    const altGr = { key: "[", code: "Digit8", ctrlKey: true, altKey: true };
    expect(
      matchesKeystroke(keydownEvent({ ...altGr, modifierAltGraph: true }), "CmdOrCtrl+Alt+["),
    ).toBe(false);
    expect(matchesKeystroke(keydownEvent(altGr), "CmdOrCtrl+Alt+[")).toBe(true);
    setPlatform("MacIntel");
    const mac = { key: "[", code: "Digit8", metaKey: true, altKey: true, modifierAltGraph: true };
    expect(matchesKeystroke(keydownEvent(mac), "CmdOrCtrl+Alt+[")).toBe(true);
  });
});

describe("isCtrlChordUnavailable", () => {
  it("is true for a Ctrl chord off macOS and false on macOS", () => {
    setPlatform("Linux x86_64");
    expect(isCtrlChordUnavailable("Ctrl+CmdOrCtrl+Alt+A")).toBe(true);
    expect(isCtrlChordUnavailable("CmdOrCtrl+Alt+A")).toBe(false);
    setPlatform("MacIntel");
    expect(isCtrlChordUnavailable("Ctrl+CmdOrCtrl+Alt+A")).toBe(false);
  });

  it("does not throw on a capture that does not parse, such as a bare + key", () => {
    setPlatform("Linux x86_64");
    expect(isCtrlChordUnavailable("CmdOrCtrl++")).toBe(false);
    expect(isCtrlChordUnavailable("+")).toBe(false);
  });
});
