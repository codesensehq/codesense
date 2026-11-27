// SPDX-License-Identifier: MIT
// node --test scripts/stray-specs.node-test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ALLOWLIST, handList, parseAllowlist, strayErrors } from "./stray-specs.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(root, "scripts/stray-specs.mjs");

const workflow = (name = "Run the mock layout specs") => `on: [pull_request]
jobs:
  mock-layout:
    steps:
      - name: Install Chromium
        run: pnpm exec playwright install --with-deps chromium
      - name: ${name}
        run: >-
          pnpm exec playwright test -c playwright.mock.config.ts --project=chromium --workers=1
          tests/e2e-mock/boot.spec.ts
          tests/e2e-mock/focus.spec.ts
`;

test("the hand list is read from the mock layout step", () => {
  assert.deepEqual(handList(workflow()), [
    "tests/e2e-mock/boot.spec.ts",
    "tests/e2e-mock/focus.spec.ts",
  ]);
});

test("a renamed or missing hand-list step fails loudly", () => {
  assert.throws(
    () => handList(workflow("Run the layout specs")),
    /no step named "Run the mock layout specs"/,
  );
  assert.throws(
    () =>
      handList(
        workflow().replace(
          "tests/e2e-mock/boot.spec.ts\n          tests/e2e-mock/focus.spec.ts\n",
          "\n",
        ),
      ),
    /lists no specs/,
  );
});

test("the allowlist reads one path a line, skipping comments and blank lines", () => {
  assert.deepEqual(
    parseAllowlist("# seed\n\ntests/e2e-mock/a.spec.ts\n  tests/e2e-mock/b.spec.ts  \n"),
    ["tests/e2e-mock/a.spec.ts", "tests/e2e-mock/b.spec.ts"],
  );
});

const tree = {
  specs: [
    "tests/e2e-mock/boot.spec.ts",
    "tests/e2e-mock/old.spec.ts",
    "tests/e2e-mock/tiles/probe-dashboard.spec.ts",
    "tests/e2e-mock/tiles/deep/nested.spec.ts",
  ],
  handList: ["tests/e2e-mock/boot.spec.ts"],
  allowlist: ["tests/e2e-mock/old.spec.ts", "tests/e2e-mock/perf-baseline.spec.ts"],
};

test("today's tree with the seeded allowlist passes, even naming a file that does not exist yet", () => {
  assert.deepEqual(strayErrors({ ...tree, baseAllowlist: tree.allowlist }), []);
});

test("a base with no allowlist takes this file as its seed", () => {
  assert.deepEqual(strayErrors({ ...tree, baseAllowlist: null }), []);
});

test("a new spec outside tiles/, the hand list and the allowlist fails", () => {
  const errors = strayErrors({
    ...tree,
    specs: [...tree.specs, "tests/e2e-mock/new-thing.spec.ts"],
    baseAllowlist: tree.allowlist,
  });
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /tests\/e2e-mock\/new-thing\.spec\.ts: a mock spec outside tests\/e2e-mock\/tiles\//,
  );
});

test("adding a line against the base copy fails; removing one passes", () => {
  const added = strayErrors({
    ...tree,
    allowlist: [...tree.allowlist, "tests/e2e-mock/new-thing.spec.ts"],
    baseAllowlist: tree.allowlist,
  });
  assert.equal(added.length, 1);
  assert.match(added[0], /new-thing\.spec\.ts: the allowlist may only shrink/);
  assert.deepEqual(
    strayErrors({
      ...tree,
      specs: tree.specs.filter((spec) => !spec.endsWith("old.spec.ts")),
      allowlist: ["tests/e2e-mock/perf-baseline.spec.ts"],
      baseAllowlist: tree.allowlist,
    }),
    [],
  );
});

test("a line listed twice fails", () => {
  assert.match(
    strayErrors({
      ...tree,
      allowlist: [...tree.allowlist, tree.allowlist[0]],
      baseAllowlist: null,
    })[0],
    /old\.spec\.ts: listed twice/,
  );
});

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stray-specs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "ci@example.com");
  git(dir, "config", "user.name", "CI");
  git(dir, "config", "commit.gpgsign", "false");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  write(".github/workflows/tests.yml", workflow());
  for (const spec of ["boot", "focus", "old"]) write(`tests/e2e-mock/${spec}.spec.ts`, "");
  write("tests/e2e-mock/tiles/probe-dashboard.spec.ts", "");
  const commit = (message) => {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", message);
    return git(dir, "rev-parse", "HEAD");
  };
  return { dir, write, commit };
}
const run = (cwd, ...args) =>
  spawnSync(process.execPath, [script, "--root", cwd, ...args], { encoding: "utf8" });

test("the CLI guards a repository against its base commit", (t) => {
  const { dir, write, commit } = repo(t);
  const before = commit("no allowlist");
  write(ALLOWLIST, "tests/e2e-mock/old.spec.ts\n");
  const seeded = commit("seed");
  // The base has no allowlist: the file is its own seed.
  const first = run(dir, "--base", before);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /stray-specs: 4 mock specs, 1 allowlisted/);
  // Growing it against the seeded base fails.
  write(ALLOWLIST, "tests/e2e-mock/old.spec.ts\ntests/e2e-mock/new.spec.ts\n");
  write("tests/e2e-mock/new.spec.ts", "");
  commit("grow");
  const grown = run(dir, "--base", seeded);
  assert.equal(grown.status, 1);
  assert.match(grown.stderr, /new\.spec\.ts: the allowlist may only shrink/);
  // No base (a dispatched run) checks the tree only.
  assert.equal(run(dir).status, 0);
  assert.equal(run(dir, "--base", "").status, 0);
  // A base that is not a commit here fails rather than passing silently.
  const missing = run(dir, "--base", "0123456789abcdef0123456789abcdef01234567");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /base 0123456789ab.* is not a commit in this checkout/);
});

test("the CLI fails on an unlisted spec and on a renamed hand-list step", (t) => {
  const { dir, write, commit } = repo(t);
  write(ALLOWLIST, "tests/e2e-mock/old.spec.ts\n");
  write("tests/e2e-mock/stray.spec.ts", "");
  commit("stray");
  const stray = run(dir);
  assert.equal(stray.status, 1);
  assert.match(stray.stderr, /stray\.spec\.ts: a mock spec outside tests\/e2e-mock\/tiles\//);
  fs.rmSync(path.join(dir, "tests/e2e-mock/stray.spec.ts"));
  write(".github/workflows/tests.yml", workflow("Run layout"));
  commit("rename");
  const renamed = run(dir);
  assert.equal(renamed.status, 1);
  assert.match(renamed.stderr, /no step named "Run the mock layout specs"/);
});

test("this repository passes: the seed covers today's specs", () => {
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
