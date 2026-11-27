// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { buildPresetTree, pruneLeaf, setNodeSizes, splitAt, type MosaicNode } from "./mosaic-tree";
import { ROOT_SPLIT_KEY, stabilizeTree, type StableNode, type StableTree } from "./stabilize-tree";

const leaf = (id: string): MosaicNode => ({ kind: "leaf", id });
const split = (axis: "row" | "column", children: MosaicNode[], sizes?: number[]): MosaicNode => ({
  kind: "split",
  axis,
  children,
  sizes: sizes ?? children.map(() => 100 / children.length),
});

/** Every key in the stabilized tree, in render order. */
const keys = (n: StableNode | null): string[] =>
  n ? [n.key, ...n.children.flatMap((c) => keys(c))] : [];
const at = (t: StableTree, ...path: number[]): StableNode =>
  path.reduce((n, i) => n.children[i], t.root!);

/** column[ row[a, b], row[c, column[d, e]], row[f, g] ] */
const build = (bottomSizes?: number[]) =>
  split("column", [
    split("row", [leaf("a"), leaf("b")]),
    split("row", [leaf("c"), split("column", [leaf("d"), leaf("e")], bottomSizes)]),
    split("row", [leaf("f"), leaf("g")]),
  ]);

describe("stabilizeTree", () => {
  it("keys the root split with the fixed root key and a leaf with its bare id", () => {
    const t = stabilizeTree(null, build());
    expect(t.root!.key).toBe(ROOT_SPLIT_KEY);
    expect(at(t, 0, 1).key).toBe("b");
    expect(at(t, 1, 1, 0).key).toBe("d");
    expect(stabilizeTree(null, leaf("solo")).root!.key).toBe("solo");
    expect(stabilizeTree(null, null).root).toBeNull();
  });

  it("mints unique split keys that are not index paths", () => {
    const all = keys(stabilizeTree(null, build()).root);
    expect(new Set(all).size).toBe(all.length);
    const splits = all.filter((k) => k.startsWith("split:"));
    expect(splits).toHaveLength(5);
    for (const k of splits) expect(k).toMatch(/^split:(root|\d+)$/);
  });

  it("interns a structurally equal fresh tree: every node is the previous object", () => {
    const prev = stabilizeTree(null, build());
    // A rebuild, as a derived preset tree or a parse does on every call.
    const next = stabilizeTree(prev, build());
    expect(next.root).toBe(prev.root);
    expect(next.root!.node).toBe(prev.root!.node);
  });

  it("interns a preset rebuild", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const prev = stabilizeTree(null, buildPresetTree("grid", ids));
    expect(stabilizeTree(prev, buildPresetTree("grid", ids)).root).toBe(prev.root);
  });

  it("keeps an unchanged sibling and re-keys nothing when one nested split resizes", () => {
    const prev = stabilizeTree(null, build());
    const resized = setNodeSizes(prev.root!.node, [1, 1], [30, 70]);
    const next = stabilizeTree(prev, resized);
    expect(next.root).not.toBe(prev.root);
    expect(at(next, 0)).toBe(at(prev, 0));
    expect(at(next, 2)).toBe(at(prev, 2));
    expect(at(next, 1, 0)).toBe(at(prev, 1, 0));
    expect(at(next, 1, 1)).not.toBe(at(prev, 1, 1));
    expect(at(next, 1, 1).node.kind === "split" && at(next, 1, 1).node.sizes).toEqual([30, 70]);
    // The changed splits keep their keys, so nothing remounts.
    expect(keys(next.root)).toEqual(keys(prev.root));
  });

  it("a changed split inherits its previous sibling's key, so an insert before it doesn't re-key it", () => {
    const prev = stabilizeTree(null, build());
    // A leaf from another team goes in beside c, left of the nested d/e split.
    const grown = splitAt(prev.root!.node, "c", "row", "after", "agent:other/x");
    const next = stabilizeTree(prev, grown);
    expect(at(next, 1).key).toBe(at(prev, 1).key);
    // The nested split moved from index 1 to 2 in its row and is the same node.
    expect(at(next, 1, 2)).toBe(at(prev, 1, 1));
    expect(at(next, 0)).toBe(at(prev, 0));
    expect(at(next, 2)).toBe(at(prev, 2));
    expect(at(next, 1, 1).key).toBe("agent:other/x");
  });

  it("prefers a same-axis sibling's key when two splits under one parent change", () => {
    const prev = stabilizeTree(
      null,
      split("row", [split("column", [leaf("a"), leaf("b")]), split("row", [leaf("c"), leaf("d")])]),
    );
    const next = stabilizeTree(
      prev,
      split("row", [
        split("row", [leaf("c"), leaf("d")], [20, 80]),
        split("column", [leaf("a"), leaf("b")], [10, 90]),
      ]),
    );
    expect(at(next, 0).key).toBe(at(prev, 1).key);
    expect(at(next, 1).key).toBe(at(prev, 0).key);
  });

  it("mints a new key for a split with no sibling to inherit from, never reusing one", () => {
    const prev = stabilizeTree(null, split("row", [leaf("a"), leaf("b")]));
    const next = stabilizeTree(prev, splitAt(prev.root!.node, "a", "column", "after", "c"));
    const minted = at(next, 0).key;
    expect(minted).toMatch(/^split:\d+$/);
    expect(keys(prev.root)).not.toContain(minted);
    const again = stabilizeTree(next, splitAt(next.root!.node, "b", "column", "after", "d"));
    expect(at(again, 1).key).not.toBe(minted);
    expect(at(again, 0)).toBe(at(next, 0));
  });

  it("keeps the root key fixed when a prune lifts a nested split to the root", () => {
    const prev = stabilizeTree(
      null,
      split("row", [leaf("a"), split("column", [leaf("b"), leaf("c")])]),
    );
    const next = stabilizeTree(prev, pruneLeaf(prev.root!.node, "a"));
    expect(next.root!.key).toBe(ROOT_SPLIT_KEY);
    expect(next.root!.node).toBe(at(prev, 1).node);
    expect(next.root!.children[0]).toBe(at(prev, 1, 0));
  });

  it("returns the input tree's leaves when nothing was there before", () => {
    const tree = build();
    const t = stabilizeTree(null, tree);
    expect(t.root!.node).toBe(tree);
  });
});
