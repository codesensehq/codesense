// SPDX-License-Identifier: MIT
import type { ClientRect, CollisionDetection, DroppableContainer } from "@dnd-kit/core";
import { describe, expect, it } from "vitest";

import {
  TERMINAL_GRID_DROPPABLE_ID,
  tileFrameId,
  tileZoneId,
} from "@/features/viewer/lib/terminal-drag";
import { EDGE_BANDS, bandRect, resolveZoneAt, type ZoneTile } from "@/shared/tiling";

import { tileZonePriorityCollision } from "./tile-zone-collision";

type Args = Parameters<CollisionDetection>[0];

const clientRect = (r: { left: number; top: number; width: number; height: number }) =>
  ({ ...r, right: r.left + r.width, bottom: r.top + r.height }) as ClientRect;

const container = (id: string, data: Record<string, unknown> = {}) =>
  ({
    id,
    key: id,
    data: { current: data },
    disabled: false,
    node: { current: null },
    rect: { current: null },
  }) as unknown as DroppableContainer;

const TILES: ZoneTile[] = [
  { id: "a", rect: { left: 0, top: 0, width: 400, height: 200 }, disabledSides: ["right"] },
  { id: "b", rect: { left: 400, top: 0, width: 400, height: 200 } },
];
const GRID = { left: 0, top: 0, width: 800, height: 200 };

/** What dnd-kit hands the detector while the tiles' frames and bands are mounted: one frame per
 *  tile carrying its disabled sides, a band per enabled side (drawn from EDGE_BANDS), and the
 *  grid droppable underneath. */
function argsAt(point: { x: number; y: number } | null, tiles = TILES, withGrid = true): Args {
  const containers: DroppableContainer[] = [];
  const rects = new Map<string, ClientRect>();
  if (withGrid) {
    containers.push(container(TERMINAL_GRID_DROPPABLE_ID));
    rects.set(TERMINAL_GRID_DROPPABLE_ID, clientRect(GRID));
  }
  for (const tile of tiles) {
    const frame = tileFrameId(tile.id);
    containers.push(container(frame, { disabledSides: tile.disabledSides ?? [] }));
    rects.set(frame, clientRect(tile.rect));
    for (const band of EDGE_BANDS) {
      if (tile.disabledSides?.includes(band.side)) continue;
      const id = tileZoneId(tile.id, band.side);
      containers.push(container(id));
      rects.set(id, clientRect(bandRect(tile.rect, band)));
    }
  }
  return {
    active: {
      id: "c",
      data: { current: {} },
      rect: { current: { initial: null, translated: null } },
    },
    collisionRect: clientRect({ left: 0, top: 0, width: 1, height: 1 }),
    droppableRects: rects,
    droppableContainers: containers,
    pointerCoordinates: point,
  } as unknown as Args;
}

describe("tileZonePriorityCollision", () => {
  it("keeps its name, which the workbench seam tests find it by", () => {
    expect(tileZonePriorityCollision.name).toBe("tileZonePriorityCollision");
  });

  it("returns the zone resolveZoneAt picks, at every sampled point (a tab drag and a tile drag agree)", () => {
    for (let x = 0; x < 800; x += 10) {
      for (let y = 0; y < 200; y += 5) {
        const point = { x, y };
        const zone = resolveZoneAt(point, TILES);
        const hits = tileZonePriorityCollision(argsAt(point));
        expect(
          hits.map((h) => h.id),
          `${x},${y}`,
        ).toEqual(zone ? [tileZoneId(zone.tileId, zone.side)] : []);
      }
    }
  });

  it("hands back the band's droppable with the hit", () => {
    const [hit] = tileZonePriorityCollision(argsAt({ x: 10, y: 100 }));
    expect(hit.data?.droppableContainer.id).toBe(tileZoneId("a", "left"));
  });

  it("falls back to the grid droppable when no tile frame is mounted (an empty grid)", () => {
    const hits = tileZonePriorityCollision(argsAt({ x: 10, y: 100 }, []));
    expect(hits.map((h) => h.id)).toEqual([TERMINAL_GRID_DROPPABLE_ID]);
  });

  it("finds nothing without a pointer", () => {
    expect(tileZonePriorityCollision(argsAt(null))).toEqual([]);
  });

  it("ignores a stale grid's frames, registered under a private id", () => {
    const args = argsAt({ x: 10, y: 100 }, []);
    const stale = `stale:r1:${tileFrameId("z")}`;
    args.droppableContainers.push(container(stale, { disabledSides: [] }));
    args.droppableRects.set(stale, clientRect({ left: 0, top: 0, width: 400, height: 200 }));
    expect(tileZonePriorityCollision(args).map((h) => h.id)).toEqual([TERMINAL_GRID_DROPPABLE_ID]);
  });
});
