// SPDX-License-Identifier: MIT
import { pointerWithin, type Collision, type CollisionDetection } from "@dnd-kit/core";

import {
  isTileFrameDndId,
  parseTileFrameId,
  tileZoneId,
} from "@/features/viewer/lib/terminal-drag";
import { resolveZoneAt, type TileDropSide, type ZoneTile } from "@/shared/tiling";

/** Prefer a tile's edge band under the pointer, so a directional drop wins over the whole-grid
 *  droppable underneath. The band comes from the tiling kit's one zone rule over each tile's frame
 *  rect, the same rule the drawn bands follow. With tiles but no band under the pointer (a tile's
 *  inert centre, or a side it doesn't offer), there is no valid drop: a workspace never drops INTO
 *  another, only splits at an edge, so the drag snaps back. The whole-grid droppable is the
 *  fallback only with no tile frames at all (an empty grid: the drop opens the first tile). */
export const tileZonePriorityCollision: CollisionDetection = (args) => {
  const point = args.pointerCoordinates;
  if (!point) return [];
  const tiles: ZoneTile[] = [];
  for (const container of args.droppableContainers) {
    const tileId = parseTileFrameId(String(container.id));
    const rect = tileId === null ? undefined : args.droppableRects.get(container.id);
    if (tileId === null || !rect) continue;
    const disabledSides = container.data.current?.disabledSides as
      | readonly TileDropSide[]
      | undefined;
    tiles.push({ id: tileId, rect, disabledSides });
  }
  if (tiles.length === 0) {
    const droppableContainers = args.droppableContainers.filter((c) => !isTileFrameDndId(c.id));
    return pointerWithin({ ...args, droppableContainers });
  }
  const zone = resolveZoneAt(point, tiles);
  if (!zone) return [];
  const id = tileZoneId(zone.tileId, zone.side);
  const band = args.droppableContainers.find((c) => c.id === id);
  if (!band) return [];
  const hit: Collision = { id, data: { droppableContainer: band, value: 0 } };
  return [hit];
};
