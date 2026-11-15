// SPDX-License-Identifier: MIT
// node --test scripts/tauri-versions.node-test.mjs
// `tauri build` refuses to bundle when an npm Tauri package and its Rust crate differ in
// major.minor, and CI never runs it, so a one-sided Dependabot bump would only show at release.
// This checks the versions both lockfiles resolve, the same pair the Tauri CLI compares.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parse } from "yaml";

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

// @tauri-apps/api pairs with the tauri crate, @tauri-apps/plugin-<name> with tauri-plugin-<name>.
const crateFor = (npmName) =>
  npmName === "@tauri-apps/api"
    ? "tauri"
    : npmName.startsWith("@tauri-apps/plugin-")
      ? `tauri-plugin-${npmName.slice("@tauri-apps/plugin-".length)}`
      : null;

const majorMinor = (version) => version.split(".").slice(0, 2).join(".");

function mismatches(npmVersions, crateVersions) {
  const errors = [];
  for (const [npmName, npmVersion] of Object.entries(npmVersions)) {
    const crate = crateFor(npmName);
    if (!crate) continue;
    const versions = crateVersions.get(crate) ?? [];
    if (versions.length !== 1)
      errors.push(`${npmName} ${npmVersion}: Cargo.lock has ${versions.length} ${crate} versions`);
    else if (majorMinor(versions[0]) !== majorMinor(npmVersion))
      errors.push(`${npmName} ${npmVersion} does not match ${crate} ${versions[0]}`);
  }
  return errors;
}

function npmVersions() {
  const root = parse(read("pnpm-lock.yaml")).importers["."];
  const deps = { ...root.dependencies, ...root.devDependencies };
  return Object.fromEntries(
    Object.entries(deps).map(([name, entry]) => [name, String(entry.version).split("(")[0]]),
  );
}

function crateVersions() {
  const versions = new Map();
  for (const [, name, version] of read("Cargo.lock").matchAll(
    /^name = "([^"]+)"\nversion = "([^"]+)"$/gm,
  ))
    versions.set(name, [...(versions.get(name) ?? []), version]);
  return versions;
}

test("each npm Tauri package matches its Rust crate's major.minor", () => {
  const npm = npmVersions();
  assert.ok(npm["@tauri-apps/api"], "pnpm-lock.yaml resolves @tauri-apps/api");
  assert.deepEqual(mismatches(npm, crateVersions()), []);
});

test("a one-sided minor bump is reported", () => {
  const crates = new Map([
    ["tauri", ["2.12.5"]],
    ["tauri-plugin-log", ["2.8.0"]],
  ]);
  assert.deepEqual(
    mismatches({ "@tauri-apps/api": "2.12.4", "@tauri-apps/plugin-log": "2.10.1" }, crates),
    ["@tauri-apps/plugin-log 2.10.1 does not match tauri-plugin-log 2.8.0"],
  );
  assert.deepEqual(mismatches({ "@tauri-apps/cli": "2.12.4" }, crates), []);
});
