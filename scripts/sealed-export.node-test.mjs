// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG, referenceInputs } from "./generate-mcp-reference.mjs";
import { FROZEN_EXPORTS, frozenExport, strictExports } from "./lib/sealed-export.mjs";

test("the export pins compare strictly only when CS_STRICT_EXPORTS is 1", () => {
  assert.equal(strictExports({ CS_STRICT_EXPORTS: "1" }), true);
  for (const value of [undefined, "", "0", "true", " 1"])
    assert.equal(strictExports({ CS_STRICT_EXPORTS: value }), false, String(value));
  assert.equal(strictExports({}), false);
});

const GENERATED = "codesense-docs/getting-started/content/generated";

test("FROZEN_EXPORTS lists exactly the cargo-written exports", () => {
  assert.deepEqual(FROZEN_EXPORTS, [
    `${GENERATED}/live-data-contract.json`,
    `${GENERATED}/live-data-contract.inputs.json`,
    `${GENERATED}/mcp-tools.default.json`,
    `${GENERATED}/mcp-tools.dashboard-publish.json`,
    `${GENERATED}/mcp-tools.inputs.json`,
    "src-tauri/src/docs_schemas.generated.json",
  ]);
  assert.ok(Object.isFrozen(FROZEN_EXPORTS));
  // Node renders these from the exports, so PRs keep editing them.
  for (const path of [
    `${GENERATED}/mcp-tools.json`,
    `${GENERATED}/schemas/routine-yml.schema.json`,
    `${GENERATED}/schemas.json`,
    "codesense-docs/getting-started/content/arc-g-routines/routine-yml.html",
  ])
    assert.ok(!FROZEN_EXPORTS.includes(path), path);
  assert.ok(!FROZEN_EXPORTS.some((path) => path.endsWith(".schema.json")));
});

test("the tool catalog is not an input of the MCP seal", () => {
  assert.ok(!(CATALOG in referenceInputs()));
  assert.ok("src-tauri/src/mcp/handler.rs" in referenceInputs());
});

test("each reader takes its own export's files from the one list", () => {
  const readers = [
    frozenExport(`${GENERATED}/live-data-contract`),
    frozenExport(`${GENERATED}/mcp-tools`),
    frozenExport("src-tauri/src/docs_schemas.generated.json"),
  ];
  assert.deepEqual(
    readers.map((files) => files.length),
    [2, 3, 1],
  );
  assert.deepEqual(readers.flat().sort(), [...FROZEN_EXPORTS].sort());
  assert.deepEqual(frozenExport(`${GENERATED}/mcp`), []);
});
