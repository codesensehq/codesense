// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { registerWindowsE2eControl } from "./e2e-windows-control";

describe("the two-window e2e door", () => {
  beforeEach(() => {
    invoke.mockReset();
    delete window.__CODESENSE_WINDOWS_E2E__;
  });
  afterEach(() => {
    delete window.__CODESENSE_WINDOWS_E2E__;
  });

  it("is absent until the webdriver block registers it", () => {
    expect(window.__CODESENSE_WINDOWS_E2E__).toBeUndefined();
  });

  it("seeds through e2e_seed and returns its answer", async () => {
    invoke.mockResolvedValue({ probeHtml: "/h/c/windows/content/probe.html" });
    registerWindowsE2eControl();
    await expect(window.__CODESENSE_WINDOWS_E2E__!.seed()).resolves.toEqual({
      probeHtml: "/h/c/windows/content/probe.html",
    });
    expect(invoke).toHaveBeenCalledWith("e2e_seed");
  });

  it("opens through e2e_open_window, with or without a probe", async () => {
    invoke.mockResolvedValue("pane-x");
    registerWindowsE2eControl();
    const door = window.__CODESENSE_WINDOWS_E2E__!;
    await expect(door.open({ id: "x" })).resolves.toBe("pane-x");
    await door.open({ id: "y", probe: "/h/probe.html" });
    expect(invoke.mock.calls).toEqual([
      ["e2e_open_window", { id: "x", probe: null }],
      ["e2e_open_window", { id: "y", probe: "/h/probe.html" }],
    ]);
  });
});
