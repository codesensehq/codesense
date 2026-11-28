// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { storyIdFromPath } from "../lib/worktree/resolve";
import { genericWorkspaceId } from "../stores/viewer-store";
import type { GroupFile, SavedNode } from "./group-file.generated";
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

describe("the leaf-id fixture", () => {
  const rows: { leaf: string; layer: string; valid: boolean }[] = JSON.parse(
    readFileSync("tests/fixtures/leaf-keys.json", "utf8"),
  ).refs;
  const valid = (leaf: string, layer: string) =>
    rows.some((r) => r.leaf === leaf && r.layer === layer && r.valid);

  it("holds the ids the viewer mints for a generic workspace and a story workspace", () => {
    const minted = [
      genericWorkspaceId("/Users/me/code/app"),
      storyIdFromPath("/repo/stories/SV-WF-63-cli-overlay.story.md"),
    ];
    expect(minted).toEqual(["generic:/Users/me/code/app", "SV-WF-63-cli-overlay.story"]);
    for (const id of minted) {
      expect(valid(id, "private"), `${id} is valid in the private layer`).toBe(true);
      expect(valid(id, "shared"), `${id} is refused in a shared layer`).toBe(false);
      expect(rows.some((r) => r.leaf === id && r.layer === "shared")).toBe(true);
    }
  });
});
