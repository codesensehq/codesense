// SPDX-License-Identifier: MIT
// ---------------------------------------------------------------------------
// The layout undo stack: every tile op that changes a workspace's (or a group's) layout calls
// `recordLayoutChange` once, with the layout before and after, and the person's or an agent's
// undo and redo walk those steps back and forth. Pure session data over plain snapshots: the kit
// imports no store, so the viewer store applies the snapshot `undoLayoutChange` and
// `redoLayoutChange` return. A step holds the tree and each tile's tab list, never a tab's content
// or unsaved text, and is never persisted.
// ---------------------------------------------------------------------------

import type { MosaicNode } from "./mosaic-tree";

/** A workspace's or a group's layout at one moment: plain data, no tab content. */
export interface LayoutSnapshot {
  /** The workspace or group the layout belongs to; each key has its own steps. */
  key: string;
  tree: MosaicNode | null;
  /** Each tile's tab ids in order, by tile (leaf) id. */
  tabs: Readonly<Record<string, readonly string[]>>;
}

/** Who made a layout change: the person, or an agent by its id. */
export type LayoutActor = { kind: "person" } | { kind: "agent"; id: string };

/** One recorded change. */
export interface LayoutStep {
  before: LayoutSnapshot;
  after: LayoutSnapshot;
  by: LayoutActor;
}

/** The most steps a key keeps; recording one more drops the oldest. */
export const LAYOUT_UNDO_LIMIT = 50;

interface KeySteps {
  undo: LayoutStep[];
  redo: LayoutStep[];
}

const steps = new Map<string, KeySteps>();

/** Two size lists that differ by no more than float noise. */
const sameSizes = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

function sameTree(a: MosaicNode | null, b: MosaicNode | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.kind === "leaf" || b.kind === "leaf")
    return a.kind === "leaf" && b.kind === "leaf" && a.id === b.id;
  return (
    a.axis === b.axis &&
    a.children.length === b.children.length &&
    sameSizes(a.sizes, b.sizes) &&
    a.children.every((child, i) => sameTree(child, b.children[i]))
  );
}

function sameTabs(a: LayoutSnapshot["tabs"], b: LayoutSnapshot["tabs"]): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((tile) => {
    const x = a[tile];
    const y = b[tile];
    return y !== undefined && x.length === y.length && x.every((tab, i) => tab === y[i]);
  });
}

/** Whether two snapshots are the same layout: same key, tree (sizes within float noise) and tabs. */
function sameLayout(a: LayoutSnapshot, b: LayoutSnapshot): boolean {
  return a.key === b.key && sameTree(a.tree, b.tree) && sameTabs(a.tabs, b.tabs);
}

function copyTree(node: MosaicNode | null): MosaicNode | null {
  if (!node) return null;
  if (node.kind === "leaf") return { kind: "leaf", id: node.id };
  return {
    kind: "split",
    axis: node.axis,
    children: node.children.map((child) => copyTree(child)!),
    sizes: [...node.sizes],
  };
}

/** A copy holding only the snapshot's own fields, so no content a caller passed rides along. */
function copySnapshot(s: LayoutSnapshot): LayoutSnapshot {
  const tabs: Record<string, readonly string[]> = {};
  for (const [tile, list] of Object.entries(s.tabs)) tabs[tile] = [...list];
  return { key: s.key, tree: copyTree(s.tree), tabs };
}

/**
 * Record one layout change by `by`. Every layout op calls this once (the op, never its entry
 * point, so a drop and a key reaching the same op record once). An op whose `before` and `after`
 * are the same layout records nothing. A new step clears the key's redo steps. Returns whether a
 * step was recorded.
 */
export function recordLayoutChange(
  before: LayoutSnapshot,
  after: LayoutSnapshot,
  by: LayoutActor,
): boolean {
  if (before.key !== after.key)
    throw new Error(`a layout change spans two keys: ${before.key} and ${after.key}`);
  if (sameLayout(before, after)) return false;
  let entry = steps.get(before.key);
  if (!entry) {
    entry = { undo: [], redo: [] };
    steps.set(before.key, entry);
  }
  entry.undo.push({
    before: copySnapshot(before),
    after: copySnapshot(after),
    by: by.kind === "agent" ? { kind: "agent", id: by.id } : { kind: "person" },
  });
  if (entry.undo.length > LAYOUT_UNDO_LIMIT) entry.undo.shift();
  entry.redo = [];
  return true;
}

/** The step `undoLayoutChange` would undo for `key`, or null. */
export function nextLayoutUndo(key: string): LayoutStep | null {
  return steps.get(key)?.undo.at(-1) ?? null;
}

/** The step `redoLayoutChange` would redo for `key`, or null. */
export function nextLayoutRedo(key: string): LayoutStep | null {
  return steps.get(key)?.redo.at(-1) ?? null;
}

/**
 * Undo the last step of `current.key` and return the layout to apply, or null when there is
 * nothing to undo. The step applies only while `current` is still the layout it left: when the
 * layout drifted (a change nobody recorded, such as a file tab opened in a tile), the key's steps
 * are cleared and nothing is applied, so an undo never closes a live tab or brings back a closed
 * one.
 */
export function undoLayoutChange(current: LayoutSnapshot): LayoutSnapshot | null {
  return walk(current, "undo");
}

/** Redo the last undone step of `current.key`, under the same rule against the step's `before`. */
export function redoLayoutChange(current: LayoutSnapshot): LayoutSnapshot | null {
  return walk(current, "redo");
}

function walk(current: LayoutSnapshot, direction: "undo" | "redo"): LayoutSnapshot | null {
  const entry = steps.get(current.key);
  const step = entry?.[direction].at(-1);
  if (!entry || !step) return null;
  const from = direction === "undo" ? step.after : step.before;
  if (!sameLayout(current, from)) {
    steps.delete(current.key);
    return null;
  }
  entry[direction].pop();
  entry[direction === "undo" ? "redo" : "undo"].push(step);
  return copySnapshot(direction === "undo" ? step.before : step.after);
}

/** Forget every key's steps, so each test starts empty. */
export function resetLayoutUndoForTests(): void {
  steps.clear();
}
