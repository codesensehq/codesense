// SPDX-License-Identifier: MIT
/**
 * PT-13 — restore-by-drag: dragging a minimized workspace card onto the
 * terminal grid restores it as a live split tile. This module holds the small
 * pure pieces shared by the drag source (the panel), the drop target (the
 * terminal grid), and the `DndContext` owner (the team view) so they can't
 * disagree on the droppable id or the drop semantics.
 */

/** dnd-kit droppable id for the terminal grid. */
export const TERMINAL_GRID_DROPPABLE_ID = "terminal-grid";

import { TILE_EDGE_SIDES, type TileDropSide, type TileEdgeSide } from "@/shared/tiling";

type DndId = string | number | null | undefined;

// ---------------------------------------------------------------------------
// SW-EW-33 — the bottom tray's chips and the in-mosaic tiles both represent the
// same workspaces inside ONE DndContext. An on-screen workspace's tile already
// registers `useDraggable({ id: ws.id })`, so a tray chip MUST NOT reuse the raw
// id (dnd-kit collision). Tray chips use the namespaced id `tray:{workspaceId}`;
// every site that turns an active drag id back into a workspace id unwraps it.
// ---------------------------------------------------------------------------

const TRAY_CHIP_PREFIX = "tray:";

/** dnd-kit draggable id for a tray chip (namespaced to avoid colliding with the
 *  in-mosaic tile draggable for the same workspace). */
export function trayChipDragId(workspaceId: string): string {
  return `${TRAY_CHIP_PREFIX}${workspaceId}`;
}

/** Whether an active drag id is a tray chip's (as opposed to an in-mosaic tile's). */
export function isTrayChipDragId(activeId: DndId): boolean {
  return String(activeId ?? "").startsWith(TRAY_CHIP_PREFIX);
}

/** Strip the `tray:` namespace from an active drag id, yielding the bare
 *  workspace id. A non-tray id (an in-mosaic tile) passes through unchanged. */
export function unwrapDragWorkspaceId(activeId: DndId): string {
  const s = String(activeId ?? "");
  return isTrayChipDragId(s) ? s.slice(TRAY_CHIP_PREFIX.length) : s;
}

/**
 * Resolve a dnd-kit drag-end into the workspace id to restore, or `null` when
 * the card was not dropped on the terminal grid. Pure — the gesture's only
 * logic; the caller routes a non-null result through `reopenSoftClosedWorkspace`
 * (the same action as click-restore).
 */
export function dragEndToReopen(activeId: DndId, overId: DndId): string | null {
  if (overId !== TERMINAL_GRID_DROPPABLE_ID) return null;
  if (activeId == null || activeId === "") return null;
  return unwrapDragWorkspaceId(activeId);
}

// ---------------------------------------------------------------------------
// SW-EW-17 — directional drag-split: each foreground tile exposes five drop
// zones (the four outer edge bands + a center). A drop on an edge splits that
// tile's region; a center drop just focuses it. The zone id grammar is
// `tile:{workspaceId}:{side}` — parsed back into a structural placement so the
// resolver stays pure (no geometry, no store) like `dragEndToReopen`.
// ---------------------------------------------------------------------------

// The sides and their bands are the tiling kit's; the drag ids built on them stay here.
export { TILE_EDGE_SIDES, type TileDropSide, type TileEdgeSide };

const TILE_ZONE_PREFIX = "tile:";
const TILE_SIDES: readonly TileDropSide[] = [...TILE_EDGE_SIDES, "center"];

/** Map an edge side to its structural split placement: which axis the split runs
 *  on (left/right → row, top/bottom → column) and which side of the target the
 *  new pane lands (left/top → before, right/bottom → after). Single source shared
 *  by the drop-zone resolver and the panel's no-op-suppression sweep so the two
 *  can never disagree on what an edge means. */
export function tileEdgePlacement(side: TileEdgeSide): {
  axis: "row" | "column";
  side: "before" | "after";
} {
  const axis = side === "left" || side === "right" ? "row" : "column";
  const dir = side === "left" || side === "top" ? "before" : "after";
  return { axis, side: dir };
}

/** Build the dnd-kit droppable id for one edge zone of a tile. */
export function tileZoneId(workspaceId: string, side: TileDropSide): string {
  return `${TILE_ZONE_PREFIX}${workspaceId}:${side}`;
}

const TILE_FRAME_PREFIX = "tile-frame:";

/** The droppable spanning a whole tile while a drag is on. It carries the tile's disabled sides,
 *  so the collision detection can resolve every band from one rect per tile. */
export function tileFrameId(workspaceId: string): string {
  return `${TILE_FRAME_PREFIX}${workspaceId}`;
}

/** Whether a droppable id is a tile frame, a stale grid's privately wrapped ones included. Frames
 *  only report geometry: none is ever a drop target. */
export function isTileFrameDndId(id: DndId): boolean {
  return (
    typeof id === "string" &&
    (id.startsWith(TILE_FRAME_PREFIX) || id.includes(`:${TILE_FRAME_PREFIX}`))
  );
}

/** The tile behind a frame droppable's id, or null for any other id (a stale grid's private ids
 *  included). */
export function parseTileFrameId(id: DndId): string | null {
  return typeof id === "string" && id.startsWith(TILE_FRAME_PREFIX)
    ? id.slice(TILE_FRAME_PREFIX.length)
    : null;
}

/** Parse a tile-zone id back into `{ workspaceId, side }`, or null if it isn't
 *  one. The side is the final `:`-segment so workspace ids may contain dashes. */
export function parseTileZoneId(id: DndId): { workspaceId: string; side: TileDropSide } | null {
  if (typeof id !== "string" || !id.startsWith(TILE_ZONE_PREFIX)) return null;
  const body = id.slice(TILE_ZONE_PREFIX.length);
  const lastColon = body.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const workspaceId = body.slice(0, lastColon);
  const side = body.slice(lastColon + 1) as TileDropSide;
  if (!workspaceId || !TILE_SIDES.includes(side)) return null;
  return { workspaceId, side };
}

/** A directional placement target, or a focus-only center drop. */
export type TilePlacementResult =
  | {
      workspaceId: string;
      target: { targetWorkspaceId: string; axis: "row" | "column"; side: "before" | "after" };
    }
  | { workspaceId: string; target: { center: true } };

/**
 * Resolve a dnd-kit drag-end over a tile edge zone into a structural placement.
 * left/right → vertical split (row axis); top/bottom → horizontal split (column
 * axis); left/top → before, right/bottom → after; center → focus only. Returns
 * null for the legacy grid droppable or an empty active id. Pure — the caller
 * routes the result through `placeWorkspaceTile` / `reopenSoftClosedWorkspace`.
 */
export function resolveTilePlacement(activeId: DndId, overId: DndId): TilePlacementResult | null {
  if (activeId == null || activeId === "") return null;
  const zone = parseTileZoneId(overId);
  if (!zone) return null;
  const workspaceId = unwrapDragWorkspaceId(activeId);
  if (zone.side === "center") return { workspaceId, target: { center: true } };
  const { axis, side } = tileEdgePlacement(zone.side);
  return { workspaceId, target: { targetWorkspaceId: zone.workspaceId, axis, side } };
}
