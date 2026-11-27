// SPDX-License-Identifier: MIT
// ---------------------------------------------------------------------------
// The one drop-zone rule. Each tile has four edge bands; a drop on a band splits that tile toward
// that side. The DOM draws the bands from `EDGE_BANDS` and the drag's collision detection asks
// `resolveZoneAt`, so what a user sees highlighted and where a drop lands never disagree.
// ---------------------------------------------------------------------------

/** A drop side on a tile. `center` is a focus-only side: it never splits and has no band. */
export type TileDropSide = "left" | "right" | "top" | "bottom" | "center";

/** The four edge sides, the only sides that produce a split. */
export const TILE_EDGE_SIDES = ["left", "right", "top", "bottom"] as const;
export type TileEdgeSide = (typeof TILE_EDGE_SIDES)[number];

/** One edge band, as fractions of its tile's box. */
export interface EdgeBand {
  side: TileEdgeSide;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The bands, in hit order. Left and right take the outer quarter of the width at full height,
 *  so they win the corners; top and bottom take the outer quarter of the height over the middle
 *  half of the width. The centre is inert. Every band is half-open: it holds its left and top
 *  edges, not its right and bottom ones. */
export const EDGE_BANDS: readonly EdgeBand[] = [
  { side: "left", x: 0, y: 0, w: 0.25, h: 1 },
  { side: "right", x: 0.75, y: 0, w: 0.25, h: 1 },
  { side: "top", x: 0.25, y: 0, w: 0.5, h: 0.25 },
  { side: "bottom", x: 0.25, y: 0.75, w: 0.5, h: 0.25 },
];

export interface ZoneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A tile as the zone rule sees it: its id, its box and the sides it doesn't offer. */
export interface ZoneTile {
  id: string;
  rect: ZoneRect;
  disabledSides?: readonly TileDropSide[];
}

export interface ZoneHit {
  tileId: string;
  side: TileEdgeSide;
}

/** A band's box inside a tile's box. */
export function bandRect(rect: ZoneRect, band: EdgeBand): ZoneRect {
  return {
    left: rect.left + band.x * rect.width,
    top: rect.top + band.y * rect.height,
    width: band.w * rect.width,
    height: band.h * rect.height,
  };
}

const contains = (r: ZoneRect, p: { x: number; y: number }) =>
  p.x >= r.left && p.x < r.left + r.width && p.y >= r.top && p.y < r.top + r.height;

/** The band under `point`, or null. The first tile containing the point decides: a point on its
 *  centre or on a side it disables is null, never a neighbour's band. */
export function resolveZoneAt(
  point: { x: number; y: number },
  tiles: readonly ZoneTile[],
): ZoneHit | null {
  const tile = tiles.find((t) => contains(t.rect, point));
  if (!tile) return null;
  const band = EDGE_BANDS.find((b) => contains(bandRect(tile.rect, b), point));
  if (!band || tile.disabledSides?.includes(band.side)) return null;
  return { tileId: tile.id, side: band.side };
}
