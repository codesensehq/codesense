// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildRootWorkspaceId } from "../lib/team-key";
import { storyIdFromPath } from "../lib/worktree/resolve";
import { genericWorkspaceId } from "../stores/viewer-store";
import type { Axis, GroupFile, OwnerKind, SavedNode } from "./group-file.generated";
import { parseMosaicNode, serializeMosaicNode } from "./mosaic-tree";

// The same file the Rust store's tests read and write, so the two sides share one shape.
const fixture: GroupFile = JSON.parse(readFileSync("tests/fixtures/group-file-v2.json", "utf8"));

describe("the group file's tree", () => {
  it("is the kit's saved-leaf shape: it parses and serializes back unchanged", () => {
    expect(fixture.version).toBe(2);
    const parsed = parseMosaicNode(fixture.root);
    expect(parsed).not.toBeNull();
    const saved: SavedNode | null = serializeMosaicNode(parsed);
    expect(saved).toEqual(fixture.root);
  });
});

describe("the Rust-generated unions", () => {
  // A new Rust variant makes these lists fail to type-check until they name it.
  const owners: OwnerKind[] = ["workspace", "group", "starter"];
  const axes: Axis[] = ["row", "column"];
  const splitAxes = (node: SavedNode | null): Axis[] =>
    node?.kind === "split" ? [node.axis, ...node.children.flatMap(splitAxes)] : [];

  it("holds every owner and split axis the fixture uses", () => {
    expect(owners).toContain(fixture.owner);
    for (const axis of splitAxes(fixture.root)) expect(axes).toContain(axis);
  });
});

describe("the leaf-id fixture", () => {
  const rows: { leaf: string; layer: string; valid: boolean }[] = JSON.parse(
    readFileSync("tests/fixtures/leaf-keys.json", "utf8"),
  ).refs;
  const valid = (leaf: string, layer: string) =>
    rows.some((r) => r.leaf === leaf && r.layer === layer && r.valid);

  it("holds the ids the viewer mints for a generic, a story and a root workspace", () => {
    const minted = [
      genericWorkspaceId("/home/me/code/app"),
      storyIdFromPath("/repo/docs/DEMO-63-cli-overlay.story.md"),
    ];
    expect(minted).toEqual(["generic:/home/me/code/app", "DEMO-63-cli-overlay.story"]);
    minted.push(buildRootWorkspaceId({ owner: "acme", repo: "app" }));
    expect(minted[2]).toBe("root:acme/app");
    for (const id of minted) {
      expect(valid(id, "private"), `${id} is valid in the private layer`).toBe(true);
      expect(valid(id, "shared"), `${id} is refused in a shared layer`).toBe(false);
      expect(rows.some((r) => r.leaf === id && r.layer === "shared")).toBe(true);
    }
  });
});
