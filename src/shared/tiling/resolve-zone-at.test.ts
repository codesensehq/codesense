// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { EDGE_BANDS, bandRect, resolveZoneAt, type ZoneTile } from "./zones";

// Two tiles side by side, 400×200 each, the second one offset so no coordinate is shared.
const A: ZoneTile = { id: "a", rect: { left: 0, top: 0, width: 400, height: 200 } };
const B: ZoneTile = { id: "b", rect: { left: 400, top: 0, width: 400, height: 200 } };
const TILES = [A, B];

describe("resolveZoneAt", () => {
  it.each([
    ["left band", { x: 50, y: 100 }, "left"],
    ["right band", { x: 350, y: 100 }, "right"],
    ["top band", { x: 200, y: 20 }, "top"],
    ["bottom band", { x: 200, y: 180 }, "bottom"],
  ] as const)("resolves the %s interior", (_name, point, side) => {
    expect(resolveZoneAt(point, TILES)).toEqual({ tileId: "a", side });
  });

  it.each([
    ["top-left", { x: 10, y: 10 }, "left"],
    ["bottom-left", { x: 10, y: 190 }, "left"],
    ["top-right", { x: 390, y: 10 }, "right"],
    ["bottom-right", { x: 390, y: 190 }, "right"],
  ] as const)("gives the %s corner to the side band", (_name, point, side) => {
    expect(resolveZoneAt(point, TILES)).toEqual({ tileId: "a", side });
  });

  it("leaves the centre inert", () => {
    expect(resolveZoneAt({ x: 200, y: 100 }, TILES)).toBeNull();
  });

  it("uses half-open bounds at 25% and 75%", () => {
    // x = 100 is 25% of the width: the first column outside the left band, top band starts there.
    expect(resolveZoneAt({ x: 99.99, y: 10 }, TILES)).toEqual({ tileId: "a", side: "left" });
    expect(resolveZoneAt({ x: 100, y: 10 }, TILES)).toEqual({ tileId: "a", side: "top" });
    // x = 300 is 75%: the right band starts there.
    expect(resolveZoneAt({ x: 299.99, y: 10 }, TILES)).toEqual({ tileId: "a", side: "top" });
    expect(resolveZoneAt({ x: 300, y: 10 }, TILES)).toEqual({ tileId: "a", side: "right" });
    // y = 50 is 25% of the height: the centre starts there.
    expect(resolveZoneAt({ x: 200, y: 49.99 }, TILES)).toEqual({ tileId: "a", side: "top" });
    expect(resolveZoneAt({ x: 200, y: 50 }, TILES)).toBeNull();
    // y = 150 is 75%: the bottom band starts there.
    expect(resolveZoneAt({ x: 200, y: 149.99 }, TILES)).toBeNull();
    expect(resolveZoneAt({ x: 200, y: 150 }, TILES)).toEqual({ tileId: "a", side: "bottom" });
    // The tile's own right edge belongs to the next tile.
    expect(resolveZoneAt({ x: 400, y: 100 }, TILES)).toEqual({ tileId: "b", side: "left" });
  });

  it("returns null on a disabled side and never falls through to another", () => {
    const tiles = [{ ...A, disabledSides: ["left"] as const }, B];
    expect(resolveZoneAt({ x: 10, y: 10 }, tiles)).toBeNull();
    expect(resolveZoneAt({ x: 200, y: 10 }, tiles)).toEqual({ tileId: "a", side: "top" });
  });

  it("returns null outside every tile", () => {
    expect(resolveZoneAt({ x: 900, y: 100 }, TILES)).toBeNull();
    expect(resolveZoneAt({ x: 100, y: -1 }, TILES)).toBeNull();
    expect(resolveZoneAt({ x: 100, y: 100 }, [])).toBeNull();
  });

  it("lets the first tile containing the point win", () => {
    const over = { id: "over", rect: A.rect };
    expect(resolveZoneAt({ x: 10, y: 100 }, [over, A])).toEqual({ tileId: "over", side: "left" });
    // The first tile wins even when its zone there is disabled.
    expect(resolveZoneAt({ x: 10, y: 100 }, [{ ...over, disabledSides: ["left"] }, A])).toBeNull();
  });

  it("ignores a collapsed (zero-size) tile", () => {
    const hidden = { id: "hidden", rect: { left: 0, top: 0, width: 0, height: 0 } };
    expect(resolveZoneAt({ x: 0, y: 0 }, [hidden])).toBeNull();
  });
});

describe("EDGE_BANDS parity", () => {
  // Every point of a grid over both tiles resolves to the band whose rect (as the DOM draws it
  // from EDGE_BANDS) contains it, or to null where no band does.
  const inRect = (p: { x: number; y: number }, r: ReturnType<typeof bandRect>) =>
    p.x >= r.left && p.x < r.left + r.width && p.y >= r.top && p.y < r.top + r.height;

  it("matches the band rects at every sampled point", () => {
    for (let x = -10; x <= 810; x += 10) {
      for (let y = -10; y <= 210; y += 5) {
        const point = { x, y };
        let expected: { tileId: string; side: string } | null = null;
        for (const tile of TILES) {
          const band = EDGE_BANDS.find((b) => inRect(point, bandRect(tile.rect, b)));
          if (band) {
            expected = { tileId: tile.id, side: band.side };
            break;
          }
        }
        expect(resolveZoneAt(point, TILES), `${x},${y}`).toEqual(expected);
      }
    }
  });

  it("is the four edges, sides full height and top and bottom over the middle half", () => {
    expect(EDGE_BANDS.map((b) => b.side)).toEqual(["left", "right", "top", "bottom"]);
    const rect = { left: 0, top: 0, width: 100, height: 100 };
    const byside = Object.fromEntries(EDGE_BANDS.map((b) => [b.side, bandRect(rect, b)]));
    expect(byside.left).toEqual({ left: 0, top: 0, width: 25, height: 100 });
    expect(byside.right).toEqual({ left: 75, top: 0, width: 25, height: 100 });
    expect(byside.top).toEqual({ left: 25, top: 0, width: 50, height: 25 });
    expect(byside.bottom).toEqual({ left: 25, top: 75, width: 50, height: 25 });
  });
});
