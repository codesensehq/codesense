// SPDX-License-Identifier: MIT
// The @p1 release gate (tiles-release.yml): at least 95% of the tile specs that ran must pass, on
// both engines together. No test at all fails, so an empty or broken run never reads as green.
//   node scripts/tiles-release-gate.mjs <playwright-report.json>
// Writes the result and every failure to the job summary ($GITHUB_STEP_SUMMARY, else stdout).
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const BAR = 0.95;
const firstLine = (text) =>
  String(text ?? "")
    .split("\n")[0]
    .trim();

function outcomes(report) {
  const runs = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? [])
      for (const run of spec.tests ?? [])
        runs.push({
          title: [...titles, spec.title].join(" › "),
          project: run.projectName,
          status: run.status,
          error: firstLine(run.results?.findLast((result) => result.error)?.error?.message),
        });
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const file of report.suites ?? []) walk(file, [file.file ?? file.title]);
  return runs;
}

export function releaseGate(report, bar = BAR) {
  const runs = outcomes(report);
  const skipped = runs.filter((run) => run.status === "skipped").length;
  const counted = runs.filter((run) => run.status !== "skipped");
  const passed = counted.filter((run) => ["expected", "flaky"].includes(run.status)).length;
  const failures = counted.filter((run) => !["expected", "flaky"].includes(run.status));
  const errors = (report.errors ?? []).map((error) => firstLine(error.message ?? error));
  const total = counted.length;
  const ok = total > 0 && passed / total >= bar && !errors.length;
  const lines = ["## Tile release gate (@p1)", ""];
  if (!total) lines.push("No @p1 test ran, so the gate fails closed.");
  else
    lines.push(
      `${passed} of ${total} passed (${((100 * passed) / total).toFixed(1)}%)${
        ok ? "." : `; the release needs ${Math.round(bar * 100)}%.`
      }${skipped ? ` ${skipped} skipped.` : ""}`,
    );
  for (const error of errors) lines.push("", `Run error: ${error}`);
  if (failures.length) {
    lines.push("", "| Spec | Engine | First error line |", "|---|---|---|");
    for (const failure of failures)
      lines.push(
        `| ${failure.title} | ${failure.project} | ${failure.error.replaceAll("|", "\\|") || failure.status} |`,
      );
  }
  return { ok, passed, total, skipped, failures, markdown: `${lines.join("\n")}\n` };
}

// A realpath guard keeps imports inert, including when /tmp is a symlink on macOS.
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    if (process.argv.length !== 3)
      throw new Error("usage: node scripts/tiles-release-gate.mjs <playwright-report.json>");
    const gate = releaseGate(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
    for (const failure of gate.failures)
      console.log(`::error title=Release gate::${failure.title} (${failure.project})`);
    if (process.env.GITHUB_STEP_SUMMARY)
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, gate.markdown);
    process.stdout.write(gate.markdown);
    process.exitCode = gate.ok ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
