// SPDX-License-Identifier: MIT
// node --test scripts/tiles-release-gate.node-test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { releaseGate } from "./tiles-release-gate.mjs";

const script = fileURLToPath(new URL("./tiles-release-gate.mjs", import.meta.url));

// The shape of Playwright's JSON reporter: each spec once per project, its outcome in `status`.
const run = (title, project, status, message = "") => ({
  title,
  tests: [
    {
      projectName: project,
      status,
      results: message ? [{ status: "failed", error: { message } }] : [{ status: "passed" }],
    },
  ],
});
const report = (outcomes) => ({
  suites: [
    {
      title: "tiles/axe.spec.ts",
      file: "tiles/axe.spec.ts",
      specs: outcomes.map(([status, message], i) =>
        run(`case ${i} @p1`, i % 2 ? "tiles-webkit" : "tiles-chromium", status, message),
      ),
      suites: [],
    },
  ],
  errors: [],
});
const passing = (n) => Array.from({ length: n }, () => ["expected"]);
const failing = (message) => ["unexpected", message];

test("19 of 20 passed meets the 95% bar", () => {
  const gate = releaseGate(report([...passing(19), failing("axe: 2 violations")]));
  assert.equal(gate.ok, true);
  assert.equal(gate.passed, 19);
  assert.equal(gate.total, 20);
  assert.match(gate.markdown, /19 of 20 passed \(95\.0%\)/);
  // A pass still lists the failure for triage.
  assert.match(
    gate.markdown,
    /tiles\/axe\.spec\.ts › case 19 @p1.*tiles-webkit.*axe: 2 violations/,
  );
});

test("18 of 20 fails and lists each failure", () => {
  const gate = releaseGate(
    report([...passing(18), failing("first\nsecond line"), failing("timed out")]),
  );
  assert.equal(gate.ok, false);
  assert.equal(gate.failures.length, 2);
  assert.match(gate.markdown, /18 of 20 passed \(90\.0%\); the release needs 95%/);
  assert.match(gate.markdown, /case 18 @p1.*tiles-chromium \| first \|$/m);
  assert.doesNotMatch(gate.markdown, /second line/);
  assert.match(gate.markdown, /case 19 @p1.*timed out/);
});

test("zero tests fails closed", () => {
  const gate = releaseGate({ suites: [], errors: [] });
  assert.equal(gate.ok, false);
  assert.match(gate.markdown, /No @p1 test ran/);
});

test("a flaky pass counts as passed; a skip counts as not passed", () => {
  const gate = releaseGate(report([...passing(18), ["flaky"], ["skipped"]]));
  assert.equal(gate.ok, true);
  assert.equal(gate.passed, 19);
  assert.equal(gate.total, 20);
  assert.match(gate.markdown, /19 of 20 passed \(95\.0%\)\. 1 skipped\./);
  assert.match(gate.markdown, /case 19 @p1.*tiles-webkit \| skipped \|$/m);
  // A mostly skipped run never reads as green.
  const skipped = releaseGate(report([...passing(1), ...Array(99).fill(["skipped"])]));
  assert.equal(skipped.ok, false);
  assert.match(skipped.markdown, /1 of 100 passed \(1\.0%\)/);
  assert.equal(releaseGate(report([["skipped"]])).ok, false);
});

test("a run error (a spec that failed to load) fails", () => {
  const gate = releaseGate({ ...report(passing(20)), errors: [{ message: "SyntaxError: boom" }] });
  assert.equal(gate.ok, false);
  assert.match(gate.markdown, /SyntaxError: boom/);
});

test("the CLI writes the job summary and exits 1 below the bar", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiles-release-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const summary = path.join(dir, "summary.md");
  const good = path.join(dir, "good.json");
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(good, JSON.stringify(report(passing(20))));
  fs.writeFileSync(bad, JSON.stringify(report([...passing(1), failing("broken")])));
  const env = { ...process.env, GITHUB_STEP_SUMMARY: summary };
  const ok = spawnSync(process.execPath, [script, good], { encoding: "utf8", env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(fs.readFileSync(summary, "utf8"), /20 of 20 passed/);
  const no = spawnSync(process.execPath, [script, bad], { encoding: "utf8", env });
  assert.equal(no.status, 1);
  assert.match(
    no.stdout,
    /::error title=Release gate::tiles\/axe\.spec\.ts › case 1 @p1 \(tiles-webkit\)/,
  );
  assert.match(fs.readFileSync(summary, "utf8"), /1 of 2 passed/);
  // A missing report (the run never wrote one) fails too.
  const missing = spawnSync(process.execPath, [script, path.join(dir, "none.json")], { env });
  assert.equal(missing.status, 1);
});
