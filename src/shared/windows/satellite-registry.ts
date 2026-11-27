// SPDX-License-Identifier: MIT
/**
 * A satellite's registry client: its slice source for `satellite-root.tsx`, read from
 * `window_get_slice` and `window:slice`, and its side of a move (`hand-off.ts`). The move
 * listeners mount before the client reports ready, so a hand-off can never arrive unheard.
 */
import { windowGetSlice, windowHandOffAck, windowReady } from "@/tauri/commands";
import { currentWebviewWindow, currentWindowLabel } from "@/shared/lib/current-window";
import { logger } from "@/shared/lib/logger";
import { safeUnlisten } from "@/shared/lib/tauri-listeners";
import { createHandOff, createReleasedItems, type ReleasedItems } from "./hand-off";
import { createSliceHolder, startRegistryClient } from "./registry-client";
import type { SliceSource } from "./slice";
import {
  HAND_OFF_EVENT,
  MOVE_ABORTED_EVENT,
  WINDOW_SLICE_EVENT,
  type HandOffRequest,
  type MoveAborted,
  type WindowSlice,
} from "./window-slice";

export interface SatelliteRegistry {
  source: SliceSource;
  released: ReleasedItems;
}

/** Starts this satellite's registry client and move listeners. */
export function startSatelliteRegistry(label = currentWindowLabel()): SatelliteRegistry {
  const released = createReleasedItems();
  const listeners = new Set<() => void>();
  const holder = createSliceHolder((slice) => {
    released.keepOnly(slice.items);
    for (const listener of listeners) listener();
  });
  const source: SliceSource = {
    current: () => holder.current(),
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  const handOff = createHandOff(released.side, windowHandOffAck);
  void (async () => {
    await currentWebviewWindow().listen<HandOffRequest>(HAND_OFF_EVENT, (event) => {
      void handOff.onHandOff(event.payload);
    });
    await currentWebviewWindow().listen<MoveAborted>(MOVE_ABORTED_EVENT, (event) =>
      handOff.onAborted(event.payload),
    );
    await startRegistryClient(
      {
        label,
        listen: async (handler) => {
          const off = await currentWebviewWindow().listen<WindowSlice>(
            WINDOW_SLICE_EVENT,
            (event) => handler(event.payload),
          );
          return () => safeUnlisten(off);
        },
        getSlice: windowGetSlice,
        ready: windowReady,
      },
      holder,
    );
  })().catch((e) =>
    logger.warn("windows", `satellite registry client did not start: ${String(e)}`),
  );
  return { source, released };
}
