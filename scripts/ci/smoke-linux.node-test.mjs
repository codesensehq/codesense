// SPDX-License-Identifier: MIT
// node --test scripts/ci/smoke-linux.node-test.mjs (the Linux packaging smoke's checks)
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("smoke-linux.sh", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-linux-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
let fixtures = 0;
const fixture = (lines) => {
  const file = path.join(dir, `fixture-${fixtures++}`);
  fs.writeFileSync(file, lines.map((line) => `${line}\n`).join(""));
  return file;
};
const smoke = (...args) => spawnSync("bash", [script, ...args], { encoding: "utf8" });
const passes = (result) => assert.equal(result.status, 0, result.stderr);
const fails = (result, error) => {
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, error);
};

// What `dpkg -L` prints for the deb: directories too, and the app's files under /usr/lib.
const debListing = [
  "/.",
  "/usr",
  "/usr/bin",
  "/usr/bin/codesense",
  "/usr/bin/codesense-bridge",
  "/usr/bin/codesense-emulator",
  "/usr/bin/codesense-session-server",
  "/usr/lib/CodeSense/resources/starship-compact.toml",
  "/usr/share/applications/CodeSense.desktop",
];

test("check-listing: the app binary and the three sidecars in /usr/bin pass", () => {
  passes(smoke("check-listing", fixture(debListing)));
});

test("check-listing: a missing sidecar or an extra file in /usr/bin fails", () => {
  fails(
    smoke("check-listing", fixture(debListing.filter((line) => !line.endsWith("-emulator")))),
    /codesense-emulator is not in \/usr\/bin/,
  );
  fails(
    smoke("check-listing", fixture([...debListing, "/usr/bin/extra"])),
    /expected the app binary and three sidecars/,
  );
});

test("same-resources: the deb and the rpm must ship the same starship and git-ai", () => {
  const starship = "/usr/lib/CodeSense/resources/starship";
  const gitAi = "/usr/lib/CodeSense/resources/git-ai";
  passes(smoke("same-resources", fixture(debListing), fixture(debListing)));
  // Listed in any order.
  passes(
    smoke("same-resources", fixture([...debListing, starship, gitAi]), fixture([gitAi, starship])),
  );
  fails(
    smoke("same-resources", fixture([...debListing, starship]), fixture(debListing)),
    /resources\/starship/,
  );
  fails(
    smoke("same-resources", fixture([gitAi, starship]), fixture([starship])),
    /resources\/git-ai/,
  );
});
