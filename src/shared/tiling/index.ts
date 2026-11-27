// SPDX-License-Identifier: MIT
// ---------------------------------------------------------------------------
// The tiling kit: one tree, one renderer and one drag-zone rule for every tile kind. A leaf is an
// opaque id (a terminal, any team's agent, any markdown or HTML doc), so nothing here knows what
// fills a tile, which team it belongs to or which window shows it. The kit imports nothing from
// features or stores; `tiling-kit.guard.test.ts` holds it to that.
// ---------------------------------------------------------------------------

export * from "./mosaic-tree";
export { MosaicView, type MosaicViewProps } from "./mosaic-view";
export { TileGroup, reconcileSizes, type TileLike, type TileRenderContext } from "./tile-group";
