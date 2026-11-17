// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";

import { hasAnyModifier, hasCmd, hasCommandModifier, hasMod, hasPlatformMod } from "./keystroke";

const originalPlatform = navigator.platform;

function setPlatform(value: string): void {
  Object.defineProperty(navigator, "platform", { value, configurable: true, writable: true });
}

afterEach(() => setPlatform(originalPlatform));

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
});
