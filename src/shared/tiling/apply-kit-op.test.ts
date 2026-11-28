// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyKitOp, KIT_OP_FAILED, kitOpProblem } from "./apply-kit-op";
import type { KitOp } from "./kit-op";
import { parseMosaicNode, serializeMosaicNode } from "./mosaic-tree";

interface Table {
  shapes: { name: string; op: unknown; valid: boolean }[];
  apply: { name: string; before: unknown; op: KitOp; after?: unknown; fails?: true }[];
}

// The table `src-tauri/src/groups/ops_tests.rs` reads too.
const table: Table = JSON.parse(readFileSync("tests/fixtures/kit-ops.json", "utf8"));

const tree = (value: unknown) => (value === null ? null : parseMosaicNode(value));

describe("the kit ops' table", () => {
  it.each(table.shapes.map((row) => [row.name, row]))("shape: %s", (_, row) => {
    expect(kitOpProblem(row.op) === null).toBe(row.valid);
  });

  it.each(table.apply.map((row) => [row.name, row]))("apply: %s", (_, row) => {
    const result = applyKitOp(tree(row.before), row.op);
    if (row.fails) {
      expect(result).toBe(KIT_OP_FAILED);
      return;
    }
    expect(result).not.toBe(KIT_OP_FAILED);
    const after = result === null || result === KIT_OP_FAILED ? null : serializeMosaicNode(result);
    expect(after).toEqual(row.after ?? null);
  });
});
