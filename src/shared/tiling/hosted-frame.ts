// SPDX-License-Identifier: MIT
/**
 * Whether a frame lives in a tile, the one read the sites that mean "the pane on the right"
 * check. A dashboard tile frames under the same slot as the right pane, so its slot cannot tell
 * them apart; its place in the tile host's DOM can. With the tiles flag off no host is mounted, and
 * this reads false everywhere whatever the DOM holds.
 */
import { useContext } from "react";

import { tilesEnabled } from "@/shared/lib/tiles-enabled";

import { TileKeyContext } from "./tile-host";

/** The flag's boot value, once read; off until then. */
let tilesOn = false;
void (async () => {
  tilesOn = await tilesEnabled();
})();

const TILE_BODY = "[data-tile-body]";

/** A frame as the frame registry holds it, or its element. */
type FrameLike = { element?: Element | null } | Element | null | undefined;

const elementOf = (frame: FrameLike): Element | null =>
  !frame ? null : frame instanceof Element ? frame : (frame.element ?? null);

const tileBodyOf = (frame: FrameLike) => elementOf(frame)?.closest<HTMLElement>(TILE_BODY);

/** Whether `frame` sits in a tile host's body. */
export function isTileHosted(frame: FrameLike): boolean {
  return tilesOn && !!tileBodyOf(frame);
}

/** The same read from inside a component: whether it renders in a tile's body. */
export function useTileHosted(): boolean {
  return useContext(TileKeyContext) !== null && tilesOn;
}

/** Whether `frame` sits in a tile whose shown tab it is. */
export function isShownInTile(frame: FrameLike): boolean {
  return isTileHosted(frame) && tileBodyOf(frame)?.dataset.tileShown === "true";
}

/** Moves focus into `frame` when its tile shows it. False when the frame is not in a tile or its
 *  tab is not the shown one. */
export function focusTileFrame(frame: FrameLike): boolean {
  const element = elementOf(frame);
  if (!(element instanceof HTMLElement) || !isShownInTile(element)) return false;
  element.focus();
  return true;
}

/** Moves focus out of `frame` onto its tile's shown tab, as Escape does. False when the frame is
 *  not in a tile or its tile draws no tab. */
export function focusTileTab(frame: FrameLike): boolean {
  const body = isTileHosted(frame) ? tileBodyOf(frame) : null;
  const tab = body?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  if (!tab) return false;
  tab.focus();
  return true;
}
