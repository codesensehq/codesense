// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { strictExports } from "./lib/sealed-export.mjs";

test("the export pins compare strictly only when CS_STRICT_EXPORTS is 1", () => {
  assert.equal(strictExports({ CS_STRICT_EXPORTS: "1" }), true);
  for (const value of [undefined, "", "0", "true", " 1"])
    assert.equal(strictExports({ CS_STRICT_EXPORTS: value }), false, String(value));
  assert.equal(strictExports({}), false);
});
