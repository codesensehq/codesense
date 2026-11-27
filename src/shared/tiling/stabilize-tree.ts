// SPDX-License-Identifier: MIT
// ---------------------------------------------------------------------------
// stabilizeTree: gives a mosaic tree stable identities across renders, so a renderer memoized on
// them redraws only the path that changed. Callers hand the view a fresh tree all the time (a
// preset rebuilt from ids, a root parsed from saved state, an op's result); this interns every
// subtree that is structurally equal to one from the previous render back to that render's
// object, and keys every split so that a split which changed keeps its React key.
// ---------------------------------------------------------------------------

import type { MosaicNode } from "./mosaic-tree";

/** The fixed key of the root split, whichever node is the root. */
export const ROOT_SPLIT_KEY = "split:root";

/** A node with its render key. `children` parallels `node.children` for a split; a leaf has
 *  none. Equal subtrees keep the same `StableNode` object from render to render. */
export interface StableNode {
  key: string;
  node: MosaicNode;
  children: StableNode[];
}

/** One render's stabilized tree. `nextKey` numbers the next split key to mint, so no key is
 *  ever handed out twice to one view. */
export interface StableTree {
  root: StableNode | null;
  nextKey: number;
}

// Trees are immutable, so a node's signature never changes.
const signatures = new WeakMap<MosaicNode, string>();

/** A string equal for two nodes exactly when they are structurally equal: leaf ids, axes, exact
 *  sizes and child order. */
function signature(node: MosaicNode): string {
  const cached = signatures.get(node);
  if (cached !== undefined) return cached;
  const sig =
    node.kind === "leaf"
      ? `L${JSON.stringify(node.id)}`
      : `S${node.axis}[${node.sizes.join(",")}](${node.children.map(signature).join("|")})`;
  signatures.set(node, sig);
  return sig;
}

function* walk(node: StableNode): Generator<StableNode> {
  yield node;
  for (const child of node.children) yield* walk(child);
}

/** Stabilize `next` against the previous render's tree. A subtree equal to one in `prev` comes
 *  back as `prev`'s object (each previous object serves once). A changed split takes the key of
 *  an unclaimed previous split child under its parent's previous self (one on the same axis
 *  first, in order), else a newly minted key. The root split is always `ROOT_SPLIT_KEY` and a
 *  leaf's key is its id. */
export function stabilizeTree(prev: StableTree | null, next: MosaicNode | null): StableTree {
  let nextKey = prev?.nextKey ?? 0;
  if (!next) return { root: null, nextKey };
  const prevRoot = prev?.root ?? null;

  // The previous non-root nodes by signature, in render order. The previous root isn't pooled
  // for other positions: its key is the root's.
  const pool = new Map<string, StableNode[]>();
  const prevByKey = new Map<string, StableNode>();
  if (prevRoot) {
    for (const n of walk(prevRoot)) {
      prevByKey.set(n.key, n);
      if (n === prevRoot) continue;
      const sig = signature(n.node);
      const list = pool.get(sig);
      if (list) list.push(n);
      else pool.set(sig, [n]);
    }
  }
  const used = new Set<StableNode>();
  const claimedKeys = new Set<string>();
  const claim = (n: StableNode) => {
    for (const d of walk(n)) {
      used.add(d);
      claimedKeys.add(d.key);
    }
  };
  const take = (node: MosaicNode): StableNode | null => {
    const found = pool.get(signature(node))?.find((n) => !used.has(n));
    if (found) claim(found);
    return found ?? null;
  };

  // Pass one, top-down: intern what can be, leaving a plan for what changed.
  interface Plan {
    node: MosaicNode;
    reused: StableNode | null;
    children: Plan[];
  }
  const plan = (node: MosaicNode, isRoot: boolean): Plan => {
    if (isRoot && prevRoot && signature(prevRoot.node) === signature(node)) {
      claim(prevRoot);
      return { node, reused: prevRoot, children: [] };
    }
    const reused = take(node);
    if (reused) return { node, reused, children: [] };
    return {
      node,
      reused: null,
      children: node.kind === "split" ? node.children.map((c) => plan(c, false)) : [],
    };
  };
  const rootPlan = plan(next, true);

  // Pass two, top-down: key what changed.
  const inheritKey = (parentKey: string, axis: string): string | null => {
    const candidates = (prevByKey.get(parentKey)?.children ?? []).filter(
      (c) => c.node.kind === "split" && !claimedKeys.has(c.key),
    );
    const pick =
      candidates.find((c) => c.node.kind === "split" && c.node.axis === axis) ?? candidates[0];
    if (!pick) return null;
    claimedKeys.add(pick.key);
    return pick.key;
  };
  const build = (p: Plan, parentKey: string | null): StableNode => {
    if (p.reused) return p.reused;
    const { node } = p;
    if (node.kind === "leaf") return { key: node.id, node, children: [] };
    let key: string;
    if (parentKey === null) key = ROOT_SPLIT_KEY;
    else key = inheritKey(parentKey, node.axis) ?? `split:${nextKey++}`;
    return { key, node, children: p.children.map((c) => build(c, key)) };
  };
  let root = build(rootPlan, null);
  // A previous inner split lifted to the root keeps its subtree but takes the root's key.
  if (root.node.kind === "split" && root.key !== ROOT_SPLIT_KEY) {
    root = { ...root, key: ROOT_SPLIT_KEY };
  }
  return { root, nextKey };
}
