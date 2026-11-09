// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assembleChangelog, parseFragment } from "./lib/changelog-fragments.mjs";
import { isUserFacing, presenceError } from "./changelog-lint.mjs";
import { parseArgs, run } from "./changelog-assemble.mjs";

const CHANGELOG = `# Changelog

Intro.

## [Unreleased]

### Changed

- **Existing.** Already here.

## [0.1.0] - 2026-11-06

First release.

### Added

- **Old.** Untouched.

[Unreleased]: https://example.test/r/compare/v0.1.0...HEAD
[0.1.0]: https://example.test/r/releases/tag/v0.1.0
`;

const fragment = (type, entry) => `---\ntype: ${type}\n---\n\n${entry}\n`;

test("a fragment needs a known type, a slug name and exactly one line", () => {
  assert.deepEqual(parseFragment("a-b.md", fragment("fixed", "**Lead.** Text.")), {
    type: "fixed",
    entry: "**Lead.** Text.",
  });
  assert.equal(parseFragment("a.md", fragment("fixed", "- Bullet.")).entry, "Bullet.");
  assert.match(parseFragment("A_b.md", fragment("fixed", "x")).error, /name must be/);
  assert.match(parseFragment("a.md", fragment("tweaked", "x")).error, /type must be one of/);
  assert.match(parseFragment("a.md", fragment("fixed", "one\ntwo")).error, /exactly one line/);
  assert.match(parseFragment("a.md", fragment("fixed", "")).error, /exactly one line/);
  assert.match(parseFragment("a.md", "no front matter\n").error, /front matter/);
  assert.match(
    parseFragment("a.md", "---\ntype: fixed\nscope: x\n---\nEntry.\n").error,
    /exactly one line, type/,
  );
});

test("fragments fold into [Unreleased] by section order, then file name", () => {
  const out = assembleChangelog(
    CHANGELOG,
    [
      { name: "b.md", type: "fixed", entry: "**B.** Fixed." },
      { name: "a.md", type: "fixed", entry: "**A.** Fixed." },
      { name: "c.md", type: "added", entry: "**C.** Added." },
      { name: "d.md", type: "changed", entry: "**D.** Changed." },
    ].sort((x, y) => x.name.localeCompare(y.name)),
  );
  const unreleased = out.slice(out.indexOf("## [Unreleased]"), out.indexOf("## [0.1.0]"));
  assert.equal(
    unreleased,
    "## [Unreleased]\n\n### Added\n\n- **C.** Added.\n\n### Changed\n\n- **Existing.** Already here.\n- **D.** Changed.\n\n### Fixed\n\n- **A.** Fixed.\n- **B.** Fixed.\n\n",
  );
  assert.ok(out.endsWith(CHANGELOG.slice(CHANGELOG.indexOf("## [0.1.0]"))));
});

test("the result does not depend on the order fragments are passed in", () => {
  const fragments = [
    { name: "a.md", type: "fixed", entry: "A." },
    { name: "b.md", type: "added", entry: "B." },
  ];
  assert.equal(
    assembleChangelog(CHANGELOG, fragments),
    assembleChangelog(CHANGELOG, [...fragments].reverse()),
  );
});

test("no fragments leaves the changelog unchanged", () => {
  assert.equal(assembleChangelog(CHANGELOG, []), CHANGELOG);
});

test("a release turns [Unreleased] into the version's section and updates the links", () => {
  const text = CHANGELOG.replace("## [Unreleased]\n", "## [Unreleased]\n\nSummary paragraph.\n");
  const out = assembleChangelog(text, [{ name: "a.md", type: "fixed", entry: "A." }], {
    version: "0.1.1",
    date: "2026-11-20",
  });
  assert.match(
    out,
    /## \[Unreleased\]\n\n## \[0\.1\.1\] - 2026-11-20\n\nSummary paragraph\.\n\n### Changed\n\n- \*\*Existing\.\*\* Already here\.\n\n### Fixed\n\n- A\.\n\n## \[0\.1\.0\]/,
  );
  assert.match(
    out,
    /\[Unreleased\]: https:\/\/example\.test\/r\/compare\/v0\.1\.1\.\.\.HEAD\n\[0\.1\.1\]: https:\/\/example\.test\/r\/releases\/tag\/v0\.1\.1\n\[0\.1\.0\]:/,
  );
  assert.throws(
    () => assembleChangelog(out, [], { version: "0.1.1", date: "2026-11-20" }),
    /nothing to release/,
  );
  assert.throws(
    () => assembleChangelog(text, [], { version: "0.1.0", date: "2026-11-20" }),
    /already has a 0\.1\.0 section/,
  );
  assert.throws(
    () => assembleChangelog(text, [], { version: "v1", date: "2026-11-20" }),
    /X\.Y\.Z/,
  );
  assert.throws(() => parseArgs(["--version", "0.1.1"]), /needs --date/);
});

test("assembling writes CHANGELOG.md and deletes only the folded fragments; dry run changes nothing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-"));
  try {
    fs.writeFileSync(path.join(root, "CHANGELOG.md"), CHANGELOG);
    fs.mkdirSync(path.join(root, "changes"));
    fs.writeFileSync(path.join(root, "changes", "README.md"), "# Readme\n");
    fs.writeFileSync(path.join(root, "changes", "x.md"), fragment("fixed", "X."));
    const dry = run({ root, dryRun: true });
    assert.match(dry.text, /### Fixed\n\n- X\./);
    assert.equal(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), CHANGELOG);
    assert.ok(fs.existsSync(path.join(root, "changes", "x.md")));
    run({ root, version: "0.1.1", date: "2026-11-20" });
    assert.match(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), /## \[0\.1\.1\]/);
    assert.deepEqual(fs.readdirSync(path.join(root, "changes")), ["README.md"]);
    fs.writeFileSync(path.join(root, "changes", "bad.md"), "Entry.\n");
    assert.throws(() => run({ root }), /changes\/bad\.md: must start with front matter/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a pull request that changes the app needs a fragment, a label or a release edit", () => {
  const app = ["M\tsrc/features/inbox/view.tsx"];
  assert.match(presenceError({ changes: app }), /adds no changelog entry/);
  assert.equal(presenceError({ changes: [...app, "A\tchanges/inbox.md"] }), "");
  assert.equal(presenceError({ changes: [...app, "M\tchanges/inbox.md"] }), "");
  assert.match(presenceError({ changes: [...app, "D\tchanges/inbox.md"] }), /no changelog/);
  assert.match(presenceError({ changes: [...app, "A\tchanges/README.md"] }), /no changelog/);
  assert.equal(presenceError({ changes: [...app, "M\tCHANGELOG.md"] }), "");
  assert.equal(presenceError({ changes: app, labels: ["no-changelog"] }), "");
  assert.equal(presenceError({ changes: app, author: "dependabot[bot]" }), "");
  assert.equal(presenceError({ changes: ["M\tscripts/x.mjs", "M\tREADME.md"] }), "");
});

test("tests under the app's source don't count as user-facing", () => {
  assert.ok(isUserFacing("src/a.tsx"));
  assert.ok(isUserFacing("src-tauri/src/mcp/handler.rs"));
  assert.ok(!isUserFacing("src/a.test.tsx"));
  assert.ok(!isUserFacing("src-tauri/src/agents/tests.rs"));
  assert.ok(!isUserFacing("src-tauri/src/mcp/handler_tests.rs"));
  assert.ok(!isUserFacing("src-tauri/tests/fixtures/a.json"));
  assert.ok(!isUserFacing("scripts/a.mjs"));
});
