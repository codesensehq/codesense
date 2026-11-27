// SPDX-License-Identifier: MIT
// node --test scripts/tile-tags.node-test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tileTagErrors } from "./tile-tags.mjs";

const script = fileURLToPath(new URL("./tile-tags.mjs", import.meta.url));

// The shape `playwright test --list --reporter=json` prints: one suite per file, describe blocks
// as nested suites, and each spec once per project it runs in.
const spec = (title, tags, project) => ({
  title,
  tags,
  tests: [{ projectName: project, status: "skipped" }],
});
const report = (specs, suites = []) => ({
  config: {},
  suites: [{ title: "tiles/a.spec.ts", file: "tiles/a.spec.ts", specs, suites }],
  errors: [],
});
const both = (title, tags) => [
  spec(title, tags, "tiles-webkit"),
  spec(title, tags, "tiles-chromium"),
];

test("a spec tagged once and listed on both engines passes", () => {
  assert.deepEqual(tileTagErrors(report(both("mounts @p0", ["@p0"]))), []);
  assert.deepEqual(tileTagErrors(report(both("drifts @nightly", ["@nightly"]))), []);
  assert.deepEqual(tileTagErrors(report(both("axe @p1", ["@p1"]))), []);
});

test("an empty list passes: no tile specs yet", () => {
  assert.deepEqual(tileTagErrors({ config: {}, suites: [], errors: [] }), []);
});

test("an untagged spec fails", () => {
  const errors = tileTagErrors(report(both("mounts", [])));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /tiles\/a\.spec\.ts › mounts: needs exactly one gate tag/);
});

test("a spec with two gate tags fails; a tag that is not a gate does not count", () => {
  assert.match(
    tileTagErrors(report(both("mounts @p0 @nightly", ["@p0", "@nightly"])))[0],
    /needs exactly one gate tag .*has @p0, @nightly/,
  );
  assert.deepEqual(tileTagErrors(report(both("mounts @p0 @slow", ["@p0", "@slow"]))), []);
});

test("a spec listed for only one engine fails", () => {
  const errors = tileTagErrors(report([spec("mounts @p0", ["@p0"], "tiles-webkit")]));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /mounts @p0: listed for tiles-webkit only; must run on both/);
});

test("specs in describe blocks are keyed by their full title, so twins don't hide each other", () => {
  const inner = (title, project) => ({
    title,
    specs: [spec("mounts @p0", ["@p0"], project)],
    suites: [],
  });
  // Two describes with the same spec title, each on one engine: two failures, not one pass.
  const errors = tileTagErrors(
    report([], [inner("left", "tiles-webkit"), inner("right", "tiles-chromium")]),
  );
  assert.equal(errors.length, 2);
  assert.match(errors[0], /tiles\/a\.spec\.ts › left › mounts @p0: listed for tiles-webkit only/);
  assert.match(errors[1], /right › mounts @p0: listed for tiles-chromium only/);
});

test("a spec in a project other than the tile engines fails", () => {
  const errors = tileTagErrors(
    report([...both("mounts @p0", ["@p0"]), spec("mounts @p0", ["@p0"], "chromium")]),
  );
  assert.match(errors[0], /listed for chromium, tiles-chromium, tiles-webkit/);
});

test("a list error (a spec that fails to load) fails", () => {
  const listed = { config: {}, suites: [], errors: [{ message: "SyntaxError: boom" }] };
  assert.match(tileTagErrors(listed)[0], /could not list the tile specs: SyntaxError: boom/);
});

test("the CLI reads the report file and exits 1 with each error", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tile-tags-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const good = path.join(dir, "good.json");
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(good, JSON.stringify(report(both("mounts @p0", ["@p0"]))));
  fs.writeFileSync(bad, JSON.stringify(report(both("mounts", []))));
  const ok = spawnSync(process.execPath, [script, good], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /tile-tags: 1 spec on both engines, each with one gate tag/);
  const empty = path.join(dir, "empty.json");
  fs.writeFileSync(empty, JSON.stringify({ config: {}, suites: [], errors: [] }));
  assert.match(
    spawnSync(process.execPath, [script, empty], { encoding: "utf8" }).stdout,
    /no tile specs yet/,
  );
  const no = spawnSync(process.execPath, [script, bad], { encoding: "utf8" });
  assert.equal(no.status, 1);
  assert.match(no.stderr, /mounts: needs exactly one gate tag/);
  assert.equal(spawnSync(process.execPath, [script], { encoding: "utf8" }).status, 1);
});
