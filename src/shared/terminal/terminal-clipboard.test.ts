// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

import { copySelectionToClipboard, pasteFromClipboard } from "./terminal-clipboard";

function makeTarget(over: { paste?: (data: string) => void } = {}) {
  return { paste: vi.fn(), ...over };
}

describe("pasteFromClipboard", () => {
  const readText = vi.fn<() => Promise<string>>();

  beforeEach(() => {
    readText.mockReset().mockResolvedValue("");
    Object.defineProperty(navigator, "clipboard", {
      value: { readText },
      configurable: true,
      writable: true,
    });
  });

  it("writes clipboard text to the terminal seam (raw — xterm frames bracketed paste)", async () => {
    readText.mockResolvedValue("clipboard contents");
    const paste = vi.fn();
    await pasteFromClipboard(makeTarget({ paste }));
    expect(paste).toHaveBeenCalledWith("clipboard contents");
  });

  it("does not paste an empty clipboard", async () => {
    readText.mockResolvedValue("");
    const paste = vi.fn();
    await pasteFromClipboard(makeTarget({ paste }));
    expect(paste).not.toHaveBeenCalled();
  });

  it("tolerates a missing Clipboard API without throwing", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const paste = vi.fn();
    await expect(pasteFromClipboard(makeTarget({ paste }))).resolves.toBeUndefined();
    expect(paste).not.toHaveBeenCalled();
  });

  it("swallows a rejected clipboard read (denied / unfocused) without throwing", async () => {
    readText.mockRejectedValue(new Error("not focused"));
    const paste = vi.fn();
    await expect(pasteFromClipboard(makeTarget({ paste }))).resolves.toBeUndefined();
    expect(paste).not.toHaveBeenCalled();
  });
});

describe("copySelectionToClipboard", () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  });

  it("writes the selection to the clipboard", async () => {
    await copySelectionToClipboard({ getSelection: () => "selected" });
    expect(writeText).toHaveBeenCalledWith("selected");
  });

  it("does not write an empty selection", async () => {
    await copySelectionToClipboard({ getSelection: () => "" });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("tolerates a missing Clipboard API without throwing", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    await expect(
      copySelectionToClipboard({ getSelection: () => "selected" }),
    ).resolves.toBeUndefined();
  });

  it("swallows a refused write without throwing", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    await expect(
      copySelectionToClipboard({ getSelection: () => "selected" }),
    ).resolves.toBeUndefined();
  });
});
