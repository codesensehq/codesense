// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";

type Internals = { metadata?: { currentWindow?: { label?: unknown } } };

function plant(internals: Internals | undefined) {
  (window as unknown as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__ = internals;
}

async function fresh() {
  vi.resetModules();
  return import("./current-window");
}

afterEach(() => plant(undefined));

describe("current-window", () => {
  it("is main when there is no Tauri metadata", async () => {
    plant(undefined);
    const { currentWindowLabel, isMainWindow } = await fresh();
    expect(currentWindowLabel()).toBe("main");
    expect(isMainWindow()).toBe(true);
  });

  it("reads a satellite's label from the window metadata, not the URL", async () => {
    window.history.replaceState(null, "", "/?window=main");
    plant({ metadata: { currentWindow: { label: "pane-x" } } });
    const { currentWindowLabel, isMainWindow } = await fresh();
    expect(currentWindowLabel()).toBe("pane-x");
    expect(isMainWindow()).toBe(false);
    window.history.replaceState(null, "", "/");
  });

  it("reads the label once", async () => {
    plant({ metadata: { currentWindow: { label: "pane-x" } } });
    const { isMainWindow } = await fresh();
    expect(isMainWindow()).toBe(false);
    plant({ metadata: { currentWindow: { label: "main" } } });
    expect(isMainWindow()).toBe(false);
  });
});
