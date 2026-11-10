// SPDX-License-Identifier: MIT
// node --test scripts/commit-email-audit.node-test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ALLOWED_EMAILS, auditCommits, revisionArgs } from "./commit-email-audit.mjs";

const script = fileURLToPath(new URL("./commit-email-audit.mjs", import.meta.url));
const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" };
const NOREPLY = "123+sam@users.noreply.github.com";
const PERSONAL = { name: "Pat Personal", email: "pat.personal@example.com" };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commit-email-audit-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (args, extra = {}) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...env, ...extra },
    }).trim();
  git(["init", "--initial-branch=main"]);
  git(["config", "commit.gpgsign", "false"]);
  const commit = ({ author = { name: "Bot", email: NOREPLY }, committer = author, date } = {}) => {
    git(["commit", "--allow-empty", "-m", "change"], {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    });
    return { full: git(["rev-parse", "HEAD"]), short: git(["rev-parse", "--short", "HEAD"]) };
  };
  const cli = (...args) =>
    spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8", env });
  return { dir, git, commit, cli };
}

test("every allowed identity passes", (t) => {
  const f = fixture(t);
  for (const email of [...ALLOWED_EMAILS.exact, NOREPLY, "Release@CodeSense.ai"])
    f.commit({ author: { name: "Allowed", email } });
  assert.deepEqual(auditCommits({ cwd: f.dir, all: true }).violations, []);
  const run = f.cli("--all");
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /0 of 7 commits/);
  const recent = f.cli();
  assert.equal(recent.status, 0, recent.stderr);
  assert.match(recent.stdout, /7 commits OK/);
});

test("a personal-looking email fails with its short SHA and field", (t) => {
  const f = fixture(t);
  const base = f.commit();
  const bad = f.commit({ author: PERSONAL });
  for (const args of [[], ["--all"], [`${base.full}..HEAD`]]) {
    const run = f.cli(...args);
    assert.equal(run.status, 1, args.join(" "));
    assert.match(run.stdout, new RegExp(`^${bad.short} author$`, "m"));
    assert.match(run.stdout, new RegExp(`^${bad.short} committer$`, "m"));
  }
  // Lookalikes of the allowed domains fail too.
  for (const email of [
    // The bare domain is built so the privacy scan does not read it as an address.
    ["someone", "noreply.github.com"].join("@"),
    "a@users.noreply.github.com.example.com",
    "release@codesense.ai.example.com",
    "x@release@codesense.ai",
  ])
    f.commit({ author: { name: "Lookalike", email } });
  assert.equal(auditCommits({ cwd: f.dir, all: true }).violations.length, 10);
});

test("output never carries an email or name, even a strange one", (t) => {
  const f = fixture(t);
  const strange = [
    { name: 'Zed "Quote" O\'Brien', email: "z.e.d+tag$(id)@exämple.co" },
    { name: "Tab\tName", email: "%ae%h@[127.0.0.1]" },
    { name: "Unicode Ünïcödé", email: "ünïcödé@例え.jp" },
    { name: "Bare", email: "no-at-sign" },
  ];
  for (const who of strange) f.commit({ author: who, committer: PERSONAL });
  for (const args of [[], ["--all"]]) {
    const run = f.cli(...args);
    assert.equal(run.status, 1);
    const output = run.stdout + run.stderr;
    for (const { name, email } of [...strange, PERSONAL]) {
      assert.ok(!output.includes(email), "email leaked");
      assert.ok(!output.includes(email.split("@")[0]), "local part leaked");
      for (const word of name.split(/\s+/)) assert.ok(!output.includes(word), "name leaked");
    }
    for (const line of run.stdout.trim().split("\n"))
      assert.match(
        line,
        /^[0-9a-f]{7,} (?:author|committer)$|^commit-email-audit: \d+ of \d+ commits/,
      );
  }
});

