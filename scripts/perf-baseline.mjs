#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Frontend perf baselines: compare a measured file against a runner's recorded set, or record
 * that runner's set from a measured file.
 *
 *   node scripts/perf-baseline.mjs compare --current <file> --runner <name> [--baseline <file>]
 *   node scripts/perf-baseline.mjs record  --current <file> --runner <name> [--baseline <file>]
 *
 * The measured file is what `tests/e2e-mock/perf-baseline.spec.ts` writes (`PERF_BASELINE_OUT`):
 * `{engine, runs, commit, date, throttle, keys: {<key>: {unit, samples: [{ms|fps|mib, endState}]}}}`,
 * where `unit` is `ms`, `fps` or `MiB` and the sample field is `ms`, `fps` or `mib` to match; any
 * other unit is an input error.
 * The baseline (default `tests/fixtures/perf-baseline.json`) holds one set per runner, a `compare`
 * block and an optional open-time `budget`: `{compare: {keys, tolerancePercent, floor: {ms, fps}},
 * budget: {runner, p95Ms, keys}, sets: [{runner, engine, runs, commit, date, throttle, keys: {<key>:
 * {unit, p50, p95|p5, samples, endState}}}]}`: p95 for `ms` and `MiB` (lower is better), p5 for
 * `fps`.
 *
 * compare: for each `compare.keys` key, the current median against the runner set's p50. A time key
 * regresses when median > p50 × (1 + tol) and median − p50 > floor.ms; an fps key when median < p50
 * × (1 − tol) and p50 − median > floor.fps. Tolerance and floor come only from the file. Prints one
 * `PASS|FAIL` line per key, with `<set's end state> -> <current>` when the two differ, and a
 * verdict; with `$GITHUB_STEP_SUMMARY` set it appends the verdict and a table there. For
 * `budget.runner` alone it then checks each `budget.keys` key's current p95 against `p95Ms`, from
 * the current samples only (the key needs no set entry and no `compare.keys` entry): a p95 over it
 * prints `FAIL <key> p95 <n>ms > budget <p95Ms>` and the verdict names the key. Exit 0 when every
 * key passes or the runner has no set, 1 on any regression or a key over budget, 2 on an input
 * error (a bad file or shape, a malformed budget block, a missing key, a budget key not in ms,
 * fewer than 3 samples, an engine mismatch, a bad argument) or any unexpected error.
 *
 * record: replaces (or adds) only that runner's set; every other set keeps its bytes. A runner
 * other than m1 never records the `M1_ONLY_KEYS` (`team_switch`): they are dropped. A key of the
 * previous set that this run didn't measure is kept; outside m1 (whose hand-measured keys are
 * meant to stay) record names each one, since the set now carries the new commit. Prints each
 * key's spread over its samples: a key can join `compare.keys` when the spread is ≤ 10% of the
 * median or the range is within floor.ms. `compare.keys` itself is edited by hand. On
 * `budget.runner` it also prints each budget key's FAIL line, or `budget <key>: not measured` for a
 * key the run left out, and still exits 0; the `budget` block is kept as it is.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_BASELINE = path.join(REPO, "tests/fixtures/perf-baseline.json");
const MIN_SAMPLES = 3;
const SPREAD_LIMIT = 0.1;
const M1_RUNNER = "m1";
/** Keys only the M1 set holds: `team_switch` records today's switch and is never compared. */
export const M1_ONLY_KEYS = ["team_switch"];

export class InputError extends Error {
  exitCode = 2;
}

/** Nearest-rank percentile: the value at rank ceil(q × n) of the sorted samples. */
export function percentile(values, q) {
  if (!values.length) throw new InputError("no samples");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))];
}

const higherIsBetter = (unit) => unit === "fps";

