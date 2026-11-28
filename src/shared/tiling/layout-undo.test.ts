// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";

import {
  LAYOUT_UNDO_LIMIT,
  nextLayoutRedo,
  nextLayoutUndo,
  recordLayoutChange,
  redoLayoutChange,
  resetLayoutUndoForTests,
  undoLayoutChange,
  type LayoutActor,
  type LayoutSnapshot,
} from "./layout-undo";
import {
  appendLeaf,
  evenSizes,
  moveLeaf,
  pruneLeaf,
  seedTreeFromFlat,
  setNodeSizes,
  splitAt,
  swapLeaves,
  type MosaicNode,
} from "./mosaic-tree";

afterEach(resetLayoutUndoForTests);

const PERSON: LayoutActor = { kind: "person" };
const AGENT: LayoutActor = { kind: "agent", id: "agent-7" };

/** A workspace's layout: a row of three tiles, each with its tabs. */
const tree = seedTreeFromFlat(["a", "b", "c"], "row", [20, 30, 50])!;
const tabs = { a: ["t1", "t2"], b: ["t3"], c: ["t4"] };
const snap = (
  t: MosaicNode | null,
  tabList: Record<string, string[]> = tabs,
  key = "ws-1",
): LayoutSnapshot => ({ key, tree: t, tabs: tabList });

/** A chain of distinct layouts for one key, each a resize of the first split. */
function chain(n: number, key = "ws-1"): LayoutSnapshot[] {
  return Array.from({ length: n }, (_, i) =>
    snap(setNodeSizes(tree, [], [10 + i, 40, 50 - i]), tabs, key),
  );
}

describe("recordLayoutChange", () => {
  it("pushes exactly one step per call", () => {
    const after = snap(swapLeaves(tree, "a", "c"));
    expect(recordLayoutChange(snap(tree), after, PERSON)).toBe(true);
    expect(undoLayoutChange(after)).toEqual(snap(tree));
    expect(undoLayoutChange(snap(tree))).toBeNull();
  });

  it("pushes nothing when before and after are structurally equal", () => {
    // A copy of the same tree, and a size change within float noise, are the same layout.
    const copy = structuredClone(tree);
    expect(recordLayoutChange(snap(tree), snap(copy), PERSON)).toBe(false);
    const noise = setNodeSizes(tree, [], [20 + 1e-12, 30, 50 - 1e-12]);
    expect(recordLayoutChange(snap(tree), snap(noise), PERSON)).toBe(false);
    // An op that returns its input unchanged (evenSizes on an even split) pushes nothing.
    const even = evenSizes(tree);
    expect(recordLayoutChange(snap(even), snap(evenSizes(even)), PERSON)).toBe(false);
    expect(nextLayoutUndo("ws-1")).toBeNull();
  });

  it("counts a change to a tile's tabs as a change", () => {
    const after = snap(tree, { ...tabs, a: ["t2", "t1"] });
    expect(recordLayoutChange(snap(tree), after, PERSON)).toBe(true);
  });

  it("tags each step with the person or the agent that made it", () => {
    const [s0, s1, s2] = chain(3);
    recordLayoutChange(s0, s1, PERSON);
    recordLayoutChange(s1, s2, AGENT);
    expect(nextLayoutUndo("ws-1")?.by).toEqual(AGENT);
    undoLayoutChange(s2);
    expect(nextLayoutUndo("ws-1")?.by).toEqual(PERSON);
    expect(nextLayoutRedo("ws-1")?.by).toEqual(AGENT);
  });

  it("refuses snapshots of two different workspaces", () => {
    expect(() => recordLayoutChange(snap(tree), snap(tree, tabs, "ws-2"), PERSON)).toThrow(
      /ws-1.*ws-2/,
    );
  });

  // The op kinds the caller stories own, each built with the kit's real tree ops: one push per
  // call, and the undo step puts the layout back.
  const closed = pruneLeaf(tree, "b");
  const callers: [op: string, before: LayoutSnapshot, after: LayoutSnapshot][] = [
    ["join", snap(tree), snap(pruneLeaf(tree, "c"), { a: ["t1", "t2", "t4"], b: ["t3"] })],
    [
      "pull-off",
      snap(tree),
      snap(splitAt(tree, "a", "column", "after", "d"), { ...tabs, a: ["t1"], d: ["t2"] }),
    ],
    [
      "move",
      snap(tree),
      snap(moveLeaf(tree, "a", { targetWorkspaceId: "c", axis: "column", side: "after" })),
    ],
    ["swap", snap(tree), snap(swapLeaves(tree, "a", "b"))],
    ["reorder", snap(tree), snap(tree, { ...tabs, a: ["t2", "t1"] })],
    ["resize", snap(tree), snap(setNodeSizes(tree, [], [40, 30, 30]))],
    ["even-out", snap(tree), snap(evenSizes(tree))],
    ["expand", snap(tree), snap(setNodeSizes(tree, [], [90, 5, 5]))],
    ["width", snap(tree), snap(setNodeSizes(tree, [], [25, 25, 50]))],
    [
      "height",
      snap(splitAt(tree, "a", "column", "after", "d")),
      snap(setNodeSizes(splitAt(tree, "a", "column", "after", "d"), [0], [70, 30])),
    ],
    ["close", snap(tree), snap(closed, { a: tabs.a, c: tabs.c })],
    ["reopen", snap(closed, { a: tabs.a, c: tabs.c }), snap(appendLeaf(closed, "b"))],
    ["pin", snap(tree), snap(tree, { a: ["t1"], b: ["t3"], c: ["t2", "t4"] })],
  ];
  it.each(callers)("%s pushes one step that undoes to its before", (_op, before, after) => {
    expect(recordLayoutChange(before, after, PERSON)).toBe(true);
    expect(nextLayoutUndo("ws-1")).toMatchObject({ before, after, by: PERSON });
    expect(undoLayoutChange(after)).toEqual(before);
    expect(nextLayoutUndo("ws-1")).toBeNull();
  });
});

