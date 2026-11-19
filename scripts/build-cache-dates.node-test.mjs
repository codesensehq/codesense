// SPDX-License-Identifier: MIT
// node --test scripts/build-cache-dates.node-test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("build-cache-dates.sh", import.meta.url));

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-cache-dates-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const git = (cwd, ...args) =>
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
const dates = (cwd, command) =>
  execFileSync("bash", [script, command], { cwd, encoding: "utf8", stdio: "pipe" });
const write = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
// touch -t 200001010000 is in the runner's local time.
const old = (root, file) => fs.lstatSync(path.join(root, file)).mtime.getFullYear() === 2000;

// The nightly's checkout: built, then recorded, at its first commit.
function nightly(t) {
  const origin = scratch(t);
  write(origin, ".gitignore", "target\nsrc-tauri/gen\n");
  write(origin, "src-tauri/src/lib.rs", "a\n");
  write(origin, "src-tauri/src/old.rs", "a\n");
  write(origin, "src-tauri/crates/x/src/lib.rs", "a\n");
  write(origin, "codesense-docs/content/page.md", "a\n");
  git(origin, "init", "-q", "-b", "main");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "base");
  write(origin, "src-tauri/gen/schema.json", "generated\n");
  write(origin, "src-tauri/gen/later.json", "generated\n");
  write(origin, "target/debug/app", "built\n");
  dates(origin, "record");
  return origin;
}

// A later run's fresh checkout of HEAD, with the nightly's target/ restored into it.
function later(t, origin) {
  const work = path.join(scratch(t), "work");
  git(path.dirname(work), "clone", "-q", origin, work);
  fs.cpSync(path.join(origin, "target"), path.join(work, "target"), { recursive: true });
  return work;
}

test("record keeps the commit, the untracked inputs and their digests in target/", (t) => {
  const origin = nightly(t);
  const state = path.join(origin, "target/ci-cache");
  assert.equal(
    fs.readFileSync(path.join(state, "source-sha"), "utf8").trim(),
    git(origin, "rev-parse", "HEAD"),
  );
  assert.match(
    fs.readFileSync(path.join(state, "inputs.sha256"), "utf8"),
    /src-tauri\/gen\/schema\.json/,
  );
  const names = execFileSync("tar", ["-tf", path.join(state, "inputs.tar")], { encoding: "utf8" });
  assert.deepEqual(names.trim().split("\n").sort(), [
    "src-tauri/gen/later.json",
    "src-tauri/gen/schema.json",
  ]);
});

test("restore dates old what the cached build saw, and now what changed since, whenever committed", (t) => {
  const origin = nightly(t);
  // Changes after the cached build, one of them in a commit dated long before it.
  write(origin, "src-tauri/crates/x/src/lib.rs", "b\n");
  git(origin, "add", ".");
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "x"], {
    cwd: origin,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_AUTHOR_DATE: "2001-01-01T00:00:00",
      GIT_COMMITTER_DATE: "2001-01-01T00:00:00",
    },
  });
  fs.rmSync(path.join(origin, "src-tauri/src/old.rs"));
  write(origin, "src-tauri/new/mod.rs", "a\n");
  // A file the cached build had untracked, tracked since with other content.
  write(origin, "src-tauri/gen/later.json", "tracked\n");
  git(origin, "add", "-A", "-f");
  git(origin, "commit", "-qm", "later");
  const work = later(t, origin);
  dates(work, "restore");
  for (const file of ["src-tauri/src/lib.rs", "codesense-docs/content/page.md", ".gitignore"])
    assert.ok(old(work, file), file);
  for (const directory of ["codesense-docs", "codesense-docs/content", "src-tauri/crates/x"])
    assert.ok(old(work, directory), directory);
  for (const file of [
    "src-tauri/crates/x/src/lib.rs",
    "src-tauri/new/mod.rs",
    "src-tauri/new",
    // The directory a file was deleted from.
    "src-tauri/src",
  ])
    assert.ok(!old(work, file), file);
  // The cached build's untracked inputs are back, but never over a file tracked since.
  assert.equal(
    fs.readFileSync(path.join(work, "src-tauri/gen/schema.json"), "utf8"),
    "generated\n",
  );
  assert.equal(fs.readFileSync(path.join(work, "src-tauri/gen/later.json"), "utf8"), "tracked\n");
  assert.equal(git(work, "status", "--porcelain"), "");
  assert.ok(fs.existsSync(path.join(work, "target/debug/app")));
});

test("pin dates old each input rewritten as the cached build read it, and leaves the rest", (t) => {
  const origin = nightly(t);
  const work = later(t, origin);
  dates(work, "restore");
  // The steps before the build write the inputs again: one as it was, one changed, one new.
  write(work, "src-tauri/gen/schema.json", "generated\n");
  write(work, "src-tauri/gen/later.json", "changed\n");
  write(work, "src-tauri/gen/new.json", "new\n");
  dates(work, "pin");
  assert.ok(old(work, "src-tauri/gen/schema.json"));
  assert.ok(old(work, "src-tauri/gen"));
  assert.ok(!old(work, "src-tauri/gen/later.json"));
  assert.ok(!old(work, "src-tauri/gen/new.json"));
  assert.ok(old(work, "src-tauri/src/lib.rs"));
});

test("a cached build without a commit this checkout has is removed, for a cold build", (t) => {
  const origin = nightly(t);
  const work = later(t, origin);
  fs.writeFileSync(path.join(work, "target/ci-cache/source-sha"), `${"a".repeat(40)}\n`);
  dates(work, "restore");
  assert.ok(!fs.existsSync(path.join(work, "target")));
  assert.ok(!old(work, "src-tauri/src/lib.rs"));
  // pin then has nothing to do.
  dates(work, "pin");
  assert.ok(!old(work, "src-tauri/src/lib.rs"));

  const unrecorded = later(t, origin);
  fs.rmSync(path.join(unrecorded, "target/ci-cache"), { recursive: true });
  dates(unrecorded, "restore");
  assert.ok(!fs.existsSync(path.join(unrecorded, "target")));
});

test("the script refuses an unknown command", () => {
  assert.throws(() => dates(os.tmpdir(), "save"), /usage/);
});