test("the committer is checked separately from the author", (t) => {
  const f = fixture(t);
  const committerOnly = f.commit({ committer: PERSONAL });
  const authorOnly = f.commit({ author: PERSONAL, committer: { name: "Bot", email: NOREPLY } });
  const { violations } = auditCommits({ cwd: f.dir, all: true });
  assert.deepEqual(
    violations.map(({ sha, field }) => [sha, field]),
    [
      [authorOnly.short, "author"],
      [committerOnly.short, "committer"],
    ],
  );
});

test("--all counts commits with a disallowed email once each", (t) => {
  const f = fixture(t);
  f.commit();
  f.commit({ author: PERSONAL });
  f.commit({ committer: PERSONAL });
  f.commit();
  const run = f.cli("--all");
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^commit-email-audit: 2 of 4 commits have a disallowed email$/m);
  assert.equal(run.stdout.trim().split("\n").length, 3 + 1);
});

test("the default window skips older commits, and a range covers merged ones", (t) => {
  const f = fixture(t);
  const old = f.commit({ author: PERSONAL, date: "2001-01-01T00:00:00Z" });
  f.commit();
  const quiet = f.cli("--hours", "26");
  assert.equal(quiet.status, 0, quiet.stdout);
  f.git(["checkout", "-q", "-b", "side", old.full]);
  const side = f.commit({ committer: PERSONAL });
  f.git(["checkout", "-q", "main"]);
  f.git(["merge", "-q", "--no-ff", "-m", "merge", "side"], {
    GIT_AUTHOR_NAME: "Bot",
    GIT_AUTHOR_EMAIL: NOREPLY,
    GIT_COMMITTER_NAME: "Bot",
    GIT_COMMITTER_EMAIL: NOREPLY,
  });
  const run = f.cli(`${old.full}..HEAD`);
  assert.equal(run.status, 1);
  assert.equal(run.stdout.trim(), `${side.short} committer`);
});

test("a pushed range checks a backdated commit; an all-zero base falls back to the window", (t) => {
  const f = fixture(t);
  const before = f.commit();
  const backdated = f.commit({ author: PERSONAL, date: "2001-01-01T00:00:00Z" });
  const after = f.commit();
  // The window alone misses the backdated commit; the pushed range does not.
  assert.equal(f.cli("--hours", "26").status, 0);
  const range = f.cli("--hours", "26", `${before.full}..${after.full}`);
  assert.equal(range.status, 1);
  assert.equal(range.stdout.trim(), `${backdated.short} author\n${backdated.short} committer`);
  // A new branch: the window up to the pushed head, not HEAD.
  const recent = f.commit({ committer: PERSONAL });
  for (const zeros of ["0".repeat(40), "0".repeat(64)]) {
    const fallback = f.cli("--hours", "26", `${zeros}..${after.full}`);
    assert.equal(fallback.status, 0, fallback.stdout);
    // git stops the window's walk at the backdated commit, as on the schedule.
    assert.match(fallback.stdout, /^commit-email-audit: 1 commits OK$/m);
    const head = f.cli(`${zeros}..HEAD`);
    assert.equal(head.status, 1);
    assert.equal(head.stdout.trim(), `${recent.short} committer`);
  }
});

test("bad arguments exit 2 without running git on them", (t) => {
  const f = fixture(t);
  f.commit();
  for (const args of [
    ["--hours"],
    ["--hours", "-1"],
    ["--all", "--hours", "3"],
    ["--output=/tmp/x..HEAD"],
    ["a...b"],
    ["main"],
  ])
    assert.equal(f.cli(...args).status, 2, args.join(" "));
  assert.throws(() => revisionArgs({ hours: 0 }), /positive/);
  assert.deepEqual(revisionArgs({ hours: 1, now: Date.parse("2026-01-01T01:00:00Z") }), [
    "--since=2026-01-01T00:00:00.000Z",
    "HEAD",
  ]);
});