/** p50 plus the tail that matters: p95 for a time or a memory size, p5 for a frame rate. */
export function summarize({ unit, samples }) {
  return higherIsBetter(unit)
    ? { unit, p50: percentile(samples, 0.5), p5: percentile(samples, 0.05) }
    : { unit, p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
}

export function spread(values) {
  const range = Math.max(...values) - Math.min(...values);
  return { ratio: range / percentile(values, 0.5), range };
}

const round1 = (value) => Math.round(value * 10) / 10;

/** A measured key's sample values and the end states they stopped on. */
function measuredKey(file, key) {
  const entry = file.keys?.[key];
  if (!entry) throw new InputError(`${key}: not in the current file`);
  if (!Array.isArray(entry.samples)) throw new InputError(`${key}: samples is not a list`);
  if (!["ms", "fps", "MiB"].includes(entry.unit)) {
    throw new InputError(`${key}: unknown unit ${entry.unit}`);
  }
  const field = entry.unit === "MiB" ? "mib" : higherIsBetter(entry.unit) ? "fps" : "ms";
  const values = entry.samples.map((sample) => sample?.[field]);
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new InputError(`${key}: a sample has no ${field} value`);
  }
  if (values.length < MIN_SAMPLES) {
    throw new InputError(`${key}: fewer than ${MIN_SAMPLES} samples (${values.length})`);
  }
  const endState = [...new Set(entry.samples.map((sample) => sample.endState))].join(",");
  return { unit: entry.unit, values, endState };
}

function checkMeasured(file) {
  if (!file || typeof file !== "object" || !file.keys || typeof file.keys !== "object") {
    throw new InputError("the current file has no keys");
  }
  for (const field of ["engine", "runs", "commit", "date"]) {
    if (file[field] === undefined) throw new InputError(`the current file has no ${field}`);
  }
}

function checkBaseline(file) {
  const block = file?.compare;
  if (
    !Array.isArray(file?.sets) ||
    !Array.isArray(block?.keys) ||
    typeof block.tolerancePercent !== "number" ||
    typeof block.floor?.ms !== "number"
  ) {
    throw new InputError(
      "the baseline file needs sets[] and compare {keys, tolerancePercent, floor}",
    );
  }
  if (file.sets.some((set) => !set || typeof set !== "object" || typeof set.runner !== "string")) {
    throw new InputError("every baseline set needs a runner");
  }
  if (file.budget !== undefined) {
    const { runner, p95Ms, keys } = file.budget ?? {};
    if (
      typeof runner !== "string" ||
      !Number.isFinite(p95Ms) ||
      p95Ms <= 0 ||
      !Array.isArray(keys) ||
      !keys.length ||
      keys.some((key) => typeof key !== "string")
    ) {
      throw new InputError("the baseline's budget needs {runner, p95Ms above 0, keys: [name, …]}");
    }
  }
}

/** Whether `runner`'s set may hold `key`: every key for m1, all but the M1-only keys elsewhere. */
const keepsKey = (runner, key) => runner === M1_RUNNER || !M1_ONLY_KEYS.includes(key);

/**
 * What a record of `measured` does to `runner`'s set: the measured keys it takes, the M1-only ones
 * it drops, and the keys of its previous set it carries over unmeasured.
 */
export function recordedKeys(baseline, measured, runner) {
  const previous = baseline.sets.find((set) => set.runner === runner);
  const all = Object.keys(measured.keys);
  const kept = all.filter((key) => keepsKey(runner, key));
  return {
    previous,
    kept,
    dropped: all.filter((key) => !keepsKey(runner, key)),
    carried: Object.keys(previous?.keys ?? {}).filter(
      (key) => keepsKey(runner, key) && !kept.includes(key),
    ),
  };
}

/** The baseline with `runner`'s set replaced by (or added from) the measured file. */
export function upsertSet(baseline, measured, runner) {
  checkBaseline(baseline);
  checkMeasured(measured);
  const { previous, kept, carried } = recordedKeys(baseline, measured, runner);
  const keys = Object.fromEntries(carried.map((key) => [key, previous.keys[key]]));
  for (const key of kept) {
    const { unit, values, endState } = measuredKey(measured, key);
    keys[key] = { ...summarize({ unit, samples: values }), samples: values, endState };
  }
  const set = {
    runner,
    engine: measured.engine,
    runs: measured.runs,
    commit: measured.commit,
    date: measured.date,
    throttle: measured.throttle ?? "none",
    keys,
  };
  const sets = previous
    ? baseline.sets.map((each) => (each === previous ? set : each))
    : [...baseline.sets, set];
  return { ...baseline, sets };
}

