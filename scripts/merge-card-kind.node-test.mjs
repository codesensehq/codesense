// SPDX-License-Identifier: MIT
// The Foreman story view tells a merge card from a question with `kindOf`. The needs-you set
// ports the rule to Rust (`live_hub/needs_you.rs` `card_kind`); both read one case table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const kit = readFileSync(
  new URL("../codesense-docs/packs/codesense-foreman/vendor/story-view.js", import.meta.url),
  "utf8",
);
const { cases } = JSON.parse(
  readFileSync(new URL("../tests/fixtures/merge-card-cases.json", import.meta.url), "utf8"),
);
const line = (name) => {
  const found = new RegExp(`^const ${name}=.*$`, "m").exec(kit);
  assert.ok(found, `the vendored kit defines ${name}`);
  return found[0];
};
const kindOf = new Function(
  `${["PR_LINK", "MERGE_VERB", "bodyOf", "wordsOf", "prOf", "kindOf"].map(line).join("\n")}\nreturn kindOf;`,
)();

for (const { name, summary, text, kind } of cases) {
  test(`kindOf: ${name}`, () => {
    assert.equal(kindOf({ summary, text }), kind);
  });
}
