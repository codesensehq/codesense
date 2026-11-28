// SPDX-License-Identifier: MIT
// node --test scripts/nightly.node-test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LABEL, MARKER, emptyLane, failedLanes, perfPlan, trackNightly } from "./nightly.mjs";

const script = fileURLToPath(new URL("./nightly.mjs", import.meta.url));

// --- The perf lane's plan: compare against the runner's own set, never the M1 one.

const files = { harness: true, tool: true };
const m1 = { runner: "m1", engine: "webkit", rows: { switch: { p50: 80, p95: 120 } } };
const ci = { runner: "macos-15", engine: "webkit", rows: { switch: { p50: 140, p95: 210 } } };

test("a baseline with only M1 rows skips with the summary line", () => {
  assert.deepEqual(perfPlan({ baseline: { sets: [m1] }, ...files }), {
    mode: "skip",
    reason: "no runner: macos-15 set in tests/fixtures/perf-baseline.json",
  });
});

test("the macos-15 set is selected beside the M1 one, as a list or keyed", () => {
  assert.deepEqual(perfPlan({ baseline: { sets: [m1, ci] }, ...files }), { mode: "compare" });
  assert.deepEqual(perfPlan({ baseline: { sets: { m1, ci } }, ...files }), { mode: "compare" });
});

test("no harness, tool or baseline file skips; record mode needs only the harness and tool", () => {
  assert.deepEqual(perfPlan({ baseline: { sets: [ci] }, harness: false, tool: true }), {
    mode: "skip",
    reason: "no tests/e2e-mock/perf-baseline.spec.ts yet",
  });
  assert.deepEqual(perfPlan({ baseline: { sets: [ci] }, harness: true, tool: false }), {
    mode: "skip",
    reason: "no scripts/perf-baseline.mjs yet",
  });
  assert.deepEqual(perfPlan({ baseline: null, ...files }), {
    mode: "skip",
    reason: "no tests/fixtures/perf-baseline.json yet",
  });
  assert.deepEqual(perfPlan({ baseline: null, ...files, record: true }), { mode: "record" });
  assert.equal(perfPlan({ baseline: null, harness: false, tool: true, record: true }).mode, "skip");
  assert.equal(perfPlan({ baseline: null, harness: true, tool: false, record: true }).mode, "skip");
});

test("the perf-plan CLI writes the mode output and the skip line to the summary", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-perf-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const baseline = path.join(dir, "perf-baseline.json");
  const spec = path.join(dir, "perf-baseline.spec.ts");
  const tool = path.join(dir, "perf-baseline.mjs");
  fs.writeFileSync(baseline, JSON.stringify({ sets: [m1] }));
  fs.writeFileSync(spec, "");
  fs.writeFileSync(tool, "");
  const env = {
    ...process.env,
    GITHUB_OUTPUT: path.join(dir, "output"),
    GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
  };
  const plan = (...args) =>
    spawnSync(
      process.execPath,
      [script, "perf-plan", "--baseline", baseline, "--harness", spec, "--tool", tool, ...args],
      {
        encoding: "utf8",
        env,
      },
    );
  assert.equal(plan().status, 0);
  assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, "utf8"), "mode=skip\n");
  assert.equal(
    fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"),
    "perf lane skipped: no runner: macos-15 set in tests/fixtures/perf-baseline.json\n",
  );
  assert.equal(plan("--record", "true").status, 0);
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, "utf8"), /mode=record\n$/);
  // The dispatch input arrives as text: anything but "true" is a plain run.
  assert.equal(plan("--record", "false").status, 0);
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, "utf8"), /mode=skip\n$/);
  // Until the tool lands, the lane skips and says why.
  fs.rmSync(tool);
  assert.equal(plan().status, 0);
  assert.match(
    fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"),
    /perf lane skipped: no scripts\/perf-baseline\.mjs yet\n$/,
  );
});

// --- The one nightly issue.

const needs = {
  "tiles-nightly": { result: "success" },
  "pane-harness": { result: "failure" },
  perf: { result: "success" },
  load: { result: "failure" },
};

test("the failed lanes are read from the needs context", () => {
  assert.deepEqual(failedLanes(needs), ["pane-harness", "load"]);
  assert.deepEqual(
    failedLanes({ "pane-harness": { result: "cancelled" }, perf: { result: "success" } }),
    ["pane-harness"],
  );
  assert.deepEqual(failedLanes({ perf: { result: "skipped" } }), []);
});

function stubGh(issues) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify(issues);
    if (args[0] === "issue" && args[1] === "create")
      return "https://github.com/example/repo/issues/42\n";
    return "";
  };
  return { gh, calls };
}
const options = (gh) => ({
  gh,
  runUrl: "https://github.com/example/repo/actions/runs/7",
  date: "2026-11-28",
});

