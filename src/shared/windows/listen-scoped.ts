// SPDX-License-Identifier: MIT
/**
 * The one place the app registers a global Tauri event listener. Every call
 * names its scope, and `listener-inventory.ts` holds a row for each call site
 * (`listener-inventory.test.ts` fails on a raw `listen` import, a call with no
 * row, or a scope that differs from its row):
 *
 * - `main-only` registers only in the `main` window (persist, MCP actions,
 *   pane-open, render replies, path events, app lifecycle);
 * - `every-window` registers in every window (reads that keep a window current:
 *   settings, theme, profile, indexes, the live hub);
 * - `owning-window` registers in every window, and in a satellite calls the
 *   handler only when `owns(payload)` says this window shows what the event is
 *   about (terminal sessions and streams). In `main` it always calls the handler.
 *   With no `owns`, a satellite owns nothing.
 * - `this-window` is `owning-window` registered on this window's own webview
 *   rather than on every target, so an event Rust emits to another window's
 *   label never reaches it, while a broadcast still does (terminal streams,
 *   which Rust emits to the window that subscribed them).
 *
 * No added cost: in `main` the function handed to `listen` is the caller's own
 * handler for every scope, and the result is `listen`'s own promise. Only a
 * satellite wraps an `owning-window` handler, with one `owns` call per event.
 */
import { listen, type EventCallback, type EventName, type UnlistenFn } from "@tauri-apps/api/event";

import { currentWindowLabel, isMainWindow } from "@/shared/lib/current-window";

export type ListenerScope = "main-only" | "every-window" | "owning-window" | "this-window";

const noop: UnlistenFn = () => {};

export function listenScoped<T>(
  event: EventName,
  scope: ListenerScope,
  handler: EventCallback<T>,
  owns?: (payload: T) => boolean,
): Promise<UnlistenFn> {
  let registered = handler;
  if (!isMainWindow()) {
    if (scope === "main-only") return Promise.resolve(noop);
    if (scope === "owning-window" || scope === "this-window") {
      registered = (event) => {
        if (owns?.(event.payload)) return handler(event);
      };
    }
  }
  if (scope === "this-window") {
    return listen(event, registered, {
      target: { kind: "WebviewWindow", label: currentWindowLabel() },
    });
  }
  return listen(event, registered);
}
