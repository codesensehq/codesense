// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import {
  appendLeaf,
  moveLeaf,
  pruneLeaf,
  replaceLeafWorkspaceId,
  setNodeSizes,
  splitAt,
  type MosaicNode,
} from "./mosaic-tree";

// Every op keeps the subtrees it doesn't touch by reference, and a call that changes nothing
// returns its input, so a renderer memoized on node identity redraws only what changed.

const leaf = (id: string): MosaicNode => ({ kind: "leaf", id });
const split = (axis: "row" | "column", children: MosaicNode[], sizes?: number[]): MosaicNode => ({
  kind: "split",
  axis,
  children,
  sizes: sizes ?? children.map(() => 100 / children.length),
});

/** row[ a, column[b, c], row-nested[ d, column[e, f] ] ] */
function tree() {
  const bc = split("column", [leaf("b"), leaf("c")], [40, 60]);
  const ef = split("column", [leaf("e"), leaf("f")]);
  const def = split("row", [leaf("d"), ef]);
  const root = split("column", [split("row", [leaf("a"), bc]), def]);
  return { root, bc, ef, def };
}

const childAt = (node: MosaicNode, ...path: number[]): MosaicNode =>
  path.reduce((n, i) => (n.kind === "split" ? n.children[i] : n), node);

describe("untouched subtrees stay ===", () => {
  it("splitAt (same axis) keeps every sibling subtree", () => {
    const { root, def, bc } = tree();
    const next = splitAt(root, "a", "row", "after", "agent:other-team/x");
    expect(childAt(next, 1)).toBe(def);
    expect(childAt(next, 0, 0)).toBe(childAt(root, 0, 0));
    expect(childAt(next, 0, 2)).toBe(bc);
  });

  it("splitAt (cross axis) keeps everything but the wrapped leaf's parent chain", () => {
    const { root, def, bc } = tree();
    const next = splitAt(root, "a", "column", "before", "doc:notes.md");
    expect(childAt(next, 1)).toBe(def);
    expect(childAt(next, 0, 1)).toBe(bc);
    expect(childAt(next, 0, 0, 1)).toBe(childAt(root, 0, 0));
  });

  it("appendLeaf keeps every child (only the root's sizes even out)", () => {
    const { root } = tree();
    const next = appendLeaf(root, "g");
    expect(childAt(next, 0)).toBe(childAt(root, 0));
    expect(childAt(next, 1)).toBe(childAt(root, 1));
  });

  it("pruneLeaf keeps the other branch", () => {
    const { root, def } = tree();
    const next = pruneLeaf(root, "b")!;
    expect(childAt(next, 1)).toBe(def);
    expect(childAt(next, 0, 0)).toBe(childAt(root, 0, 0));
  });

  it("setNodeSizes keeps the siblings of the resized split", () => {
    const { root, bc, ef } = tree();
    const next = setNodeSizes(root, [1, 1], [30, 70]);
    expect(childAt(next, 0)).toBe(childAt(root, 0));
    expect(childAt(next, 0, 1)).toBe(bc);
    expect(childAt(next, 1, 0)).toBe(childAt(root, 1, 0));
    expect(childAt(next, 1, 1)).not.toBe(ef);
    expect(childAt(next, 1, 1, 0)).toBe(childAt(ef, 0));
  });

  it("replaceLeafWorkspaceId keeps the other leaves and splits", () => {
    const { root, def, bc } = tree();
    const next = replaceLeafWorkspaceId(root, "a", "z")!;
    expect(childAt(next, 1)).toBe(def);
    expect(childAt(next, 0, 1)).toBe(bc);
  });

  it("moveLeaf keeps the branches it neither leaves nor enters", () => {
    const { root, bc } = tree();
    const next = moveLeaf(root, "e", { targetWorkspaceId: "d", axis: "column", side: "after" });
    expect(childAt(next, 0)).toBe(childAt(root, 0));
    expect(childAt(next, 0, 1)).toBe(bc);
  });
});

describe("a call that changes nothing returns its input", () => {
  it("splitAt onto an absent target", () => {
    const { root } = tree();
    expect(splitAt(root, "nope", "row", "after", "g")).toBe(root);
  });

  it("appendLeaf of a leaf already placed", () => {
    const { root } = tree();
    expect(appendLeaf(root, "c")).toBe(root);
    const single = leaf("a");
    expect(appendLeaf(single, "a")).toBe(single);
  });

  it("pruneLeaf of an absent id", () => {
    const { root } = tree();
    expect(pruneLeaf(root, "nope")).toBe(root);
  });

  it("moveLeaf onto its own edge", () => {
    const pair = split("row", [leaf("a"), leaf("b")], [30, 70]);
    // a already sits left of b.
    expect(moveLeaf(pair, "a", { targetWorkspaceId: "b", axis: "row", side: "before" })).toBe(pair);
    expect(moveLeaf(pair, "a", { targetWorkspaceId: "a", axis: "row", side: "after" })).toBe(pair);
  });

  it("replaceLeafWorkspaceId(a, a)", () => {
    const { root } = tree();
    expect(replaceLeafWorkspaceId(root, "a", "a")).toBe(root);
    expect(replaceLeafWorkspaceId(root, "nope", "z")).toBe(root);
  });

  it("setNodeSizes with equal sizes, at the root and nested", () => {
    const { root } = tree();
    expect(setNodeSizes(root, [], [50, 50])).toBe(root);
    expect(setNodeSizes(root, [0, 1], [40, 60])).toBe(root);
    // Equal once normalized.
    expect(setNodeSizes(root, [0, 1], [4, 6])).toBe(root);
    // A stale path or a length mismatch.
    expect(setNodeSizes(root, [0, 0], [50, 50])).toBe(root);
    expect(setNodeSizes(root, [0, 1], [10, 20, 70])).toBe(root);
  });
});
