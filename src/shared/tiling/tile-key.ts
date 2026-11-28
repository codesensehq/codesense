// SPDX-License-Identifier: MIT
/**
 * The keys a group file's arrangement is held by, beside the file's types
 * (`group-file.generated.ts`) and shared with Rust (`src-tauri/src/groups/tile_key.rs`).
 *
 * - `tabKey(team, path)`: a viewer tab, the window registry's `itemKeyForTab` from
 *   `TabState.path` verbatim. A layout key only; it is not a tile ref.
 * - `tileKey(leaf)`: a tile, the kit's opaque leaf id as it is. Rust checks it with the store's
 *   leaf-id grammar before it is stored; there is no second grammar here.
 *
 * Both sides read the same fixtures: `src-tauri/src/windows/fixtures/item-keys.json` for tab keys
 * and the `tiles` rows of `tests/fixtures/leaf-keys.json` for tile keys.
 */
import { itemKeyForTab, type ItemKey } from "../windows/item-key";
import { leafId, type MosaicNode } from "./mosaic-tree";

/** The key of the tab at `path` in `openTabs[team]`. */
export function tabKey(team: string, path: string): ItemKey {
  return itemKeyForTab(team, { path });
}

/** The key of a tile: its leaf id. */
export function tileKey(leaf: Extract<MosaicNode, { kind: "leaf" }>): string {
  return leafId(leaf);
}
