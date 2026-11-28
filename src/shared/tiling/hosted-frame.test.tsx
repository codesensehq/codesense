// SPDX-License-Identifier: MIT
/**
 * The frame checks read the tiles flag on first use, not at import: a module can load before the
 * app's backend answers, and a read then would hold the flag off for the session.
 */
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const flag = vi.hoisted(() => ({ read: vi.fn(async () => true) }));
vi.mock("@/shared/lib/tiles-enabled", () => ({ tilesEnabled: flag.read }));

import { isTileHosted, readTileFlag, useTileHosted } from "./hosted-frame";
import { TileKeyContext } from "./tile-host";

function Probe() {
  return <output>{String(useTileHosted())}</output>;
}

describe("the frame checks' flag read", () => {
  it("is not made for a frame or a component outside any tile", () => {
    const frame = document.body.appendChild(document.createElement("iframe"));
    expect(isTileHosted(frame)).toBe(false);
    const { container } = render(<Probe />);
    expect(container.textContent).toBe("false");
    expect(flag.read).not.toHaveBeenCalled();
    frame.remove();
  });

  it("is not made at import, and a component in a tile sees the flag once it is read", async () => {
    expect(flag.read).not.toHaveBeenCalled();
    const { container } = render(
      <TileKeyContext.Provider value="dashboard:team:acme:core/board">
        <Probe />
      </TileKeyContext.Provider>,
    );
    expect(flag.read).toHaveBeenCalledTimes(1);
    await act(() => readTileFlag());
    expect(container.textContent).toBe("true");
    expect(flag.read).toHaveBeenCalledTimes(1);
  });
});

describe("a flag read that can't be made", () => {
  it("holds the flag off, with no unhandled rejection", async () => {
    vi.resetModules();
    flag.read.mockImplementationOnce(() => {
      throw new Error("not mocked");
    });
    const { readTileFlag: read } = await import("./hosted-frame");
    await expect(read()).resolves.toBe(false);
  });
});
