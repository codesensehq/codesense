// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  LEDGERS,
  loadEntries,
  validate,
  validEntries,
  quarantineApplies,
  quarantineReason,
} from "./lib/quarantine.mjs";
import {
  LINUX_WEBKIT_MEDIA_SKIP,
  unexecutedTests,
} from "../tests/frame-security/support/fixture-guard.mjs";
import { validateInventory } from "./lib/quarantine-inventory.mjs";

test("quarantines have issue URLs and expire after 30 days", () => {
  const entries = loadEntries();
  validate(entries);
  validateInventory(entries);
  for (const entry of entries) console.log(`${entry.id}: ${quarantineReason(entry)}`);
});

test("the second ledger is merged when present and validated with the first", (t) => {
  const root = mkdtempSync(join(tmpdir(), "quarantine-ledgers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "tests"));
  const now = Date.parse("2026-11-07T00:00:00Z");
  const entry = (id, added = "2026-11-07") => ({
    id: `vitest:${id}.test.ts#example`,
    reason: "Awaiting fix",
    issue: "https://github.com/example/project/issues/1",
    added,
  });
  const write = (index, value) => writeFileSync(join(root, LEDGERS[index]), JSON.stringify(value));
  write(0, [entry("a")]);
  assert.deepEqual(loadEntries(root), [entry("a")]);
  write(1, [entry("b")]);
  assert.deepEqual(loadEntries(root), [entry("a"), entry("b")]);
  validate(loadEntries(root), now, "example/project");
  for (const second of [[entry("a")], [entry("b", "2026-10-07")], [{ ...entry("b"), issue: "" }]]) {
    write(1, second);
    assert.throws(() => validate(loadEntries(root), now, "example/project"));
  }
  write(1, { id: "not an array" });
  assert.throws(() => loadEntries(root), new RegExp(`${LEDGERS[1]}: quarantine must be an array`));
  write(1, []);
  write(0, { id: "not an array" });
  assert.throws(() => loadEntries(root), new RegExp(`${LEDGERS[0]}: quarantine must be an array`));
});

test("the quarantine gate rejects missing issues, placeholders and expired entries", () => {
  const now = Date.parse("2026-11-07T00:00:00Z");
  const entry = {
    id: "vitest:example.test.ts#example",
    reason: "Awaiting fix",
    issue: "https://github.com/example/project/issues/1",
    added: "2026-10-08",
  };
  validate([entry], now, "example/project");
  for (const change of [
    { issue: undefined },
    { issue: "TODO-public-issue" },
    { issue: "https://github.com/another/project/issues/1" },
    { issue: "https://github.com/example/project" },
    { issue: "https://github.com/example/project/pull/1" },
    { issue: "https://example.com/example/project/issues/1" },
    { issue: "https://github.com/example/project/issues/1?query=1" },
    { id: "playwright:tests/frame-security/hostile.spec.ts#security" },
    { added: "2026-10-07" },
    { added: "2026-11-08" },
    { added: "2026-02-30" },
  ]) {
    assert.throws(() => validate([{ ...entry, ...change }], now, "example/project"));
  }
});

test("gate and runners agree under the default and overridden issue repository", (t) => {
  const prior = process.env.QUARANTINE_ISSUE_REPOSITORY;
  const priorGithub = process.env.GITHUB_REPOSITORY;
  t.after(() => {
    if (prior === undefined) delete process.env.QUARANTINE_ISSUE_REPOSITORY;
    else process.env.QUARANTINE_ISSUE_REPOSITORY = prior;
    if (priorGithub === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = priorGithub;
  });
  process.env.GITHUB_REPOSITORY = "unrelated/source-repository";
  const now = Date.parse("2026-11-07T00:00:00Z");
  for (const setting of [undefined, "example/project"]) {
    if (setting === undefined) delete process.env.QUARANTINE_ISSUE_REPOSITORY;
    else process.env.QUARANTINE_ISSUE_REPOSITORY = setting;
    for (const repository of ["codesensehq/codesense", "example/project", "another/project"]) {
      const accepted = repository === (setting ?? "codesensehq/codesense");
      for (const runner of ["vitest", "playwright"]) {
        const entry = {
          id: `${runner}:tests/frame-security/lifecycle.spec.ts#focus`,
          reason: "Awaiting fix",
          issue: `https://github.com/${repository}/issues/1`,
          added: "2026-11-07",
        };
        if (accepted) assert.doesNotThrow(() => validate([entry], now));
        else assert.throws(() => validate([entry], now));
        assert.equal(validEntries([entry], now).length, accepted ? 1 : 0);
        if (runner === "playwright") {
          const skipped = {
            outcome: () => "skipped",
            location: { file: resolve("tests/frame-security/lifecycle.spec.ts") },
            titlePath: () => ["", "webkit", "lifecycle.spec.ts", "focus"],
            annotations: [
              {
                type: "fixme",
                description: `quarantine: ${entry.reason} (${entry.issue}; added ${entry.added})`,
              },
            ],
          };
          assert.equal(unexecutedTests([skipped], [entry], now).length, accepted ? 0 : 1);
        }
      }
    }
  }
});

test("the guard lets through only the named Linux WebKit media skip", () => {
  const now = Date.parse("2026-11-27T00:00:00Z");
  const skipped = ({
    file = "tests/frame-security/hostile.spec.ts",
    project = "webkit",
    title = "native audio loads baseline media without shim credentials",
    annotation = { type: "skip", description: LINUX_WEBKIT_MEDIA_SKIP },
  } = {}) => ({
    outcome: () => "skipped",
    location: { file: resolve(file) },
    titlePath: () => ["", project, file.split("/").pop(), title],
    annotations: annotation ? [annotation] : [],
  });
  const missed = (test, platform = "linux") => unexecutedTests([test], [], now, platform).length;
  for (const title of [
    "native audio loads default-open live media without shim credentials",
    "native video loads default-open live media without shim credentials",
    "native audio loads baseline media without shim credentials",
    "native video loads baseline media without shim credentials",
  ])
    assert.equal(missed(skipped({ title })), 0, title);
  // Anything else still fails the run: another OS, engine, spec, file or reason, or no reason.
  assert.equal(missed(skipped(), "darwin"), 1);
  assert.equal(missed(skipped({ project: "chromium" })), 1);
  assert.equal(missed(skipped({ title: "native audio loads baseline media" })), 1);
  assert.equal(missed(skipped({ title: "a: sibling private DOM is isolated" })), 1);
  assert.equal(missed(skipped({ file: "tests/frame-security/lifecycle.spec.ts" })), 1);
  assert.equal(missed(skipped({ annotation: { type: "skip", description: "no codecs" } })), 1);
  assert.equal(
    missed(skipped({ annotation: { type: "fixme", description: LINUX_WEBKIT_MEDIA_SKIP } })),
    1,
  );
  assert.equal(missed(skipped({ annotation: null })), 1);
});

test("a Playwright quarantine can name the projects it covers, and the guard holds it to them", () => {
  const now = Date.parse("2026-11-27T00:00:00Z");
  const title = "focusOut returns to the previous host control";
  const entry = {
    id: `playwright:tests/frame-security/lifecycle.spec.ts#${title}`,
    reason: "Chromium refocuses the frame after focusOut",
    issue: "https://github.com/codesensehq/codesense/issues/463",
    added: "2026-11-27",
    projects: ["chromium"],
  };
  assert.doesNotThrow(() => validate([entry], now));
  for (const projects of [[], ["chromium", 1], "chromium"])
    assert.throws(() => validate([{ ...entry, projects }], now), /projects/);
  assert.throws(
    () => validate([{ ...entry, id: "vitest:src/a.test.ts#x", projects: ["chromium"] }], now),
    /projects/,
  );
  const skipped = (project) => ({
    outcome: () => "skipped",
    location: { file: resolve("tests/frame-security/lifecycle.spec.ts") },
    titlePath: () => ["", project, "lifecycle.spec.ts", title],
    annotations: [{ type: "fixme", description: quarantineReason(entry) }],
  });
  assert.equal(unexecutedTests([skipped("chromium")], [entry], now).length, 0);
  // The same title skipped on WebKit still fails the run.
  assert.equal(unexecutedTests([skipped("webkit")], [entry], now).length, 1);
  assert.equal(quarantineApplies(entry, "chromium"), true);
  assert.equal(quarantineApplies(entry, "webkit"), false);
  assert.equal(quarantineApplies({ ...entry, projects: undefined }, "webkit"), true);
});
