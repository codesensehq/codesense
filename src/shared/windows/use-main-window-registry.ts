// SPDX-License-Identifier: MIT
/**
 * `main`'s registry client: mount the `window:slice` listener, pull `main`'s slice,
 * then report ready. Each slice feeds `main`'s owner map. A satellite's boot starts its
 * own client.
 */
import { useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { windowGetSlice, windowReady } from "@/tauri/commands";
import { logger } from "@/shared/lib/logger";
import { safeUnlisten } from "@/shared/lib/tauri-listeners";
import { mainSlice } from "./owner-map";
import { startRegistryClient } from "./registry-client";
import { MAIN_WINDOW_LABEL, WINDOW_SLICE_EVENT, type WindowSlice } from "./window-slice";

export function useMainWindowRegistry() {
  useEffect(() => {
    let stopped = false;
    let unlisten: (() => void) | null = null;
    startRegistryClient(
      {
        label: MAIN_WINDOW_LABEL,
        listen: async (handler) => {
          const off = await getCurrentWebviewWindow().listen<WindowSlice>(
            WINDOW_SLICE_EVENT,
            (event) => handler(event.payload),
          );
          return () => safeUnlisten(off);
        },
        getSlice: windowGetSlice,
        ready: windowReady,
      },
      mainSlice,
    ).then(
      (off) => {
        if (stopped) off();
        else unlisten = off;
      },
      (e) => logger.warn("windows", `main registry client did not start: ${String(e)}`),
    );
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, []);
}
