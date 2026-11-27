// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import {
  findLeafPath,
  leafId,
  leafWorkspaceIds,
  parseMosaicNode,
  replaceLeafWorkspaceId,
  sameMosaicStructure,
  serializeMosaicNode,
  type MosaicNode,
} from "./mosaic-tree";

const leaf = (id: string): MosaicNode => ({ kind: "leaf", id });

describe("leaf ids", () => {
  describe("parseMosaicNode reads either key", () => {
    it("an id-only leaf", () => {
      expect(parseMosaicNode({ kind: "leaf", id: "a" })).toEqual(leaf("a"));
    });

    it("a workspaceId-only leaf (saved before leaves carried an id)", () => {
      expect(parseMosaicNode({ kind: "leaf", workspaceId: "a" })).toEqual(leaf("a"));
    });

    it("both keys agreeing", () => {
      expect(parseMosaicNode({ kind: "leaf", id: "a", workspaceId: "a" })).toEqual(leaf("a"));
    });

    it("both keys disagreeing: workspaceId wins", () => {
      expect(parseMosaicNode({ kind: "leaf", id: "x", workspaceId: "a" })).toEqual(leaf("a"));
    });

    it("neither key: a root leaf is no tree", () => {
      expect(parseMosaicNode({ kind: "leaf" })).toBeNull();
      expect(parseMosaicNode({ kind: "leaf", id: "", workspaceId: 3 })).toBeNull();
    });

    it("neither key: the leaf is pruned and its split collapses", () => {
      const saved = {
        kind: "split",
        axis: "row",
        sizes: [20, 30, 50],
        children: [{ kind: "leaf", id: "a" }, { kind: "leaf" }, { kind: "leaf", workspaceId: "c" }],
      };
      expect(parseMosaicNode(saved)).toEqual({
        kind: "split",
        axis: "row",
        children: [leaf("a"), leaf("c")],
        sizes: [(20 / 70) * 100, (50 / 70) * 100],
      });
      const pair = { ...saved, sizes: [50, 50], children: [{ kind: "leaf" }, saved.children[0]] };
      expect(parseMosaicNode(pair)).toEqual(leaf("a"));
    });

    it("neither key on every leaf of a nested split: only that branch is pruned", () => {
      const keyless = {
        kind: "split",
        axis: "column",
        sizes: [50, 50],
        children: [{ kind: "leaf" }, { kind: "leaf", id: "" }],
      };
      const saved = {
        kind: "split",
        axis: "row",
        sizes: [25, 25, 50],
        children: [{ kind: "leaf", id: "a" }, keyless, { kind: "leaf", id: "b" }],
      };
      expect(parseMosaicNode(saved)).toEqual({
        kind: "split",
        axis: "row",
        children: [leaf("a"), leaf("b")],
        sizes: [(25 / 75) * 100, (50 / 75) * 100],
      });
      expect(
        parseMosaicNode({ ...saved, sizes: [50, 50], children: [keyless, saved.children[2]] }),
      ).toEqual(leaf("b"));
      expect(parseMosaicNode(keyless)).toBeNull();
    });

    it("passes any team's agent and doc ids through untouched", () => {
      for (const id of [
        "agent:acme/widgets:ops/reviewer",
        "doc:other-team/notes/plan.md",
        "ws-1",
      ]) {
        expect(parseMosaicNode({ kind: "leaf", id })).toEqual(leaf(id));
        expect(leafId(leaf(id))).toBe(id);
      }
    });
  });

  it("serializeMosaicNode writes both keys on every leaf", () => {
    const tree: MosaicNode = {
      kind: "split",
      axis: "column",
      sizes: [40, 60],
      children: [
        leaf("agent:t/a"),
        { kind: "split", axis: "row", sizes: [50, 50], children: [leaf("b"), leaf("doc:c.md")] },
      ],
    };
    expect(serializeMosaicNode(tree)).toEqual({
      kind: "split",
      axis: "column",
      sizes: [40, 60],
      children: [
        { kind: "leaf", id: "agent:t/a", workspaceId: "agent:t/a" },
        {
          kind: "split",
          axis: "row",
          sizes: [50, 50],
          children: [
            { kind: "leaf", id: "b", workspaceId: "b" },
            { kind: "leaf", id: "doc:c.md", workspaceId: "doc:c.md" },
          ],
        },
      ],
    });
    expect(serializeMosaicNode(null)).toBeNull();
    // What is written reads back to the same tree.
    expect(parseMosaicNode(JSON.parse(JSON.stringify(serializeMosaicNode(tree))))).toEqual(tree);
  });

  it("the readers go through the leaf id", () => {
    const tree: MosaicNode = {
      kind: "split",
      axis: "row",
      sizes: [50, 50],
      children: [leaf("a"), leaf("agent:b")],
    };
    expect(leafWorkspaceIds(tree)).toEqual(["a", "agent:b"]);
    expect(findLeafPath(tree, "agent:b")).toEqual([1]);
    expect(sameMosaicStructure(tree, { ...tree, sizes: [10, 90] })).toBe(true);
    expect(replaceLeafWorkspaceId(tree, "agent:b", "doc:c")).toEqual({
      ...tree,
      children: [leaf("a"), leaf("doc:c")],
    });
  });
});
