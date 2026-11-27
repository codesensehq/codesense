// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { compareEntries, entriesFromReport, formatBaseline, runKnip } from "./check-unused.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const CHECKER = join(HERE, "check-unused.mjs");

// A knip JSON report, as `knip --reporter json` prints it.
function report({ files = [], exports = [], types = [] } = {}) {
  const byFile = new Map();
  const slot = (file) => {
    if (!byFile.has(file))
      byFile.set(file, { file, owners: [], files: [], exports: [], types: [] });
    return byFile.get(file);
  };
  for (const file of files) slot(file).files.push({ name: file });
  for (const [file, name, line = 1, col = 1] of exports)
    slot(file).exports.push({ name, line, col, pos: 0 });
  for (const [file, name, line = 1, col = 1] of types)
    slot(file).types.push({ name, line, col, pos: 0 });
  return { issues: [...byFile.values()] };
}

function sandbox(baseline, knipReport) {
  const dir = mkdtempSync(join(tmpdir(), "check-unused-"));
  const baselineFile = join(dir, "knip-baseline.json");
  const reportFile = join(dir, "report.json");
  if (baseline !== undefined) writeFileSync(baselineFile, baseline);
  writeFileSync(reportFile, JSON.stringify(knipReport));
  return { baselineFile, reportFile };
}

function check(baseline, knipReport, ...flags) {
  const { baselineFile, reportFile } = sandbox(baseline, knipReport);
  const run = spawnSync(
    process.execPath,
    [CHECKER, "--baseline", baselineFile, "--report", reportFile, ...flags],
    { encoding: "utf8" },
  );
  return { ...run, baselineFile };
}

const BASELINE = formatBaseline(
  entriesFromReport(
    report({
      files: ["src/dead.ts"],
      exports: [["src/a.ts", "unusedFn", 10, 3]],
      types: [["src/a.ts", "UnusedType", 20, 1]],
    }),
  ),
);

test("an entry is keyed on kind, file and symbol, sorted, with no line or column", () => {
  const entries = entriesFromReport(
    report({
      files: ["src/z.ts"],
      exports: [
        ["src/b.ts", "beta", 4, 9],
        ["src/a.ts", "alpha", 7, 2],
      ],
      types: [["src/a.ts", "Alpha", 8, 1]],
    }),
  );
  assert.deepEqual(entries, [
    "exports src/a.ts alpha",
    "exports src/b.ts beta",
    "files src/z.ts",
    "types src/a.ts Alpha",
  ]);
});

test("the baseline file is one entry per line, ends with a newline and round-trips", () => {
  const text = formatBaseline(["exports src/a.ts alpha", "files src/z.ts"]);
  assert.equal(text, '[\n  "exports src/a.ts alpha",\n  "files src/z.ts"\n]\n');
  assert.deepEqual(JSON.parse(text), ["exports src/a.ts alpha", "files src/z.ts"]);
});

test("compareEntries names what is new and what is stale", () => {
  assert.deepEqual(compareEntries(["a", "b"], ["b", "c"]), { added: ["c"], stale: ["a"] });
  assert.deepEqual(compareEntries(["a"], ["a"]), { added: [], stale: [] });
});

test("a finding that is not in the baseline fails and is named", () => {
  const run = check(
    BASELINE,
    report({
      files: ["src/dead.ts"],
      exports: [
        ["src/a.ts", "unusedFn"],
        ["src/new.ts", "freshlyUnused"],
      ],
      types: [["src/a.ts", "UnusedType"]],
    }),
  );
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /exports src\/new\.ts freshlyUnused/);
});

test("a baseline entry knip no longer reports fails and is named as stale", () => {
  const run = check(
    BASELINE,
    report({ files: ["src/dead.ts"], exports: [["src/a.ts", "unusedFn"]] }),
  );
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /stale/i);
  assert.match(run.stdout + run.stderr, /types src\/a\.ts UnusedType/);
});

