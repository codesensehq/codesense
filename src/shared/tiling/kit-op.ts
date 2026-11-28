// SPDX-License-Identifier: MIT
/**
 * The kit ops: one variant per tree function the group store applies, plus the window's pin
 * and unpin. A window saves a gesture as ops rather than as a tree, so the store can rebase it
 * onto a newer head (`src-tauri/src/groups/ops.rs` holds the Rust twins). Every tile ref is the
 * kit's opaque leaf id. Types only: `apply-kit-op.ts` checks and runs them.
 */

/** `appendLeaf`: place a leaf opened without a drop. */
interface PlaceOp {
  op: "place";
  leafId: string;
}

/** `splitAt`: split the target's region, putting a new leaf on `side`. */
interface SplitAtOp {
  op: "splitAt";
  targetLeafId: string;
  axis: "row" | "column";
  side: "before" | "after";
  leafId: string;
}

/** `moveLeaf`: move a placed leaf next to `target` (the kit's `TilePlacementTarget`). */
interface MoveOp {
  op: "move";
  leafId: string;
  target: { targetWorkspaceId: string; axis: "row" | "column"; side: "before" | "after" };
}

/** `pruneLeaf`: close a leaf. */
interface CloseOp {
  op: "close";
  leafId: string;
}

/** `setNodeSizes`: new sizes for the split at `path` (`[]` is the root). */
interface ResizeOp {
  op: "resize";
  path: number[];
  sizes: number[];
}

/** `swapLeaves`: exchange two leaves' places. */
interface SwapOp {
  op: "swap";
  a: string;
  b: string;
}

/** `evenSizes`: even out the split at `path`, or every split. */
interface EvenOutOp {
  op: "evenOut";
  path?: number[];
}

/** `replaceLeafWorkspaceId`: put another leaf in a leaf's place. */
interface ReplaceOp {
  op: "replace";
  from: string;
  to: string;
}

/** Pin a tile to the window (at most 3); not a tree op. */
interface PinOp {
  op: "pin";
  leafId: string;
}

/** Unpin a tile from the window; not a tree op. */
interface UnpinOp {
  op: "unpin";
  leafId: string;
}

export type KitOp =
  | PlaceOp
  | SplitAtOp
  | MoveOp
  | CloseOp
  | ResizeOp
  | SwapOp
  | EvenOutOp
  | ReplaceOp
  | PinOp
  | UnpinOp;
