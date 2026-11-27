// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";

const { getTilesEnabled } = vi.hoisted(() => ({ getTilesEnabled: vi.fn() }));
vi.mock("@/tauri/commands", () => ({ getTilesEnabled }));

import { resetTilesEnabledForTests, tilesEnabled } from "./tiles-enabled";

afterEach(() => {
  resetTilesEnabledForTests();
  getTilesEnabled.mockReset();
});

describe("tilesEnabled", () => {
  it("is the app's boot value when it is true", async () => {
    getTilesEnabled.mockResolvedValue(true);
    await expect(tilesEnabled()).resolves.toBe(true);
  });

  it("is false when the app says false", async () => {
    getTilesEnabled.mockResolvedValue(false);
    await expect(tilesEnabled()).resolves.toBe(false);
  });

  it("is false when the command fails or answers something else", async () => {
    getTilesEnabled.mockRejectedValue(new Error("no such command"));
    await expect(tilesEnabled()).resolves.toBe(false);
    resetTilesEnabledForTests();
    getTilesEnabled.mockResolvedValue("true");
    await expect(tilesEnabled()).resolves.toBe(false);
  });

  it("asks the app once and keeps the answer for the session", async () => {
    getTilesEnabled.mockResolvedValue(true);
    const first = tilesEnabled();
    await expect(tilesEnabled()).resolves.toBe(true);
    await expect(first).resolves.toBe(true);
    getTilesEnabled.mockResolvedValue(false);
    await expect(tilesEnabled()).resolves.toBe(true);
    expect(getTilesEnabled).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed read as off rather than asking again", async () => {
    getTilesEnabled.mockRejectedValue(new Error("boom"));
    await expect(tilesEnabled()).resolves.toBe(false);
    getTilesEnabled.mockResolvedValue(true);
    await expect(tilesEnabled()).resolves.toBe(false);
    expect(getTilesEnabled).toHaveBeenCalledTimes(1);
  });
});
