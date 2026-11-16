// SPDX-License-Identifier: MIT
// The app's copies of the Foreman's ids (the overlay's agent, role, team and history, the launch
// grant's agents) against the pack's own config: `check:foreman-page` runs this drift check too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CONSTANT_FILES, constantProblems } from "./lib/foreman-constants.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function scratch(edit) {
  const root = mkdtempSync(join(tmpdir(), "foreman-constants-"));
  for (const rel of CONSTANT_FILES) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    cpSync(join(ROOT, rel), join(root, rel));
  }
  const change = (rel, from, to) => {
    const text = readFileSync(join(root, rel), "utf8");
    assert.ok(text.includes(from), `${rel} holds ${from}`);
    writeFileSync(join(root, rel), text.replace(from, to));
  };
  try {
    edit(change);
    return constantProblems(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const one = (found, text) => {
  assert.equal(found.length, 1, found.join("\n"));
  assert.match(found[0], text);
};

test("the app's Foreman constants and the launch grant agree with the pack", () => {
  assert.deepEqual(constantProblems(ROOT), []);
});

test("a history, role, agent or docs team that drifts from the pack fails", () => {
  one(
    scratch((change) =>
      change("src/features/foreman/use-foreman-thread.ts", "FOREMAN_HISTORY = 5", "FOREMAN_HISTORY = 6"),
    ),
    /FOREMAN_HISTORY 6 is not the pack's foreman\.history 5/,
  );
  one(
    scratch((change) =>
      change("src/features/foreman/open-foreman.ts", 'FOREMAN_ROLE = "codesense-foreman"', 'FOREMAN_ROLE = "foreman"'),
    ),
    /FOREMAN_ROLE "foreman" is not the pack's foreman\.role/,
  );
  one(
    scratch((change) =>
      change("src/shared/lib/codesense-docs.ts", 'CODESENSE_DOCS_TEAM = "getting-started"', 'CODESENSE_DOCS_TEAM = "start"'),
    ),
    /FOREMAN_TEAM .* is not the pack's foreman\.docs/,
  );
  one(
    scratch((change) =>
      change(
        "src-tauri/src/verbs/foreman_launch.rs",
        'FOREMAN_KEY: &str = "codesense/docs/getting-started/foreman-claude"',
        'FOREMAN_KEY: &str = "codesense/docs/getting-started/foreman-codex"',
      ),
    ),
    /FOREMAN_KEY .* is not the pack's foreman\.agents\[0\]/,
  );
});

// isForemanAgent matches a bare id or a key ending in `/<id>`: every agent the pack launches must
// end in FOREMAN_AGENT, or the overlay would not know the Foreman the page started.
test("a pack agent isForemanAgent would not match, or a matcher without the suffix rule, fails", () => {
  one(
    scratch((change) =>
      change(
        "codesense-docs/packs/codesense-foreman/story-view.yml",
        "- codesense/docs/getting-started/foreman-claude",
        "- codesense/docs/getting-started/foreman-claude-2",
      ),
    ),
    /isForemanAgent does not match the pack's agent "codesense\/docs\/getting-started\/foreman-claude-2"/,
  );
  const found = scratch((change) =>
    change("src/features/foreman/open-foreman.ts", "id.endsWith(`/${FOREMAN_AGENT}`)", "false"),
  );
  assert.ok(
    found.some((line) => /isForemanAgent no longer matches a key ending in \/FOREMAN_AGENT/.test(line)),
    found.join("\n"),
  );
});
