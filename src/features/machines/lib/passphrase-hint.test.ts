// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import { passphraseDialogHint } from "./passphrase-hint";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("passphraseDialogHint", () => {
  it("names macOS's own dialog on a Mac", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    expect(passphraseDialogHint()).toBe("macOS asks for it in its own dialog.");
  });

  it("names a system dialog elsewhere", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    expect(passphraseDialogHint()).toBe("A system dialog asks for it.");
  });
});