test("a report equal to the baseline passes, including a finding whose line moved", () => {
  const run = check(
    BASELINE,
    report({
      files: ["src/dead.ts"],
      exports: [["src/a.ts", "unusedFn", 55, 9]],
      types: [["src/a.ts", "UnusedType", 99, 4]],
    }),
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test("--write refuses a new finding and writes nothing", () => {
  const run = check(
    BASELINE,
    report({
      files: ["src/dead.ts"],
      exports: [
        ["src/a.ts", "unusedFn"],
        ["src/new.ts", "freshlyUnused"],
      ],
      types: [["src/a.ts", "UnusedType"]],
    }),
    "--write",
  );
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /exports src\/new\.ts freshlyUnused/);
  assert.equal(readFileSync(run.baselineFile, "utf8"), BASELINE);
});

test("--write with a baseline present removes stale entries only", () => {
  const run = check(
    BASELINE,
    report({ files: ["src/dead.ts"], exports: [["src/a.ts", "unusedFn"]] }),
    "--write",
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(
    readFileSync(run.baselineFile, "utf8"),
    formatBaseline(["exports src/a.ts unusedFn", "files src/dead.ts"]),
  );
});

test("--write bootstraps the baseline only when it is absent", () => {
  const run = check(
    undefined,
    report({ files: ["src/dead.ts"], exports: [["src/a.ts", "unusedFn"]] }),
    "--write",
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(
    readFileSync(run.baselineFile, "utf8"),
    formatBaseline(["exports src/a.ts unusedFn", "files src/dead.ts"]),
  );
});

test("a missing baseline without --write fails", () => {
  const run = check(undefined, report());
  assert.notEqual(run.status, 0);
});

// AC 3: one fixture file per entry glob, each importing a distinct export from the fixture src.
const FIXTURE = join(HERE, "fixtures", "knip-entries");
const KNIP_CONFIG = join(ROOT, "knip.json");
const ENTRY_FIXTURES = [
  ["src/main.tsx", "from_main"],
  ["src-emulator/**", "from_emulator"],
  ["scripts/**/*.mjs", "from_script"],
  ["playwright*.config.ts", "from_playwright"],
  ["vitest.config.ts", "from_vitest"],
  ["vite.config.ts", "from_vite"],
  ["tests/e2e-mock/**", "from_e2e"],
];

function fixtureSymbols(configFile) {
  return runKnip({ cwd: FIXTURE, config: configFile }).issues.flatMap((issue) =>
    [...issue.exports, ...issue.types].map((item) => item.name),
  );
}

test("the fixture tree holds one file per entry glob in knip.json", () => {
  const { entry } = JSON.parse(readFileSync(KNIP_CONFIG, "utf8"));
  assert.deepEqual(
    entry,
    ENTRY_FIXTURES.map(([glob]) => glob),
  );
});

test("nothing reachable only from an entry glob is reported, and the fixture can report", () => {
  const reported = fixtureSymbols(KNIP_CONFIG);
  for (const [glob, symbol] of ENTRY_FIXTURES) {
    assert.ok(!reported.includes(symbol), `${symbol} (from ${glob}) is reported as unused`);
  }
  assert.ok(reported.includes("orphanCanary"), "the orphan export should be reported");
});

test("without the entry globs the fixture exports are reported", () => {
  const { entry, ...rest } = JSON.parse(readFileSync(KNIP_CONFIG, "utf8"));
  const dir = mkdtempSync(join(tmpdir(), "knip-config-"));
  const config = join(dir, "knip.json");
  // Keep one entry so knip has something to start from; every other glob is removed.
  writeFileSync(config, JSON.stringify({ ...rest, entry: [entry[0]] }));
  const reported = fixtureSymbols(config);
  for (const [glob, symbol] of ENTRY_FIXTURES.slice(1)) {
    assert.ok(reported.includes(symbol), `${symbol} should be reported once ${glob} is removed`);
  }
});
