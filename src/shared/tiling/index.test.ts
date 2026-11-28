// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import * as kit from "./index";

describe("tiling kit exports", () => {
  it.each([
    // Tree ops.
    "seedTreeFromFlat",
    "leafId",
    "leafWorkspaceIds",
    "findLeafPath",
    "splitAt",
    "moveLeaf",
    "appendLeaf",
    "pruneLeaf",
    "reconcileMosaic",
    "dedupeLeaves",
    "setNodeSizes",
    "replaceLeafWorkspaceId",
    "sameMosaicStructure",
    "placementChangesLayout",
    "balancedColsRows",
    "clampedGridShape",
    "buildPresetTree",
    "buildBalancedGrid",
    "reconcilePresetTree",
    "parseMosaicNode",
    "serializeMosaicNode",
    "swapLeaves",
    "evenSizes",
    // The layout undo stack.
    "recordLayoutChange",
    "undoLayoutChange",
    "redoLayoutChange",
    "nextLayoutUndo",
    "nextLayoutRedo",
    "LAYOUT_UNDO_LIMIT",
    // Views.
    "MosaicView",
    "TileGroup",
    "reconcileSizes",
    // Zones and render stability.
    "EDGE_BANDS",
    "bandRect",
    "resolveZoneAt",
    "stabilizeTree",
  ])("exports %s", (name) => {
    expect(kit).toHaveProperty(name);
    expect((kit as Record<string, unknown>)[name]).toBeDefined();
  });

  it("carries no caption: a tile kind draws its own", () => {
    expect(Object.keys(kit).filter((k) => /caption/i.test(k))).toEqual([]);
  });
});