test("trackNightly opens one labelled issue with the marker when none exists", () => {
  const { gh, calls } = stubGh([{ number: 3, state: "OPEN", body: "<!-- nightly-other -->" }]);
  const result = trackNightly(["pane-harness", "load"], options(gh));
  assert.deepEqual(calls[0], [
    "issue",
    "list",
    "--label",
    LABEL,
    "--state",
    "all",
    "--limit",
    "100",
    "--json",
    "number,state,body",
  ]);
  assert.equal(calls[1][0], "label");
  assert.deepEqual(calls[1].slice(0, 4), ["label", "create", LABEL, "--force"]);
  const create = calls[2];
  assert.deepEqual(create.slice(0, 2), ["issue", "create"]);
  const body = create[create.indexOf("--body") + 1];
  assert.ok(body.startsWith(`${MARKER}\n`));
  assert.match(
    body,
    /2026-11-28: pane-harness, load timed out or failed: https:\/\/github\.com\/example\/repo\/actions\/runs\/7/,
  );
  assert.equal(create[create.indexOf("--label") + 1], LABEL);
  assert.deepEqual(result, { action: "created", url: "https://github.com/example/repo/issues/42" });
});

test("trackNightly comments on the open issue, else reopens the newest closed one", () => {
  const open = stubGh([
    { number: 4, state: "CLOSED", body: `${MARKER}\nold` },
    { number: 9, state: "OPEN", body: `${MARKER}\nnow` },
  ]);
  assert.deepEqual(trackNightly(["load"], options(open.gh)), { action: "commented", number: 9 });
  assert.deepEqual(open.calls[1].slice(0, 3), ["issue", "comment", "9"]);
  assert.match(open.calls[1][4], /2026-11-28: load timed out or failed/);
  const closed = stubGh([
    { number: 4, state: "CLOSED", body: `${MARKER}\nold` },
    { number: 8, state: "CLOSED", body: `${MARKER}\nnewer` },
  ]);
  assert.deepEqual(trackNightly(["load"], options(closed.gh)), { action: "reopened", number: 8 });
  assert.deepEqual(closed.calls[1], ["issue", "reopen", "8"]);
  assert.deepEqual(closed.calls[2].slice(0, 3), ["issue", "comment", "8"]);
});

test("the issue CLI does nothing when no lane timed out or failed, and refuses without a run URL", () => {
  const env = { ...process.env, NEEDS: JSON.stringify({ perf: { result: "success" } }) };
  const quiet = spawnSync(process.execPath, [script, "issue", "--run-url", "https://x/runs/1"], {
    encoding: "utf8",
    env,
  });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.match(quiet.stdout, /nightly: no lane timed out or failed/);
  assert.equal(spawnSync(process.execPath, [script, "issue"], { env }).status, 1);
});

// pnpm 10 hands a literal `--` to the script, and Playwright then reads every later flag as a
// file filter: `pnpm run test:pane-harness -- --project=webkit` finds no tests.
test("no nightly step passes a literal -- through pnpm run", () => {
  const workflow = fs.readFileSync(
    new URL("../.github/workflows/nightly.yml", import.meta.url),
    "utf8",
  );
  assert.equal(workflow.match(/pnpm run [\w:-]+ -- .*/)?.[0], undefined);
  assert.ok(
    workflow.includes(
      "pnpm exec playwright test -c playwright.pane-harness.config.ts --project=webkit",
    ),
    "the pane-harness lane runs only the webkit project",
  );
});

// --- The @nightly tile lane's summary line when no spec ran.

test("emptyLane names a lane whose report has no runs", () => {
  assert.equal(emptyLane({ suites: [] }), true);
  const ran = { suites: [{ title: "a.spec.ts", specs: [{ title: "x", tests: [{}] }] }] };
  assert.equal(emptyLane(ran), false);
});

test("the empty-lane CLI writes the summary line, and fails on a missing report", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-empty-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const summary = path.join(dir, "summary.md");
  const empty = path.join(dir, "empty.json");
  fs.writeFileSync(empty, JSON.stringify({ suites: [], errors: [] }));
  const env = { ...process.env, GITHUB_STEP_SUMMARY: summary };
  const ok = spawnSync(process.execPath, [script, "empty-lane", empty], { encoding: "utf8", env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.readFileSync(summary, "utf8"), "tiles-nightly: no @nightly tile specs yet\n");
  const missing = spawnSync(process.execPath, [script, "empty-lane", path.join(dir, "none.json")], {
    encoding: "utf8",
    env,
  });
  assert.equal(missing.status, 1);
  assert.equal(fs.readFileSync(summary, "utf8"), "tiles-nightly: no @nightly tile specs yet\n");
});
