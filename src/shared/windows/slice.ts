// SPDX-License-Identifier: MIT
/**
 * The registry slice this window shows, as the satellite boot reads it. A slice
 * source hands it over (a stub in tests, an e2e probe, the window registry's
 * `window_get_slice` in the app); `satellite-root.tsx` installs that source here
 * so the boot rows can ask which workspaces this window holds.
 *
 * The shape is the part of the registry's `WindowSlice` this boot reads, so the
 * registry's own slice satisfies it unchanged.
 *
 * In `main` nothing is installed and every helper answers for the whole app: main
 * owns every terminal. In a satellite they answer only for the slice's
 * workspaces, and a slice holds no `workspace` item yet, so today a satellite
 * owns no terminal at all.
 */
import { isMainWindow } from "@/shared/lib/current-window";

import type { ItemKey } from "./item-key";

/** The item kind of a workspace tile. No slice holds one yet. */
const WORKSPACE_ITEM_KIND = "workspace";

export interface SliceView {
  label: string;
  /** An opaque layout id, or `null`: the window then shows its one item. */
  layoutRef: string | null;
  items: readonly ItemKey[];
  /** The window is a move's target that has not committed yet. */
  pending?: boolean;
  /** The window's number: 1 for `main`. */
  number?: number;
  /** A pending move's target only: the item it waits for and where it comes from. */
  incoming?: { key: ItemKey; fromNumber: number };
}

export interface SliceSource {
  current(): SliceView | null;
  /** Calls `onChange` whenever `current()` changes; returns the unsubscribe. */
  subscribe(onChange: () => void): () => void;
}

/** A source with no slice, for a satellite booted before its registry entry exists. */
export const EMPTY_SLICE_SOURCE: SliceSource = {
  current: () => null,
  subscribe: () => () => {},
};

const NO_IDS: readonly string[] = Object.freeze([]);

let installed: SliceSource = EMPTY_SLICE_SOURCE;
let locateSession: (sessionId: string) => string | undefined = () => undefined;
let readFrom: SliceView | null | undefined;
let ids: readonly string[] = NO_IDS;

/** Makes `source` this window's slice; returns the uninstall. */
export function installSliceSource(source: SliceSource): () => void {
  installed = source;
  readFrom = undefined;
  return () => {
    if (installed !== source) return;
    installed = EMPTY_SLICE_SOURCE;
    readFrom = undefined;
  };
}

/** How a session is placed in its workspace (the viewer store's tab index). Set by the
 *  boot rows, so this module stays clear of the viewer store. */
export function setSessionLocator(locate: (sessionId: string) => string | undefined): void {
  locateSession = locate;
}

/** The installed source, for a hook that re-renders when the slice changes. */
export function sliceSource(): SliceSource {
  return installed;
}

/** The workspace ids this window's slice holds: `[]` in a satellite until a slice
 *  carries `workspace` items. The same array while the slice is unchanged. */
export function sliceWorkspaceIds(): readonly string[] {
  const slice = installed.current();
  if (slice === readFrom) return ids;
  readFrom = slice;
  const next = (slice?.items ?? [])
    .filter((item) => item.kind === WORKSPACE_ITEM_KIND)
    .map((item) => item.id);
  ids = next.length === 0 ? NO_IDS : next;
  return ids;
}

/** True when this window shows the terminal session `sessionId`: always in `main`;
 *  in a satellite, when its tab lives in one of the slice's workspaces. This is
 *  the `owns` of the `owning-window` terminal listeners. */
export function ownsSession(sessionId: unknown): boolean {
  if (isMainWindow()) return true;
  if (typeof sessionId !== "string" || sessionId === "") return false;
  const workspaces = sliceWorkspaceIds();
  if (workspaces.length === 0) return false;
  const workspaceId = locateSession(sessionId);
  return workspaceId !== undefined && workspaces.includes(workspaceId);
}

/** For a terminal event that names no session (a layout change, an admission):
 *  true in `main`, and in a satellite while its slice holds any workspace. */
export function ownsTerminalLayout(): boolean {
  return isMainWindow() || sliceWorkspaceIds().length > 0;
}

/** `index` cut to the workspaces this window shows: unchanged in `main`. */
export function sliceTerminalIndex<T>(
  index: Record<string, Record<string, T>>,
): Record<string, Record<string, T>> {
  if (isMainWindow()) return index;
  const workspaces = sliceWorkspaceIds();
  const cut: Record<string, Record<string, T>> = {};
  for (const [team, byWorkspace] of Object.entries(index)) {
    for (const [workspaceId, tabs] of Object.entries(byWorkspace)) {
      if (!workspaces.includes(workspaceId)) continue;
      (cut[team] ??= {})[workspaceId] = tabs;
    }
  }
  return cut;
}
