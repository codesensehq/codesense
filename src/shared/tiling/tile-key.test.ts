// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ItemKey } from "../windows/item-key";
import { parseMosaicNode } from "./mosaic-tree";
import { tabKey, tileKey } from "./tile-key";

// The same rows the Rust `groups::tile_key` tests read.
const itemKeys: { name: string; key: ItemKey }[] = JSON.parse(
  readFileSync("src-tauri/src/windows/fixtures/item-keys.json", "utf8"),
).keys;
const tiles: { leaf: unknown; layer: string; key: string }[] = JSON.parse(
  readFileSync("tests/fixtures/leaf-keys.json", "utf8"),
).tiles;

describe("tabKey", () => {
  const tabRows = itemKeys.filter((r) => r.key.kind === "tab");

  it("covers query order, ?session=, virtual:// and percent-encoding", () => {
    const ids = tabRows.map((r) => r.key.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "a.md?x=1&session=2",
        "a.md?session=2&x=1",
        "virtual://agents",
        "my%20notes.md",
      ]),
    );
  });

  it.each(tabRows.map((r) => [r.name, r.key] as const))("%s", (_, key) => {
    expect(tabKey(key.team, key.id)).toEqual(key);
  });
});

describe("tileKey", () => {
  it("has a row of each kind", () => {
    const keys = tiles.map((r) => r.key);
    for (const prefix of [
      "agent:",
      "doc:",
      "generic:",
      "story-page:",
      "dashboard:",
      "inbox:",
      "diff:",
      "notes:",
    ]) {
      expect(
        keys.some((k) => k.startsWith(prefix)),
        prefix,
      ).toBe(true);
    }
    expect(keys.some((k) => !k.includes(":"))).toBe(true);
  });

  it.each(tiles.map((r) => [r.key, r] as const))("%s reads back as its key", (_, row) => {
    const node = parseMosaicNode(row.leaf);
    expect(node?.kind).toBe("leaf");
    if (node?.kind !== "leaf") return;
    expect(tileKey(node)).toBe(row.key);
  });
});
