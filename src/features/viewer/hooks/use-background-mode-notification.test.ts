// SPDX-License-Identifier: MIT
import { afterEach, describe, it, expect } from "vitest";

import {
  backgroundModeExplainer,
  shouldShowBackgroundExplainer,
} from "./use-background-mode-notification";
import { restorePlatform, setPlatform } from "@/test/platform";

afterEach(restorePlatform);

describe("shouldShowBackgroundExplainer (SW-AU-34 AC-5 one-shot gate)", () => {
  it("shows on a fresh profile (undefined → true)", () => {
    expect(shouldShowBackgroundExplainer(undefined)).toBe(true);
  });

  it("shows when not yet seen (false → true)", () => {
    expect(shouldShowBackgroundExplainer(false)).toBe(true);
  });

  it("suppresses once seen (true → false)", () => {
    expect(shouldShowBackgroundExplainer(true)).toBe(false);
  });

  it("explains that the app is still running and how to reopen it from the Dock on macOS", () => {
    setPlatform("MacIntel");
    expect(backgroundModeExplainer()).toMatch(/still running/i);
    expect(backgroundModeExplainer()).toMatch(/Click the dock icon to reopen it, or turn on/);
  });

  it("points to the tray icon's menu on Linux", () => {
    setPlatform("Linux x86_64");
    expect(backgroundModeExplainer()).toMatch(/still running/i);
    expect(backgroundModeExplainer()).toMatch(
      /Open it again from the tray icon's menu, or turn on/,
    );
    expect(backgroundModeExplainer()).not.toMatch(/dock/i);
  });
});
