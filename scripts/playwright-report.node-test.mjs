// SPDX-License-Identifier: MIT
// node --test scripts/playwright-report.node-test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { reportRuns, reportSpecs } from "./lib/playwright-report.mjs";

// Playwright's JSON reporter (and --list): files, then describe blocks, each spec once per project.
const report = {
  suites: [
    {
      title: "tiles/a.spec.ts",
      file: "tiles/a.spec.ts",
      specs: [
        {
          title: "top @p0",
          tags: ["p0"],
          tests: [
            { projectName: "tiles-chromium", status: "expected" },
            { projectName: "tiles-webkit", status: "skipped" },
          ],
        },
      ],
      suites: [
        {
          title: "group",
          specs: [{ title: "inner", tests: [{ projectName: "tiles-webkit", status: "flaky" }] }],
        },
      ],
    },
    { title: "tiles/empty.spec.ts", specs: [{ title: "listed only", tests: [] }] },
  ],
};

test("reportSpecs keys each spec by its file, describe blocks and title", () => {
  assert.deepEqual(
    reportSpecs(report).map(({ title, spec }) => [title, spec.tags ?? []]),
    [
      ["tiles/a.spec.ts › top @p0", ["p0"]],
      ["tiles/a.spec.ts › group › inner", []],
      ["tiles/empty.spec.ts › listed only", []],
    ],
  );
});

test("reportRuns yields one entry per spec and project", () => {
  assert.deepEqual(
    reportRuns(report).map(({ title, run }) => [title, run.projectName, run.status]),
    [
      ["tiles/a.spec.ts › top @p0", "tiles-chromium", "expected"],
      ["tiles/a.spec.ts › top @p0", "tiles-webkit", "skipped"],
      ["tiles/a.spec.ts › group › inner", "tiles-webkit", "flaky"],
    ],
  );
});

test("a report with no suites has no specs and no runs", () => {
  assert.deepEqual(reportSpecs({}), []);
  assert.deepEqual(reportRuns({ suites: [] }), []);
});