describe("undoLayoutChange and redoLayoutChange", () => {
  it("each moves one step and returns the snapshot to apply", () => {
    const [s0, s1, s2] = chain(3);
    recordLayoutChange(s0, s1, PERSON);
    recordLayoutChange(s1, s2, PERSON);
    expect(undoLayoutChange(s2)).toEqual(s1);
    expect(undoLayoutChange(s1)).toEqual(s0);
    expect(redoLayoutChange(s0)).toEqual(s1);
    expect(redoLayoutChange(s1)).toEqual(s2);
  });

  it("return null when there is nothing to undo or redo", () => {
    const [s0, s1] = chain(2);
    expect(undoLayoutChange(s0)).toBeNull();
    expect(redoLayoutChange(s0)).toBeNull();
    recordLayoutChange(s0, s1, PERSON);
    expect(redoLayoutChange(s1)).toBeNull();
    expect(undoLayoutChange(s1)).toEqual(s0);
    expect(undoLayoutChange(s0)).toBeNull();
    expect(redoLayoutChange(s0)).toEqual(s1);
    expect(redoLayoutChange(s1)).toBeNull();
  });

  it(`keeps the last ${LAYOUT_UNDO_LIMIT} steps: the next one drops the oldest`, () => {
    expect(LAYOUT_UNDO_LIMIT).toBe(50);
    const layouts = chain(LAYOUT_UNDO_LIMIT + 2);
    for (let i = 0; i <= LAYOUT_UNDO_LIMIT; i++)
      recordLayoutChange(layouts[i], layouts[i + 1], PERSON);
    let current = layouts[LAYOUT_UNDO_LIMIT + 1];
    for (let i = 0; i < LAYOUT_UNDO_LIMIT; i++) {
      const back = undoLayoutChange(current);
      expect(back).not.toBeNull();
      current = back!;
    }
    // The first change (layouts[0] → layouts[1]) was dropped.
    expect(current).toEqual(layouts[1]);
    expect(undoLayoutChange(current)).toBeNull();
  });

  it("a new change after an undo clears the redo steps", () => {
    const [s0, s1, s2, s3] = chain(4);
    recordLayoutChange(s0, s1, PERSON);
    recordLayoutChange(s1, s2, PERSON);
    undoLayoutChange(s2);
    expect(nextLayoutRedo("ws-1")).not.toBeNull();
    recordLayoutChange(s1, s3, AGENT);
    expect(nextLayoutRedo("ws-1")).toBeNull();
    expect(redoLayoutChange(s3)).toBeNull();
    expect(undoLayoutChange(s3)).toEqual(s1);
  });

  it("keeps each workspace's steps apart", () => {
    const [a0, a1] = chain(2, "ws-1");
    const [b0, b1] = chain(2, "group:ws-2");
    recordLayoutChange(a0, a1, PERSON);
    recordLayoutChange(b0, b1, AGENT);
    expect(undoLayoutChange(a1)).toEqual(a0);
    expect(nextLayoutUndo("group:ws-2")).toMatchObject({ before: b0, after: b1, by: AGENT });
    // A drifted layout clears only its own key.
    expect(undoLayoutChange(snap(tree, tabs, "group:ws-2"))).toBeNull();
    expect(redoLayoutChange(a0)).toEqual(a1);
  });

  it("applies nothing and clears the key's steps when the layout drifted from the step's after", () => {
    const [s0, s1, s2] = chain(3);
    recordLayoutChange(s0, s1, PERSON);
    recordLayoutChange(s1, s2, PERSON);
    // A file tab opened in a tile without a recorded step: the live layout is not s2.
    const drifted = snap(s2.tree, { ...tabs, b: ["t3", "file:notes.md"] });
    expect(undoLayoutChange(drifted)).toBeNull();
    expect(nextLayoutUndo("ws-1")).toBeNull();
    expect(undoLayoutChange(s2)).toBeNull();
  });

  it("redo applies nothing and clears the key's steps when the layout drifted from the step's before", () => {
    const [s0, s1] = chain(2);
    recordLayoutChange(s0, s1, PERSON);
    undoLayoutChange(s1);
    const drifted = snap(swapLeaves(s0.tree!, "a", "b"));
    expect(redoLayoutChange(drifted)).toBeNull();
    expect(nextLayoutRedo("ws-1")).toBeNull();
    expect(redoLayoutChange(s0)).toBeNull();
  });
});

describe("a step's snapshots", () => {
  it("hold the tree and tab lists only: no tab content or unsaved text survives", () => {
    const withContent = {
      ...snap(tree),
      content: "unsaved draft",
      tabsContent: { t1: "# notes" },
    } as LayoutSnapshot;
    const after = snap(swapLeaves(tree, "a", "b"));
    recordLayoutChange(withContent, after, PERSON);
    const back = undoLayoutChange(after)!;
    expect(Object.keys(back).sort()).toEqual(["key", "tabs", "tree"]);
    expect(JSON.stringify(back)).not.toMatch(/unsaved draft|# notes/);
    expect(back).toEqual(snap(tree));
  });

  it("are copies: changing the caller's objects later changes no step", () => {
    const before = snap(structuredClone(tree), { a: ["t1"], b: ["t3"], c: ["t4"] });
    const after = snap(swapLeaves(tree, "a", "b"));
    recordLayoutChange(before, after, PERSON);
    (before.tabs.a as string[]).push("t9");
    if (before.tree?.kind === "split") before.tree.sizes[0] = 99;
    expect(undoLayoutChange(after)).toEqual(snap(tree, { a: ["t1"], b: ["t3"], c: ["t4"] }));
  });
});
