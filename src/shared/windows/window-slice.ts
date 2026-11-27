// SPDX-License-Identifier: MIT
/** Wire types of the window registry (`src-tauri/src/windows/registry.rs`). */
import type { ItemKey } from "./item-key";

/** The label of the app's first window, which owns every item no satellite holds. */
export const MAIN_WINDOW_LABEL = "main";

/** The event a window's new slice arrives on. */
export const WINDOW_SLICE_EVENT = "window:slice";

export type WindowKind = "main" | "satellite";

/** One window's entry, as that window reads it. */
export interface WindowSlice {
  label: string;
  kind: WindowKind;
  /** Bumped on every change; a window ignores a slice older than the one it holds. */
  version: number;
  /** An opaque Layout id, or `null` (a satellite then shows its one item full-window). */
  layoutRef: string | null;
  items: ItemKey[];
  pending: boolean;
  /** `main`'s slice only: every satellite-owned key (canonical string) → its owner. */
  owners?: Record<string, string>;
}

/** `focused` names the window that already held the Layout and was focused instead. */
export interface SetLayoutOutcome {
  focused: string | null;
}
