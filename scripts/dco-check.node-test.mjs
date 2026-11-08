// SPDX-License-Identifier: MIT
// node --test scripts/dco-check.node-test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { unsignedCommits } from "./dco-check.mjs";

const script = fileURLToPath(new URL("./dco-check.mjs", import.meta.url));
const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dco-check-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe", env }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Ada Author");
  git("config", "user.email", "ada@example.com");
  git("config", "commit.gpgsign", "false");
  const commit = (message, ...flags) => {
    git("commit", "--allow-empty", "-m", message, ...flags);
    return git("rev-parse", "HEAD");
  };
  const base = commit("Initial");
  const check = (head = git("rev-parse", "HEAD"), from = base, prAuthor) =>
    unsignedCommits({ cwd: dir, base: from, head, prAuthor });
  const cli = (head = git("rev-parse", "HEAD"), prAuthor = "") =>
    spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: "utf8",
      env: { ...env, DCO_BASE: base, DCO_HEAD: head, DCO_PR_AUTHOR: prAuthor },
    });
  return { dir, git, commit, base, check, cli };
}

test("signed commits pass, from the CLI too", (t) => {
  const f = fixture(t);
  f.commit("One", "-s");
  f.commit("Two\n\nSigned-off-by: Ada Author <ADA@Example.com>");
  assert.deepEqual(f.check(), []);
  const run = f.cli();
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /every commit is signed off/);
});

test("an unsigned commit fails and is listed", (t) => {
  const f = fixture(t);
  f.commit("Signed", "-s");
  const unsigned = f.commit("Unsigned");
  assert.deepEqual(f.check(), [{ sha: unsigned, author: "ada@example.com" }]);
  const run = f.cli();
  assert.equal(run.status, 1);
  assert.match(run.stderr, new RegExp(unsigned.slice(0, 12)));
});

test("a sign-off with another email does not count", (t) => {
  const f = fixture(t);
  const sha = f.commit("Other\n\nSigned-off-by: Someone Else <else@example.com>");
  assert.deepEqual(f.check(), [{ sha, author: "ada@example.com" }]);
});

test("a matching sign-off among several counts", (t) => {
  const f = fixture(t);
  f.commit(
    "Pair\n\nSigned-off-by: Someone Else <else@example.com>\nSigned-off-by: Ada Author <ada@example.com>",
  );
  assert.deepEqual(f.check(), []);
});

test("merge commits are skipped", (t) => {
  const f = fixture(t);
  f.git("checkout", "-q", "-b", "topic");
  f.commit("Topic", "-s");
  f.git("checkout", "-q", "main");
  f.commit("Main", "-s");
  f.git("merge", "--no-ff", "-q", "-m", "Merge topic", "topic");
  assert.deepEqual(f.check(), []);
});

test("an empty range passes", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.check(f.base), []);
});

test("a sign-off followed by a comment counts", (t) => {
  const f = fixture(t);
  f.commit("Note\n\nSigned-off-by: Ada Author <ada@example.com> (rebased)");
  assert.deepEqual(f.check(), []);
});

test("an empty author email fails even with a sign-off", (t) => {
  const f = fixture(t);
  const sha = f.commit("Empty\n\nSigned-off-by: Ada Author < >", "--author=Ada Author <>");
  assert.deepEqual(f.check(), [{ sha, author: "" }]);
  assert.match(f.cli().stderr, /\(no author email\)/);
});

const BOT = "dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>";

test("bot-email commits are exempt on a Dependabot pull request", (t) => {
  const f = fixture(t);
  f.commit("Bump", `--author=${BOT}`);
  assert.deepEqual(f.check(undefined, f.base, "dependabot[bot]"), []);
});

test("a forged bot email on a human pull request fails", (t) => {
  const f = fixture(t);
  const sha = f.commit("Forged", `--author=${BOT}`);
  const expected = [{ sha, author: "49699333+dependabot[bot]@users.noreply.github.com" }];
  assert.deepEqual(f.check(undefined, f.base, "ada"), expected);
  assert.deepEqual(f.check(), expected);
});

test("a near-miss bot email on a Dependabot pull request fails", (t) => {
  const f = fixture(t);
  const sha = f.commit("Near", "--author=x <x-dependabot[bot]@users.noreply.github.com>");
  assert.deepEqual(f.check(undefined, f.base, "dependabot[bot]"), [
    { sha, author: "x-dependabot[bot]@users.noreply.github.com" },
  ]);
});

test("another bot's commit on a Dependabot pull request fails", (t) => {
  const f = fixture(t);
  const sha = f.commit("Other", "--author=other[bot] <1+other[bot]@users.noreply.github.com>");
  assert.deepEqual(f.check(undefined, f.base, "dependabot[bot]"), [
    { sha, author: "1+other[bot]@users.noreply.github.com" },
  ]);
});

test("the CLI reads the pull request author from DCO_PR_AUTHOR", (t) => {
  const f = fixture(t);
  f.commit("Bump", `--author=${BOT}`);
  const pass = f.cli(undefined, "dependabot[bot]");
  assert.equal(pass.status, 0, pass.stderr);
  const fail = f.cli(undefined, "ada");
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /dependabot\[bot\]@users\.noreply\.github\.com/);
});

test("a Dependabot pull request still needs sign-off from human authors", (t) => {
  const f = fixture(t);
  const sha = f.commit("Human fixup");
  assert.deepEqual(f.check(undefined, f.base, "dependabot[bot]"), [
    { sha, author: "ada@example.com" },
  ]);
});

test("a missing, short or zero revision fails closed", (t) => {
  const f = fixture(t);
  assert.throws(() => f.check("abc123"), /^Error: dco: head must be a full/);
  const run = f.cli("");
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^dco: head must be a full/);
  assert.throws(
    () => f.check(f.base, "0".repeat(40)),
    /^Error: dco: cannot read the commit range: \S/,
  );
});

test("the CLI reports a range error when git is missing", (t) => {
  const f = fixture(t);
  f.commit("One", "-s");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dco-check-nogit-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const head = f.git("rev-parse", "HEAD");
  const run = spawnSync(process.execPath, [script], {
    cwd: f.dir,
    encoding: "utf8",
    env: { ...env, PATH: empty, DCO_BASE: f.base, DCO_HEAD: head },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^dco: cannot read the commit range: .*ENOENT/);
});
