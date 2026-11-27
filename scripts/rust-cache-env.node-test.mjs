// SPDX-License-Identifier: MIT
// node --test scripts/rust-cache-env.node-test.mjs
// Swatinem/rust-cache hashes every CARGO* and RUST* environment variable into its key, so a job
// that restores another job's shared-key cache with a different set of them never hits it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parse } from "yaml";

const read = (file) =>
  parse(fs.readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"));

// The CARGO* and RUST* variables a job's steps see (the workflow's env, then the job's) and the
// shared key it restores.
function cacheOf(file, id) {
  const workflow = read(file);
  const job = workflow.jobs[id];
  const env = Object.entries({ ...workflow.env, ...job.env })
    .filter(([name]) => /^(CARGO|RUST)/.test(name))
    .sort(([a], [b]) => a.localeCompare(b));
  const step = job.steps.find((s) => s.uses?.startsWith("Swatinem/rust-cache@"));
  return { runsOn: job["runs-on"], key: step?.with?.["shared-key"], env: Object.fromEntries(env) };
}

test("frame-security restores rust-linux-app's cache with that job's exact env", () => {
  assert.deepEqual(cacheOf("tests.yml", "frame-security"), cacheOf("rust.yml", "rust-linux-app"));
});
