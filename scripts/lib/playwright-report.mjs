// SPDX-License-Identifier: MIT
// Walks Playwright's JSON report, from a run or from --list: files, then describe blocks, with
// each spec reported once per project in `spec.tests`.

// Every spec with its full title (file, describe blocks, title), in report order.
export function reportSpecs(report) {
  const specs = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? [])
      specs.push({ title: [...titles, spec.title].join(" › "), spec });
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const file of report.suites ?? []) walk(file, [file.file ?? file.title]);
  return specs;
}

// Every run of a spec in one project, with the spec's full title.
export const reportRuns = (report) =>
  reportSpecs(report).flatMap(({ title, spec }) =>
    (spec.tests ?? []).map((run) => ({ title, run })),
  );
