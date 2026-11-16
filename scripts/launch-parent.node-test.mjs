// SPDX-License-Identifier: MIT
// The JS twin of the launch-time `{{launch_parent}}` expansion runs the case file the Rust
// tests read (`permissions::expand_launch_parent`), so the two never drift.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { expandLaunchParent, holdsLaunchParent } from "./lib/launch-parent.mjs";

const cases = JSON.parse(
  readFileSync(
    new URL("../src-tauri/src/agents/testdata/launch_parent_cases.json", import.meta.url),
    "utf8",
  ),
);

test("the shared case file has the expansion and fail-closed rows", () => {
  assert.ok(cases.length >= 15);
});

for (const c of cases) {
  test(c.name, () => {
    const expansion = expandLaunchParent(c.settings, c.cwd);
    assert.deepEqual(expansion.content, c.expect);
    assert.deepEqual(expansion.unexpanded, c.unexpanded);
    // A rule holds the token exactly when the expansion changes or reports one.
    const changed =
      JSON.stringify(expansion.content) !== JSON.stringify(c.settings) ||
      expansion.unexpanded.length > 0;
    assert.equal(holdsLaunchParent(c.settings), changed);
  });
}

test("the input settings are never changed", () => {
  const settings = { permissions: { allow: ["Edit(//{{launch_parent}}/x/**)"] } };
  expandLaunchParent(settings, "/a/b/c");
  assert.deepEqual(settings, { permissions: { allow: ["Edit(//{{launch_parent}}/x/**)"] } });
});
