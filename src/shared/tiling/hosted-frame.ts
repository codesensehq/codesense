// SPDX-License-Identifier: MIT
/**
 * Whether a frame lives in a tile, the one read the sites that mean "the pane on the right"
 * check. A dashboard tile frames under the same slot as the right pane, so its slot cannot tell
 * them apart; its place in the tile host's DOM can. With the tiles flag off no host is mounted, and
 * this reads false everywhere whatever the DOM holds.
 */
import { useContext, useSyncExternalStore } from "react";

import { tilesEnabled } from "@/shared/lib/tiles-enabled";

import { TileKeyContext } from "./tile-host";

/** The flag's boot value, once read; off until then. */
let tilesOn = false;
let read: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

/**
 * Reads the flag for the checks here, on first use rather than at import: a module can load
 * before the app's backend answers, and a read then would fail and hold the flag off for the
 * session. The tile host mount awaits this before it mounts, so no frame in a tile is ever
 * checked with the flag unread.
 */
export function readTileFlag(): Promise<boolean> {
  read ??= (async () => {
    try {
      tilesOn = await tilesEnabled();
    } catch {
      // A read that can't be made holds the flag off, as a failed read in `tilesEnabled` does.
      tilesOn = false;
    }
    listeners.forEach((listener) => listener());
    return tilesOn;
  })();
  return read;
}

/** The flag, starting its read: asked only for a frame or component that sits in a tile. */
function flagOn(): boolean {
  void readTileFlag();
  return tilesOn;
}

const flagAsRead = () => tilesOn;

function onFlagRead(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

const TILE_BODY = "[data-tile-body]";

/** A frame as the frame registry holds it, or its element. */
type FrameLike = { element?: Element | null } | Element | null | undefined;

const elementOf = (frame: FrameLike): Element | null =>
  !frame ? null : frame instanceof Element ? frame : (frame.element ?? null);

const tileBodyOf = (frame: FrameLike) => elementOf(frame)?.closest<HTMLElement>(TILE_BODY);

/** Whether `frame` sits in a tile host's body. */
export function isTileHosted(frame: FrameLike): boolean {
  return !!tileBodyOf(frame) && flagOn();
}

/** The same read from inside a component: whether it renders in a tile's body. */
export function useTileHosted(): boolean {
  const inTile = useContext(TileKeyContext) !== null;
  return useSyncExternalStore(onFlagRead, inTile ? flagOn : flagAsRead) && inTile;
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
