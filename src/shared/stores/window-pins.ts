// SPDX-License-Identifier: MIT
/**
 * A window's pins: at most three tile keys, kept by the group store under
 * `windows.<label>.pins` in the active org's `groups/index.json`, `<label>` the window's Tauri
 * label from `currentWindowLabel()` (`src/shared/lib/current-window.ts`). This is the one way
 * the front end reads and writes them; the store is the one writer of the file.
 *
 * A replace is one write of the whole list. The store refuses a fourth pin (`"fourth"`), keeps
 * nothing with the tiles flag off (`"flag-off"`, and no pins read), and has no folder to keep them
 * in with no active org (`"no-org"`, and no pins read). The file is the org's, so after an org
 * switch a window shows that org's pins; the windows' own registry takes the record over later,
 * through this module.
 */
import { tilesEnabled } from "@/shared/lib/tiles-enabled";
import { windowPinsRead, windowPinsWrite, type WindowPinsRefusal } from "@/tauri/commands";

/** A tile's key: the kit's opaque leaf id (`tileKey` in `src/shared/tiling/tile-key.ts`). */
type TileKey = string;

/** The pins of the window labelled `label`, in order. */
export async function readWindowPins(label: string): Promise<TileKey[]> {
  if (!(await tilesEnabled())) return [];
  return windowPinsRead(label);
}

/** Replaces the pins of the window labelled `label` with `keys`, in one write. */
export async function writeWindowPins(
  label: string,
  keys: TileKey[],
): Promise<{ ok: true } | { refused: WindowPinsRefusal }> {
  if (!(await tilesEnabled())) return { refused: "flag-off" };
  return windowPinsWrite(label, keys);
}