/** A budget key's current p95 when it is over the budget, else null. */
function overBudget(budget, measured, key) {
  const { unit, values } = measuredKey(measured, key);
  if (unit !== "ms") throw new InputError(`budget ${key}: unit ${unit}, the budget is in ms`);
  const p95 = percentile(values, 0.95);
  return p95 > budget.p95Ms ? { key, p95 } : null;
}

/**
 * The budget keys whose current p95 is over `budget.p95Ms`: none with no budget block or for a
 * runner other than `budget.runner`. Reads the current samples only, so a key needs no set entry.
 * With `partial`, a key the measured file leaves out comes back as `{key, missing: true}`.
 */
export function budgetFailures(baseline, measured, runner, { partial = false } = {}) {
  const { budget } = baseline;
  if (!budget || budget.runner !== runner) return [];
  return budget.keys
    .map((key) =>
      partial && !measured.keys[key] ? { key, missing: true } : overBudget(budget, measured, key),
    )
    .filter(Boolean);
}

const p95Text = ({ key, p95 }) => `${key} p95 ${round1(p95)}ms`;

const budgetLine = (over, budget) => `FAIL ${p95Text(over)} > budget ${budget.p95Ms}`;

const signed = (ratio) => `${ratio >= 0 ? "+" : ""}${Math.round(ratio * 100)}%`;

/**
 * Compares the measured file against `runner`'s set. Returns `{exitCode, lines, verdict, rows}`;
 * throws an `InputError` (exit 2) on bad input.
 */
export function compare(baseline, measured, { runner }) {
  checkBaseline(baseline);
  checkMeasured(measured);
  const set = baseline.sets.find((each) => each.runner === runner);
  if (!set) return { exitCode: 0, lines: [`perf lane skipped: no ${runner} rows`], rows: [] };
  if (set.engine !== measured.engine) {
    throw new InputError(
      `engine mismatch: ${runner} set is ${set.engine}, current is ${measured.engine}`,
    );
  }
  const tol = baseline.compare.tolerancePercent / 100;
  const rows = baseline.compare.keys.map((key) => {
    const base = set.keys?.[key];
    if (!base) throw new InputError(`${key}: not in the ${runner} set`);
    if (!Number.isFinite(base.p50) || base.p50 <= 0) {
      throw new InputError(`${key}: the ${runner} set's p50 is not a positive number`);
    }
    const { unit, values, endState } = measuredKey(measured, key);
    if (unit !== base.unit) throw new InputError(`${key}: unit ${unit}, the set has ${base.unit}`);
    const median = percentile(values, 0.5);
    const up = !higherIsBetter(unit);
    const floor = up ? baseline.compare.floor.ms : (baseline.compare.floor.fps ?? 0);
    const limit = up
      ? Math.max(base.p50 * (1 + tol), base.p50 + floor)
      : Math.min(base.p50 * (1 - tol), base.p50 - floor);
    const fail = up ? median > limit : median < limit;
    const change = (median - base.p50) / base.p50;
    // A click that now lands somewhere else (an overlay instead of a team switch) says so, so the
    // change doesn't read as a plain speed-up.
    const ends =
      base.endState && base.endState !== endState ? `${base.endState} -> ${endState}` : endState;
    return { key, unit, median, p50: base.p50, limit, change, endState: ends, fail };
  });
  const failed = rows.filter((row) => row.fail);
  const lines = rows.map(
    (row) =>
      `${row.fail ? "FAIL" : "PASS"} ${row.key} ${round1(row.median)}${row.unit} (p50 ${round1(
        row.p50,
      )}, limit ${round1(row.limit)}, ${signed(row.change)}, ${row.endState})`,
  );
  const over = budgetFailures(baseline, measured, runner);
  const overText = over.map(p95Text).join(", ");
  let verdict = failed.length
    ? `perf compare ${runner}: FAIL ${failed.length}/${rows.length}: ${failed
        .map((row) => `${row.key} ${signed(row.change)}`)
        .join(", ")}`
    : `perf compare ${runner}: PASS ${rows.length}/${rows.length} (tol ${baseline.compare.tolerancePercent}%, ${measured.runs} runs)`;
  if (over.length) {
    verdict = failed.length
      ? `${verdict}; over budget: ${overText}`
      : `perf compare ${runner}: FAIL budget: ${overText}`;
  }
  const budgetLines = over.map((each) => budgetLine(each, baseline.budget));
  return {
    exitCode: failed.length || over.length ? 1 : 0,
    lines: [...lines, ...budgetLines, verdict],
    verdict,
    rows,
  };
}

