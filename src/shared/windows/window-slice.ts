// SPDX-License-Identifier: MIT
/** Wire types of the window registry (`src-tauri/src/windows/registry.rs`). */
import type { ItemKey } from "./item-key";

/** The event a window's new slice arrives on. */
export const WINDOW_SLICE_EVENT = "window:slice";

type WindowKind = "main" | "satellite";

/** The item a pending move's target waits for, and the window it comes from. */
export interface Incoming {
  key: ItemKey;
  fromNumber: number;
}

/** One window's entry, as that window reads it. */
export interface WindowSlice {
  label: string;
  kind: WindowKind;
  /** The window's number: 1 for `main`, the lowest free from 2 for a satellite. */
  number: number;
  /** Bumped on every change; a window ignores a slice older than the one it holds. */
  version: number;
  /** An opaque Layout id, or `null` (a satellite then shows its one item full-window). */
  layoutRef: string | null;
  items: ItemKey[];
  pending: boolean;
  /** A pending move's target only. */
  incoming?: Incoming;
  /** `main`'s slice only: every satellite-owned key (canonical string) → its owner. */
  owners?: Record<string, string>;
}

/** `focused` names the window that already held the Layout and was focused instead. */
export interface SetLayoutOutcome {
  focused: string | null;
}

/** To a move's source: flush the item, let it go and ack (`src-tauri/src/windows/moves.rs`). */
export const HAND_OFF_EVENT = "window:hand-off";

/** To a move's source: the move ended without a commit. */
export const MOVE_ABORTED_EVENT = "window:move-aborted";

/** To `main`: items it owns again, to open. */
export const ITEMS_RETURNED_EVENT = "window:items-returned";

export interface HandOffRequest {
  key: ItemKey;
  moveId: string;
  /** How long the source may take to flush and let go. */
  budgetMs: number;
}

export interface MoveAborted {
  key: ItemKey;
  moveId: string;
  /** `dirty`, `gone`, `timeout`, `no_ack`, `window_failed`, or an `abort_all_moves` reason. */
  reason: string;
}

export interface ItemsReturned {
  items: ItemKey[];
  reason: string;
}

export interface HandOffAck {
  moveId: string;
  ok: boolean;
  reason?: string;
}

/** The answer to `window_move_item`. A refusal's reason is `stale`, `moving`,
 *  `pending_target`, `self`, `unknown_target`, `tiles_off`, `window_failed` or a kind
 *  check's own. */
export type MoveStart =
  | { status: "started"; moveId: string; target: string }
  | { status: "refused"; reason: string };

export type AckOutcome = "committed" | "aborted" | "ignored";
