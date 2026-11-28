// SPDX-License-Identifier: MIT
/**
 * The window this bundle runs in. The app opens one `main` window today; a
 * satellite (`pane-<uuid>`) boots the same bundle with `?window=<label>` as a
 * boot hint, but the label itself is read from the Tauri metadata the webview
 * is created with (`__TAURI_INTERNALS__.metadata.currentWindow.label`), so the
 * mock backend, which maps `?window=` into that metadata, and the real app share
 * one code path.
 *
 * The label is read once, on first use (the mock plants its metadata after the
 * module graph loads), and then kept: it is a constant, never a store or hook,
 * so asking costs nothing and nothing re-renders on it.
 *
 * It is also the one place that takes a window, webview or webview-window
 * handle (`current-window.guard.test.ts`).
 */
import { getCurrentWebview, type Webview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow, type WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";

/** The label of the app's first window, which owns persistence, MCP and pane-open. */
export const MAIN_WINDOW_LABEL = "main";

/** The boot hint a satellite is opened with: `index.html?window=<label>`. */
export const WINDOW_BOOT_PARAM = "window";

interface TauriWindowMetadata {
  __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: unknown } } };
}

let label: string | undefined;

function readLabel(): string {
  if (typeof window === "undefined") return MAIN_WINDOW_LABEL;
  const read = (window as unknown as TauriWindowMetadata).__TAURI_INTERNALS__?.metadata
    ?.currentWindow?.label;
  return typeof read === "string" && read !== "" ? read : MAIN_WINDOW_LABEL;
}

/** This window's Tauri label (`main` when there is no Tauri metadata, as in a test). */
export function currentWindowLabel(): string {
  label ??= readLabel();
  return label;
}

/** True in the `main` window, false in a satellite. */
export function isMainWindow(): boolean {
  return currentWindowLabel() === MAIN_WINDOW_LABEL;
}

/** This window's handle. Every other module reads it here, never from `@tauri-apps/api/window`. */
export function currentWindow(): Window {
  return getCurrentWindow();
}

/** This window's webview handle (drag and drop). */
export function currentWebview(): Webview {
  return getCurrentWebview();
}

/** This window's webview-window handle (listeners aimed at this webview alone). */
export function currentWebviewWindow(): WebviewWindow {
  return getCurrentWebviewWindow();
}

/** Closes this window. */
export function closeCurrentWindow(): Promise<void> {
  return getCurrentWindow().close();
}
