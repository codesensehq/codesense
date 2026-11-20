// SPDX-License-Identifier: MIT
// The Foreman story view reads `sessionUsage` rows, and a session charged to more than one story
// is one row per segment: its counts are of distinct sessions, never of rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const kit = readFileSync(
  new URL("../codesense-docs/packs/codesense-foreman/vendor/story-view.js", import.meta.url),
  "utf8",
);
const source = (pattern) => {
  const found = pattern.exec(kit);
  assert.ok(found, `the vendored kit has ${pattern}`);
  return found[0];
};
const COPY = { spend: { partial: "partial", unpricedSome: (n) => `${n} unpriced` } };
const money = (usd) => `$${usd.toFixed(2)}`;
const { distinctSessions, spendFromUsage } = new Function(
  "COPY",
  "money",
  `${source(/function distinctSessions\(rows\)\{.*\}\n/)}${source(/function spendFromUsage\([\s\S]*?\n\}\n/)}return {distinctSessions, spendFromUsage};`,
)(COPY, money);

test("a session's segments count as one session", () => {
  const rows = [
    { cli: "claude", sessionId: "seat", costUsd: 2, segment: { fromMs: 5, toMs: null } },
    { cli: "claude", sessionId: "seat", costUsd: 1, segment: { fromMs: null, toMs: 5 } },
    { cli: "codex", sessionId: "seat", costUsd: 1 },
    { cli: "claude", sessionId: "other", costUsd: 1 },
  ];
  assert.equal(distinctSessions(rows), 3);
});

test("the spend line sums every row and counts unpriced sessions, not rows", () => {
  const spend = spendFromUsage({
    sessions: [
      { cli: "claude", sessionId: "seat", costUsd: null, segment: { fromMs: 5, toMs: null } },
      { cli: "claude", sessionId: "seat", costUsd: null, segment: { fromMs: null, toMs: 5 } },
      { cli: "claude", sessionId: "other", costUsd: 3 },
      { cli: "claude", sessionId: "third", costUsd: 1.5 },
    ],
  });
  assert.deepEqual(spend, { text: "$4.50 · 1 unpriced", known: true });
});