function summaryTable(result) {
  const head =
    "| Key | Verdict | Median | p50 | Limit | Change | End state |\n|---|---|---|---|---|---|---|";
  const body = result.rows.map(
    (row) =>
      `| ${row.key} | ${row.fail ? "FAIL" : "PASS"} | ${round1(row.median)} ${row.unit} | ${round1(
        row.p50,
      )} ${row.unit} | ${round1(row.limit)} ${row.unit} | ${signed(row.change)} | ${row.endState} |`,
  );
  return `${result.verdict}\n\n${head}\n${body.join("\n")}\n`;
}

/** The baseline file's one format, so a record rewrites only the set it changes. */
export function formatBaseline(baseline) {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

function readJson(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new InputError(`cannot read the ${what} file ${file}: ${err.code ?? err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new InputError(`the ${what} file ${file} is not JSON: ${err.message}`);
  }
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode !== "compare" && mode !== "record") {
    throw new InputError(
      "usage: perf-baseline.mjs compare|record --current <file> --runner <name> [--baseline <file>]",
    );
  }
  const opts = { mode, baseline: DEFAULT_BASELINE };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    const name = { "--current": "current", "--runner": "runner", "--baseline": "baseline" }[flag];
    if (!name) throw new InputError(`unknown option ${flag}`);
    if (value === undefined || value.startsWith("--"))
      throw new InputError(`${flag} needs a value`);
    opts[name] = value;
  }
  if (!opts.current) throw new InputError("--current is required");
  if (!opts.runner) throw new InputError("--runner is required");
  return opts;
}

/** The CLI. Returns the exit code; `io` carries `log`, `error` and `env` for tests. */
export function run(argv, io = { log: console.log, error: console.error, env: process.env }) {
  try {
    const opts = parseArgs(argv);
    const measured = readJson(opts.current, "current");
    const baseline = readJson(opts.baseline, "baseline");
    if (opts.mode === "compare") {
      const result = compare(baseline, measured, opts);
      for (const line of result.lines) io.log(line);
      if (io.env.GITHUB_STEP_SUMMARY && result.rows.length) {
        fs.appendFileSync(io.env.GITHUB_STEP_SUMMARY, summaryTable(result));
      }
      return result.exitCode;
    }
    const next = upsertSet(baseline, measured, opts.runner);
    // record prints the budget but never gates on it; a partial run may leave a budget key out.
    const budgetLines = budgetFailures(baseline, measured, opts.runner, { partial: true }).map(
      (each) =>
        each.missing ? `budget ${each.key}: not measured` : budgetLine(each, baseline.budget),
    );
    fs.writeFileSync(opts.baseline, formatBaseline(next));
    const floorMs = baseline.compare.floor.ms;
    const { previous, kept, dropped, carried } = recordedKeys(baseline, measured, opts.runner);
    io.log(
      `recorded ${opts.runner}: ${kept.length} keys, ${measured.runs} runs, commit ${measured.commit}`,
    );
    for (const key of dropped) io.log(`dropped ${key}: only the ${M1_RUNNER} set records it`);
    if (opts.runner !== M1_RUNNER) {
      for (const key of carried) {
        io.log(`carried ${key}: not measured, kept from the commit ${previous.commit} set`);
      }
    }
    const set = next.sets.find((each) => each.runner === opts.runner);
    for (const key of kept) {
      const { unit, samples } = set.keys[key];
      const { ratio, range } = spread(samples);
      const ok = ratio <= SPREAD_LIMIT || (unit === "ms" && range <= floorMs);
      io.log(
        `spread ${key} ${Math.round(ratio * 100)}% (${round1(range)} ${unit}): ${ok ? "can be compared" : "too noisy to compare"}`,
      );
    }
    for (const line of budgetLines) io.log(line);
    return 0;
  } catch (err) {
    // Anything unexpected is an input or setup problem too, never a regression (exit 1).
    io.error(
      `perf-baseline: ${err instanceof InputError ? err.message : `unexpected: ${err.stack ?? err}`}`,
    );
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
