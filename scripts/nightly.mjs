// SPDX-License-Identifier: MIT
// Helpers for nightly.yml.
//   node scripts/nightly.mjs perf-plan [--baseline <json>] [--harness <spec>] [--tool <script>]
//       [--record true]
//     Picks the perf lane's mode: record, compare or skip. Writes mode=<mode> to $GITHUB_OUTPUT and,
//     on a skip, "perf lane skipped: <reason>" to the job summary.
//   node scripts/nightly.mjs empty-lane <playwright-report.json>
//     Writes "tiles-nightly: no @nightly tile specs yet" to the job summary when the @nightly tile
//     run had no test; a missing or unreadable report fails.
//   NEEDS='<needs as JSON>' node scripts/nightly.mjs issue --run-url <url> [--date YYYY-MM-DD]
//     Opens or updates the one nightly issue with gh (GH_TOKEN and GH_REPO set) when a lane failed.
// The perf lane's contract: the harness measures with MEASURE_PERF_BASELINE=1 into
// PERF_BASELINE_OUT, then the tool compares that (or records it) against the set whose runner is
// macos-15, never the M1 set measured by hand. Its exit codes: 0 pass, 1 regression, 2 bad input.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { reportRuns } from "./lib/playwright-report.mjs";

export const RUNNER = "macos-15";
export const BASELINE = "tests/fixtures/perf-baseline.json";
export const HARNESS = "tests/e2e-mock/perf-baseline.spec.ts";
export const TOOL = "scripts/perf-baseline.mjs";
export const LABEL = "nightly";
// One issue for every failed night, found by this exact body marker among labelled issues.
export const MARKER = "<!-- nightly-run -->";

// `harness` and `tool` say whether those files exist; `baseline` is the parsed file or null.
export function perfPlan({ baseline, harness, tool, record = false }) {
  const skip = (reason) => ({ mode: "skip", reason });
  if (!harness) return skip(`no ${HARNESS} yet`);
  if (!tool) return skip(`no ${TOOL} yet`);
  if (record) return { mode: "record" };
  if (baseline === null) return skip(`no ${BASELINE} yet`);
  const sets = Object.values(baseline?.sets ?? {});
  if (!sets.some((set) => set?.runner === RUNNER))
    return skip(`no runner: ${RUNNER} set in ${BASELINE}`);
  return { mode: "compare" };
}

// True when a Playwright JSON report holds no run at all (--pass-with-no-tests passed it).
export const emptyLane = (report) => reportRuns(report).length === 0;

export const failedLanes = (needs) =>
  Object.entries(needs ?? {})
    .filter(([, job]) => job?.result === "failure")
    .map(([name]) => name);

// The open issue gets a comment; with none open, the newest closed one is reopened, so a red
// night never opens a duplicate.
export function trackNightly(lanes, { gh, runUrl, date }) {
  const issues = JSON.parse(
    gh([
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
    ]),
  );
  const line = `${date}: ${lanes.join(", ")} failed: ${runUrl}`;
  const matches = issues
    .filter((issue) => issue.body?.includes(MARKER))
    .sort((a, b) => b.number - a.number);
  const existing = matches.find((issue) => issue.state === "OPEN") ?? matches[0];
  if (existing) {
    const number = String(existing.number);
    const action = existing.state === "OPEN" ? "commented" : "reopened";
    if (action === "reopened") gh(["issue", "reopen", number]);
    gh(["issue", "comment", number, "--body", `Red again ${line}`]);
    return { action, number: existing.number };
  }
  gh([
    "label",
    "create",
    LABEL,
    "--force",
    "--color",
    "b60205",
    "--description",
    "A failed nightly run",
  ]);
  const body = [
    MARKER,
    "The nightly workflow (nightly.yml) failed on main. Each red night adds a comment here; keep " +
      "the label and the marker line so it is found. Close it once the lanes are green.",
    "",
    `First red night ${line}`,
    "",
  ].join("\n");
  const url = gh([
    "issue",
    "create",
    "--title",
    "Nightly run failed",
    "--label",
    LABEL,
    "--body",
    body,
  ]).trim();
  return { action: "created", url };
}

function main(argv) {
  const [command, ...rest] = argv;
  const option = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (command === "perf-plan") {
    const baseline = option("--baseline") ?? BASELINE;
    const plan = perfPlan({
      baseline: fs.existsSync(baseline) ? JSON.parse(fs.readFileSync(baseline, "utf8")) : null,
      harness: fs.existsSync(option("--harness") ?? HARNESS),
      tool: fs.existsSync(option("--tool") ?? TOOL),
      record: option("--record") === "true",
    });
    const output = `mode=${plan.mode}\n`;
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, output);
    else process.stdout.write(output);
    if (plan.reason) {
      const line = `perf lane skipped: ${plan.reason}\n`;
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, line);
      process.stdout.write(line);
    }
    return;
  }
  if (command === "empty-lane" && rest.length === 1) {
    if (!emptyLane(JSON.parse(fs.readFileSync(rest[0], "utf8")))) return;
    const line = "tiles-nightly: no @nightly tile specs yet\n";
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, line);
    process.stdout.write(line);
    return;
  }
  if (command === "issue" && option("--run-url")) {
    const lanes = failedLanes(JSON.parse(process.env.NEEDS ?? "{}"));
    if (!lanes.length) return console.log("nightly: no lane failed");
    // gh prints its own error to stderr; the thrown message names the command, not its arguments.
    const gh = (args) => {
      try {
        return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
      } catch (error) {
        throw new Error(`gh ${args.slice(0, 2).join(" ")} failed (exit ${error.status ?? "?"})`);
      }
    };
    const date = option("--date") ?? new Date().toISOString().slice(0, 10);
    const result = trackNightly(lanes, { gh, runUrl: option("--run-url"), date });
    console.log(`nightly: ${result.action} ${result.url ?? result.number}`);
    return;
  }
  throw new Error(
    "usage: node scripts/nightly.mjs perf-plan [--baseline <json>] [--harness <spec>] [--tool <script>] [--record true] | empty-lane <report.json> | issue --run-url <url> [--date YYYY-MM-DD]",
  );
}

// A realpath guard keeps imports inert, including when /tmp is a symlink on macOS.
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
