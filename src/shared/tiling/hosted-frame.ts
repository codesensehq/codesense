// SPDX-License-Identifier: MIT
/**
 * Whether a frame lives in a tile, the one read the sites that mean "the pane on the right"
 * check. A dashboard tile frames under the same slot as the right pane, so its slot cannot tell
 * them apart; its place in the tile host's DOM can. With the tiles flag off no host is mounted, so
 * this is false everywhere.
 */
import { useContext } from "react";

import { TileKeyContext } from "./tile-host";

const TILE_BODY = "[data-tile-body]";

/** A frame as the frame registry holds it, or its element. */
type FrameLike = { element?: Element | null } | Element | null | undefined;

const elementOf = (frame: FrameLike): Element | null =>
  !frame ? null : frame instanceof Element ? frame : (frame.element ?? null);

/** Whether `frame` sits in a tile host's body. */
export function isTileHosted(frame: FrameLike): boolean {
  return !!elementOf(frame)?.closest(TILE_BODY);
}

/** The same read from inside a component: whether it renders in a tile's body. */
export function useTileHosted(): boolean {
  return useContext(TileKeyContext) !== null;
}

/** Moves focus into `frame` when its tile shows it. False when the frame is not in a tile or its
 *  tab is not the shown one. */
export function focusTileFrame(frame: FrameLike): boolean {
  const element = elementOf(frame);
  const body = element?.closest<HTMLElement>(TILE_BODY);
  if (!(element instanceof HTMLElement) || body?.dataset.tileShown !== "true") return false;
  element.focus();
  return true;
}

/** Moves focus out of `frame` onto its tile's shown tab, as Escape does. False when the frame is
 *  not in a tile or its tile draws no tab. */
export function focusTileTab(frame: FrameLike): boolean {
  const body = elementOf(frame)?.closest<HTMLElement>(TILE_BODY);
  const tab = body?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  if (!tab) return false;
  tab.focus();
  return true;
}
