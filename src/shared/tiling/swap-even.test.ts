// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { evenSizes, swapLeaves, type MosaicNode } from "./mosaic-tree";

const leaf = (id: string): MosaicNode => ({ kind: "leaf", id });
const split = (axis: "row" | "column", children: MosaicNode[], sizes: number[]): MosaicNode => ({
  kind: "split",
  axis,
  children,
  sizes,
});

/** column[ row[a, b, column[c, d]] 30, row[e, f] 70 ] with uneven sizes everywhere. */
function tree() {
  const cd = split("column", [leaf("c"), leaf("d")], [25, 75]);
  const top = split("row", [leaf("a"), leaf("b"), cd], [20, 30, 50]);
  const ef = split("row", [leaf("e"), leaf("f")], [60, 40]);
  return { root: split("column", [top, ef], [30, 70]), top, cd, ef };
}

describe("swapLeaves", () => {
  it("swaps adjacent leaves and keeps every size", () => {
    const { root, cd, ef } = tree();
    expect(swapLeaves(root, "a", "b")).toEqual(
      split("column", [split("row", [leaf("b"), leaf("a"), cd], [20, 30, 50]), ef], [30, 70]),
    );
  });

  it("swaps distant leaves across nested splits", () => {
    const { root } = tree();
    expect(swapLeaves(root, "d", "e")).toEqual(
      split(
        "column",
        [
          split(
            "row",
            [leaf("a"), leaf("b"), split("column", [leaf("c"), leaf("e")], [25, 75])],
            [20, 30, 50],
          ),
          split("row", [leaf("d"), leaf("f")], [60, 40]),
        ],
        [30, 70],
      ),
    );
  });

  it("keeps every subtree neither leaf is in", () => {
    const { root, top, ef } = tree();
    const bottom = swapLeaves(root, "e", "f");
    expect(bottom.kind === "split" && bottom.children[0]).toBe(top);
    const nested = swapLeaves(root, "c", "d");
    expect(nested.kind === "split" && nested.children[1]).toBe(ef);
    const top2 = nested.kind === "split" ? nested.children[0] : null;
    expect(top2?.kind === "split" && top2.children[0]).toBe(
      top.kind === "split" && top.children[0],
    );
  });

  it("returns its input for one id twice or an absent id", () => {
    const { root } = tree();
    expect(swapLeaves(root, "a", "a")).toBe(root);
    expect(swapLeaves(root, "a", "nope")).toBe(root);
    expect(swapLeaves(root, "nope", "b")).toBe(root);
    const single = leaf("a");
    expect(swapLeaves(single, "a", "b")).toBe(single);
  });
});

describe("evenSizes", () => {
  it("evens one split at a path and keeps the rest", () => {
    const { root, top } = tree();
    const next = evenSizes(root, [1]);
    expect(next).toEqual(
      split("column", [top, split("row", [leaf("e"), leaf("f")], [50, 50])], [30, 70]),
    );
    expect(next.kind === "split" && next.children[0]).toBe(top);
  });

  it("evens a nested split and the root at their paths", () => {
    const { root, ef } = tree();
    const nested = evenSizes(root, [0, 2]);
    expect(nested.kind === "split" && nested.children[1]).toBe(ef);
    expect(
      nested.kind === "split" &&
        nested.children[0].kind === "split" &&
        nested.children[0].children[2],
    ).toEqual(split("column", [leaf("c"), leaf("d")], [50, 50]));
    expect(evenSizes(root, [])).toEqual({ ...root, sizes: [50, 50] });
  });

  it("evens every split with no path", () => {
    const { root } = tree();
    expect(evenSizes(root)).toEqual(
      split(
        "column",
        [
          split(
            "row",
            [leaf("a"), leaf("b"), split("column", [leaf("c"), leaf("d")], [50, 50])],
            [100 / 3, 100 / 3, 100 / 3],
          ),
          split("row", [leaf("e"), leaf("f")], [50, 50]),
        ],
        [50, 50],
      ),
    );
  });

  it("keeps an already even subtree when evening the whole tree", () => {
    const even = split("row", [leaf("x"), leaf("y")], [50, 50]);
    const root = split("column", [even, leaf("z")], [10, 90]);
    const next = evenSizes(root);
    expect(next.kind === "split" && next.children[0]).toBe(even);
  });

  it("returns its input on an already even tree, an even split or a path that isn't a split", () => {
    const even = evenSizes(tree().root);
    expect(evenSizes(even)).toBe(even);
    expect(evenSizes(even, [0])).toBe(even);
    const { root } = tree();
    expect(evenSizes(root, [0, 0])).toBe(root);
    expect(evenSizes(root, [5])).toBe(root);
    const single = leaf("a");
    expect(evenSizes(single)).toBe(single);
  });
});
