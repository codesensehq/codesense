// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

const commands = vi.hoisted(() => ({
  windowPinsRead: vi.fn(),
  windowPinsWrite: vi.fn(),
}));
const flag = vi.hoisted(() => ({ on: true }));

vi.mock("@/tauri/commands", () => commands);
vi.mock("@/shared/lib/tiles-enabled", () => ({ tilesEnabled: () => Promise.resolve(flag.on) }));

import { currentWindowLabel } from "@/shared/lib/current-window";
import { readWindowPins, writeWindowPins } from "./window-pins";

const LABEL = currentWindowLabel();

beforeEach(() => {
  flag.on = true;
  commands.windowPinsRead.mockReset().mockResolvedValue(["agent:core/dev"]);
  commands.windowPinsWrite.mockReset().mockResolvedValue({ ok: true });
});

describe("a window's pins", () => {
  it("are read for the window's label", async () => {
    expect(await readWindowPins(LABEL)).toEqual(["agent:core/dev"]);
    expect(commands.windowPinsRead).toHaveBeenCalledWith(LABEL);
  });

  it("are replaced with one write of the whole list", async () => {
    const keys = ["tab_7F3e", "agent:core/dev", "ws-1a2b3c"];
    expect(await writeWindowPins(LABEL, keys)).toEqual({ ok: true });
    expect(commands.windowPinsWrite).toHaveBeenCalledTimes(1);
    expect(commands.windowPinsWrite).toHaveBeenCalledWith(LABEL, keys);
  });

  it("refuse a fourth pin, as the store says", async () => {
    commands.windowPinsWrite.mockResolvedValue({ refused: "fourth" });
    const four = ["a", "b", "c", "d"].map((k) => `ws-${k}`);
    expect(await writeWindowPins(LABEL, four)).toEqual({ refused: "fourth" });
  });

  it("refuse a write with no active org", async () => {
    commands.windowPinsWrite.mockResolvedValue({ refused: "no-org" });
    expect(await writeWindowPins(LABEL, ["ws-1a2b3c"])).toEqual({ refused: "no-org" });
  });

  it("with the tiles flag off, read none and write nothing", async () => {
    flag.on = false;
    expect(await readWindowPins(LABEL)).toEqual([]);
    expect(await writeWindowPins(LABEL, ["ws-1a2b3c"])).toEqual({ refused: "flag-off" });
    expect(commands.windowPinsRead).not.toHaveBeenCalled();
    expect(commands.windowPinsWrite).not.toHaveBeenCalled();
  });
});
