// SPDX-License-Identifier: MIT
/**
 * The native menu's one listener, mounted by `App.tsx` and, through the boot inventory, by
 * `satellite-root.tsx`. The Rust side sends `menu:action` with `emit_to` to the one window it
 * picks (`src-tauri/src/windows/focus.rs`), and this registers on this window's own webview
 * handle, which hears only events aimed at its label, so one click runs once.
 *
 * `main` runs every action through `dispatchMenuAction`. A satellite runs an action declared
 * `windowScope: "focused"` itself and forwards the rest (panel toggles, unknown ids, `main`
 * actions) to `main`, once; `main` runs what it is forwarded and never forwards.
 */
import { useEffect } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { dispatchMenuAction } from "@/app/menu-action-dispatch";
import { currentWebviewWindow, isMainWindow, MAIN_WINDOW_LABEL } from "@/shared/lib/current-window";
import { logger } from "@/shared/lib/logger";
import { findShortcutAction } from "@/shared/lib/shortcuts/registry";
import { safeUnlisten } from "@/shared/lib/tauri-listeners";

/** The event a native menu click arrives on. */
export const MENU_ACTION_EVENT = "menu:action";

/** A satellite's half of a menu click: run a `focused` action here, forward the rest to `main`. */
export function dispatchSatelliteMenuAction(id: string): void {
  const action = id.startsWith("panel:") ? undefined : findShortcutAction(id);
  if (action?.windowScope === "focused") {
    dispatchMenuAction(id);
    return;
  }
  emitTo(MAIN_WINDOW_LABEL, MENU_ACTION_EVENT, id).catch((err: unknown) => {
    logger.warn("menu", `forwarding ${id} to main failed — ${String(err)}`);
  });
}

function onMenuAction(id: string): void {
  if (isMainWindow()) dispatchMenuAction(id);
  else dispatchSatelliteMenuAction(id);
}

/** Listens for `menu:action` on this window's webview handle while mounted. */
export function useMenuActionListener(): void {
  // The `cancelled` flag is load-bearing under React StrictMode: the first mount's cleanup runs
  // before `listen` resolves, and a leaked first listener would run each toggle twice.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    Promise.resolve()
      .then(() =>
        currentWebviewWindow().listen<string>(MENU_ACTION_EVENT, (e) => onMenuAction(e.payload)),
      )
      .then((fn) => {
        if (cancelled) safeUnlisten(fn);
        else unlisten = fn;
      })
      .catch((err: unknown) => {
        logger.warn("menu", `${MENU_ACTION_EVENT} listen failed — ${String(err)}`);
      });
    return () => {
      cancelled = true;
      if (unlisten) safeUnlisten(unlisten);
    };
  }, []);
}
