// SPDX-License-Identifier: MIT
/**
 * The window side of the registry (`src-tauri/src/windows/registry.rs`): a window
 * mounts its `window:slice` listener, then pulls its slice, then calls `window_ready`.
 * Slices arrive in version order per window, but a pull can race a push, so the holder
 * keeps the newest and ignores any slice older than the one it holds.
 */
import type { WindowSlice } from "./window-slice";

export interface SliceHolder {
  /** Takes `slice` when it is newer than the one held; returns whether it did. */
  offer(slice: WindowSlice): boolean;
  current(): WindowSlice | null;
}

export function createSliceHolder(onSlice: (slice: WindowSlice) => void): SliceHolder {
  let held: WindowSlice | null = null;
  return {
    offer(slice) {
      if (held && slice.version <= held.version) return false;
      held = slice;
      onSlice(slice);
      return true;
    },
    current: () => held,
  };
}

export interface RegistryClientDeps {
  label: string;
  /** Mounts the `window:slice` listener; resolves once it is mounted. */
  listen(handler: (slice: WindowSlice) => void): Promise<() => void>;
  getSlice(label: string): Promise<WindowSlice>;
  ready(): Promise<void>;
}

/** Listens, pulls, then reports ready. Resolves to the unlisten function. */
export async function startRegistryClient(
  deps: RegistryClientDeps,
  holder: SliceHolder,
): Promise<() => void> {
  const unlisten = await deps.listen((slice) => {
    if (slice.label === deps.label) holder.offer(slice);
  });
  try {
    holder.offer(await deps.getSlice(deps.label));
    await deps.ready();
  } catch (e) {
    unlisten();
    throw e;
  }
  return unlisten;
}
