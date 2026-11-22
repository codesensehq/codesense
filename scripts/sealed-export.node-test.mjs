// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATALOG,
  PROFILES,
  SEAL,
  payloadPath,
  referenceInputs,
} from "./generate-mcp-reference.mjs";
import {
  FROZEN_EXPORTS,
  REFRESH_ROUTE,
  driftBase,
  driftInheritedFromMain,
  exportsUntouchedSinceMain,
  frozenExport,
  strictExports,
} from "./lib/sealed-export.mjs";

test("the export pins compare strictly only when CS_STRICT_EXPORTS is 1", () => {
  assert.equal(strictExports({ CS_STRICT_EXPORTS: "1" }), true);
  for (const value of [undefined, "", "0", "true", " 1"])
    assert.equal(strictExports({ CS_STRICT_EXPORTS: value }), false, String(value));
  assert.equal(strictExports({}), false);
});

const GENERATED = "codesense-docs/getting-started/content/generated";

test("FROZEN_EXPORTS lists exactly the cargo-written exports", () => {
  assert.deepEqual(FROZEN_EXPORTS, [
    `${GENERATED}/live-data-contract.json`,
    `${GENERATED}/live-data-contract.inputs.json`,
    `${GENERATED}/mcp-tools.default.json`,
    `${GENERATED}/mcp-tools.dashboard-publish.json`,
    `${GENERATED}/mcp-tools.inputs.json`,
    "src-tauri/src/docs_schemas.generated.json",
  ]);
  assert.ok(Object.isFrozen(FROZEN_EXPORTS));
  // Node renders these from the exports, so PRs keep editing them.
  for (const path of [
    `${GENERATED}/mcp-tools.json`,
    `${GENERATED}/schemas/routine-yml.schema.json`,
    `${GENERATED}/schemas.json`,
    "codesense-docs/getting-started/content/arc-g-routines/routine-yml.html",
  ])
    assert.ok(!FROZEN_EXPORTS.includes(path), path);
  assert.ok(!FROZEN_EXPORTS.some((path) => path.endsWith(".schema.json")));
});

test("the tool catalog is not an input of the MCP seal", () => {
  assert.ok(!(CATALOG in referenceInputs()));
  assert.ok("src-tauri/src/mcp/handler.rs" in referenceInputs());
});

test("each reader takes its own export's files from the one list", () => {
  const readers = [
    frozenExport(`${GENERATED}/live-data-contract`),
    frozenExport(`${GENERATED}/mcp-tools`),
    frozenExport("src-tauri/src/docs_schemas.generated.json"),
  ];
  assert.deepEqual(
    readers.map((files) => files.length),
    [2, 3, 1],
  );
  assert.deepEqual(readers.flat().sort(), [...FROZEN_EXPORTS].sort());
  assert.deepEqual(frozenExport(`${GENERATED}/mcp`), []);
  // A profile added to the MCP export must be frozen too, or a PR could edit its payload unseen.
  assert.deepEqual(
    [SEAL, ...PROFILES.map(payloadPath)].sort(),
    [...frozenExport(`${GENERATED}/mcp-tools`)].sort(),
  );
});

test("the stale-export route tells a contributor to leave the exports out", () => {
  assert.match(REFRESH_ROUTE, /^leave generated exports out of your PR; maintainers refresh them/);
  assert.doesNotMatch(REFRESH_ROUTE, /gh workflow|docs:refresh-mcp|--export/);
});

test("in a merge group, inherited drift is measured against the group's parent", (t) => {
  assert.equal(driftBase({ GITHUB_EVENT_NAME: "merge_group" }), "HEAD^1");
  for (const event of ["pull_request", "push", undefined])
    assert.equal(driftBase({ GITHUB_EVENT_NAME: event }), "origin/main", String(event));
  // main at A; an earlier queued entry B changed an input; this entry P changed something else,
  // and the queue merged it onto B as C. origin/main still points at A.
  const root = mkdtempSync(join(tmpdir(), "drift-base-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const commit = (file, text) => {
    writeFileSync(join(root, file), text);
    git("add", file);
    git("commit", "-qm", file);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  commit("input.rs", "a\n");
  commit("other.rs", "a\n");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-qb", "entry");
  commit("other.rs", "p\n");
  git("checkout", "-q", "main");
  commit("input.rs", "b\n");
  git("merge", "-q", "--no-ff", "-m", "group", "entry");
  const group = { GITHUB_EVENT_NAME: "merge_group" };
  const pr = { GITHUB_EVENT_NAME: "pull_request" };
  assert.equal(exportsUntouchedSinceMain(root, ["input.rs"], group), true);
  assert.equal(driftInheritedFromMain(root, ["input.rs"], group), true);
  assert.equal(exportsUntouchedSinceMain(root, ["other.rs"], group), false);
  // Against origin/main the earlier entry's input change would read as this entry's.
  assert.equal(exportsUntouchedSinceMain(root, ["input.rs"], pr), false);
  assert.equal(driftInheritedFromMain(root, ["input.rs"], pr), false);
});
