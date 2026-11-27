// SPDX-License-Identifier: MIT
/**
 * Build the `window.__TAURI_INTERNALS__` object that the `@tauri-apps/api`
 * runtime reads. Installing this in mock mode is what keeps the whole Tauri
 * surface — `invoke` (commands), `plugin:event|listen`, and the synchronous
 * `getCurrentWindow()` / `getCurrentWebview()` metadata reads — from throwing
 * `window.__TAURI_INTERNALS__ is undefined` in a plain browser with no Rust.
 *
 * Every backend call funnels through the single `invoke` router, so this shim
 * is the one seam behind which the mock lives — no component or call-site
 * changes anywhere.
 */

import { MAIN_WINDOW_LABEL, WINDOW_BOOT_PARAM } from "@/shared/lib/current-window";

import type { InvokeRouter } from "./mock-router";

export interface TauriInternals {
  metadata: {
    currentWindow: { label: string };
    currentWebview: { label: string };
  };
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  transformCallback: (callback: (payload: unknown) => void, once: boolean) => number;
  unregisterCallback: (id: number) => void;
  convertFileSrc: (filePath: string, protocol?: string) => string;
  /** Invoke a registered callback — how the mock event bus delivers an event. */
  runCallback: (id: number, payload: unknown) => void;
}

/**
 * `search` is the page's query string: a satellite boots with `?window=<label>`, and the real
 * app hands that label to the webview as metadata, so the mock does the same (default `main`).
 */
export function buildTauriInternals(router: InvokeRouter, search = ""): TauriInternals {
  const callbacks = new Map<number, (payload: unknown) => void>();
  let nextCallbackId = 1;
  const label = new URLSearchParams(search).get(WINDOW_BOOT_PARAM) || MAIN_WINDOW_LABEL;

  return {
    metadata: {
      currentWindow: { label },
      currentWebview: { label },
    },
    invoke: (cmd, args) => router(cmd, args),
    // Callbacks are registered to hand back a stable id; only the mock event
    // bus (`runCallback`) ever invokes one — every other surface stays inert.
    transformCallback: (callback) => {
      const id = nextCallbackId++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback: (id) => {
      callbacks.delete(id);
    },
    // Tier 1 is inert, so a resource path just maps to itself — enough for any
    // consumer that only needs a non-throwing string back.
    convertFileSrc: (filePath) => filePath,
    runCallback: (id, payload) => callbacks.get(id)?.(payload),
  };
}
