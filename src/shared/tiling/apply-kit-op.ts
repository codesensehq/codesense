// SPDX-License-Identifier: MIT
/**
 * Checking and running a kit op (`kit-op.ts`) on a tree. `kitOpProblem` and `applyKitOp` are
 * the twins of `parse_op` and `apply` in `src-tauri/src/groups/ops.rs`, and both sides read the
 * one table `tests/fixtures/kit-ops.json`, so a window and the group store compute the same
 * tree from the same op.
 *
 * An op that can't run (its leaf or split is gone, or the leaf it adds is already placed)
 * returns `KIT_OP_FAILED`. Closing a leaf that is gone and placing one already there succeed and
 * change nothing.
 */
import type { KitOp } from "./kit-op";
import {
  appendLeaf,
  evenSizes,
  findLeafPath,
  moveLeaf,
  pruneLeaf,
  replaceLeafWorkspaceId,
  setNodeSizes,
  splitAt,
  swapLeaves,
  type MosaicNode,
} from "./mosaic-tree";

/** The result of an op that can't run on the tree it was given. */
export const KIT_OP_FAILED = Symbol("kit op failed");

const PATH_MAX = 64;
const INDEX_MAX = 4096;

/** The keys each op holds besides `op`: required, then optional. */
const KEYS: Record<KitOp["op"], [string[], string[]]> = {
  place: [["leafId"], []],
  close: [["leafId"], []],
  pin: [["leafId"], []],
  unpin: [["leafId"], []],
  splitAt: [["targetLeafId", "axis", "side", "leafId"], []],
  move: [["leafId", "target"], []],
  resize: [["path", "sizes"], []],
  swap: [["a", "b"], []],
  evenOut: [[], ["path"]],
  replace: [["from", "to"], []],
};

const isRef = (v: unknown) => typeof v === "string" && v !== "";
const isAxis = (v: unknown) => v === "row" || v === "column";
const isSide = (v: unknown) => v === "before" || v === "after";
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isPath = (v: unknown) =>
  Array.isArray(v) &&
  v.length <= PATH_MAX &&
  v.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= INDEX_MAX);
const isSizes = (v: unknown) =>
  Array.isArray(v) &&
  v.length >= 2 &&
  v.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);

/** Why `value` is not a kit op, or null when it is one. */
export function kitOpProblem(value: unknown): string | null {
  if (!isRecord(value)) return "an op is an object";
  const kind = value.op;
  if (typeof kind !== "string") return 'an op names its kind in "op"';
  if (!Object.hasOwn(KEYS, kind)) return `${JSON.stringify(kind)} is not a kit op`;
  const [required, optional] = KEYS[kind as KitOp["op"]];
  const extra = Object.keys(value).find(
    (k) => k !== "op" && !required.includes(k) && !optional.includes(k),
  );
  if (extra !== undefined) return `a ${kind} op has no ${JSON.stringify(extra)}`;
  const missing = required.find((k) => !Object.hasOwn(value, k));
  if (missing !== undefined) return `a ${kind} op needs ${JSON.stringify(missing)}`;
  for (const key of ["leafId", "targetLeafId", "a", "b", "from", "to"]) {
    if (Object.hasOwn(value, key) && !isRef(value[key])) {
      return `${JSON.stringify(key)} is a non-empty tile ref`;
    }
  }
  if (Object.hasOwn(value, "axis") && !isAxis(value.axis)) return '"axis" is "row" or "column"';
  if (Object.hasOwn(value, "side") && !isSide(value.side)) return '"side" is "before" or "after"';
  if (Object.hasOwn(value, "target")) {
    const t = value.target;
    if (!isRecord(t) || Object.keys(t).sort().join(",") !== "axis,side,targetWorkspaceId") {
      return '"target" holds targetWorkspaceId, axis and side';
    }
    if (!isRef(t.targetWorkspaceId)) return '"targetWorkspaceId" is a non-empty tile ref';
    if (!isAxis(t.axis)) return '"axis" is "row" or "column"';
    if (!isSide(t.side)) return '"side" is "before" or "after"';
  }
  if (Object.hasOwn(value, "path") && !isPath(value.path)) {
    return '"path" is a list of at most 64 indexes';
  }
  if (Object.hasOwn(value, "sizes") && !isSizes(value.sizes)) {
    return '"sizes" is a list of two or more sizes';
  }
  return null;
}

function nodeAt(root: MosaicNode | null, path: number[]): MosaicNode | null {
  let at = root;
  for (const i of path) {
    if (at?.kind !== "split") return null;
    at = at.children[i] ?? null;
  }
  return at;
}

/** Whether `op` can run on `root`; the twin of `can_apply`. */
function canApply(root: MosaicNode | null, op: KitOp): boolean {
  const has = (id: string) => findLeafPath(root, id) !== null;
  const splitLength = (path: number[]) => {
    const node = nodeAt(root, path);
    return node?.kind === "split" ? node.children.length : null;
  };
  switch (op.op) {
    case "pin":
    case "unpin":
      return false;
    case "place":
    case "close":
      return true;
    case "splitAt":
      return has(op.targetLeafId) && !has(op.leafId);
    case "move":
      return has(op.leafId) && has(op.target.targetWorkspaceId);
    case "resize":
      return splitLength(op.path) === op.sizes.length;
    case "swap":
      return has(op.a) && has(op.b);
    case "evenOut":
      return op.path === undefined || splitLength(op.path) !== null;
    case "replace":
      return op.from === op.to || (has(op.from) && !has(op.to));
  }
}

/** `root` after `op`, or `KIT_OP_FAILED` when it can't run there. */
export function applyKitOp(
  root: MosaicNode | null,
  op: KitOp,
): MosaicNode | null | typeof KIT_OP_FAILED {
  if (!canApply(root, op)) return KIT_OP_FAILED;
  switch (op.op) {
    case "place":
      return appendLeaf(root, op.leafId);
    case "close":
      return pruneLeaf(root, op.leafId);
    case "pin":
    case "unpin":
      return root;
  }
  // With no tree, only an even-out of every split and a replace of a leaf by itself pass
  // `canApply`, and both leave nothing.
  if (!root) return null;
  switch (op.op) {
    case "splitAt":
      return splitAt(root, op.targetLeafId, op.axis, op.side, op.leafId);
    case "move":
      return moveLeaf(root, op.leafId, op.target);
    case "resize":
      return setNodeSizes(root, op.path, op.sizes);
    case "swap":
      return swapLeaves(root, op.a, op.b);
    case "evenOut":
      return evenSizes(root, op.path);
    case "replace":
      return replaceLeafWorkspaceId(root, op.from, op.to);
  }
}
