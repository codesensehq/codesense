// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

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
