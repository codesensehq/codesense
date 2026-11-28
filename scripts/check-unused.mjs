// SPDX-License-Identifier: MIT
// Usage: node scripts/check-unused.mjs [--write] [--baseline <file>] [--report <file>]
// Runs knip for unused files, exports and types and compares the findings with knip-baseline.json.
// The baseline can only shrink: a finding that is not in it fails, and so does a baseline entry
// knip no longer reports, so deleting dead code means removing its entry in the same change.
// An entry is "<kind> <file> <symbol>" (a file has no symbol), with no line or column, so moving
// code inside a file never changes the baseline. The file is a sorted JSON array, one entry per
// line.
// --write creates the baseline when it is absent. When it exists, --write removes the stale
// entries and refuses to add one: growing the baseline is a hand edit that the pull request shows.
// --report <file> reads a saved `knip --reporter json` report instead of running knip.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const KNIP_BIN = join(ROOT, "node_modules", "knip", "bin", "knip.js");
const DEFAULT_BASELINE = join(ROOT, "knip-baseline.json");
const KINDS = ["files", "exports", "types"];

// knip reports a path relative to the directory it ran in.
const posix = (file) => file.replaceAll("\\", "/");

export function entriesFromReport(report) {
  const entries = new Set();
  for (const issue of report.issues ?? []) {
    const file = posix(issue.file);
    for (const kind of KINDS) {
      for (const item of issue[kind] ?? []) {
        entries.add(kind === "files" ? `files ${file}` : `${kind} ${file} ${item.name}`);
      }
    }
  }
  return [...entries].sort();
}

export function compareEntries(baseline, current) {
  const known = new Set(baseline);
  const reported = new Set(current);
  return {
    added: current.filter((entry) => !known.has(entry)),
    stale: baseline.filter((entry) => !reported.has(entry)),
  };
}

export function formatBaseline(entries) {
  return entries.length === 0
    ? "[]\n"
    : `[\n${entries.map((entry) => `  ${JSON.stringify(entry)}`).join(",\n")}\n]\n`;
}

// knip exits 1 when it has findings, so the report on stdout decides, not the exit status.
export function runKnip({ cwd = ROOT, config } = {}) {
  const args = [KNIP_BIN, "--include", "files,exports,types", "--reporter", "json"];
  if (config) args.push("--config", config);
  const run = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  try {
    return JSON.parse(run.stdout);
  } catch {
    throw new Error(`knip did not print a JSON report (exit ${run.status}):\n${run.stderr}`);
  }
}

function parseArgs(argv) {
  const options = { write: false, baseline: DEFAULT_BASELINE, report: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--write") options.write = true;
    else if (arg === "--baseline") options.baseline = resolve(argv[++i]);
    else if (arg === "--report") options.report = resolve(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function list(heading, entries) {
  return [heading, ...entries.map((entry) => `  ${entry}`)].join("\n");
}

function main(argv) {
  const options = parseArgs(argv);
  const report = options.report ? JSON.parse(readFileSync(options.report, "utf8")) : runKnip();
  const current = entriesFromReport(report);
  const baselineExists = existsSync(options.baseline);

  if (!baselineExists) {
    if (!options.write) {
      console.error(`${options.baseline} is missing. Run: node scripts/check-unused.mjs --write`);
      return 1;
    }
    writeFileSync(options.baseline, formatBaseline(current));
    console.log(`Wrote ${current.length} entries to ${options.baseline}`);
    return 0;
  }

  const baseline = JSON.parse(readFileSync(options.baseline, "utf8"));
  const { added, stale } = compareEntries(baseline, current);

  if (options.write) {
    if (added.length > 0) {
      console.error(
        `${list("Refusing to add to the baseline; delete or use the code instead:", added)}\n` +
          "Growing the baseline is a hand edit that the pull request shows.",
      );
      return 1;
    }
    writeFileSync(options.baseline, formatBaseline(current));
    console.log(`Removed ${stale.length} stale entries from ${options.baseline}`);
    return 0;
  }

  if (added.length === 0 && stale.length === 0) {
    console.log(`Unused code matches the baseline (${current.length} entries).`);
    return 0;
  }
  if (added.length > 0) {
    console.error(list("New unused code (delete it or use it):", added));
  }
  if (stale.length > 0) {
    console.error(
      list(
        "Stale baseline entries, knip no longer reports them (run: node scripts/check-unused.mjs --write):",
        stale,
      ),
    );
  }
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
