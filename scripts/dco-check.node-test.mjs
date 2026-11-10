// SPDX-License-Identifier: MIT
// node --test scripts/dco-check.node-test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { dependabotCommits, pullAuthor, unsignedCommits } from "./dco-check.mjs";

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

// A merge group as the queue builds it: one merge commit per queued pull request on
// main's first-parent chain, the second parent being that pull request's head.
function queue(t) {
  const f = fixture(t);
  const entry = (branch, ...commits) => {
    f.git("checkout", "-q", "-b", branch, f.base);
    const shas = commits.map(([message, ...flags]) => f.commit(message, ...flags));
    f.git("checkout", "-q", "main");
    f.git("merge", "--no-ff", "-q", "-m", `Merge ${branch}`, branch);
    return shas;
  };
  return { ...f, entry };
}
const unsignedBots = (f, head) =>
  new Set(
    f
      .check(head)
      .filter(({ author }) => author.includes("dependabot"))
      .map(({ sha }) => sha),
  );

test("on a merge group, bot commits are exempt only under a Dependabot pull request", async (t) => {
  const f = queue(t);
  const [human] = f.entry("human", ["Human", "-s"]);
  const [bump] = f.entry("bump", ["Bump", `--author=${BOT}`]);
  const [forged] = f.entry("forged", ["Forged", `--author=${BOT}`]);
  const head = f.git("rev-parse", "HEAD");
  const heads = { [bump]: "dependabot[bot]", [forged]: "ada", [human]: "ada" };
  const asked = [];
  const authorOf = async (sha) => (asked.push(sha), heads[sha] ?? "");
  const candidates = unsignedBots(f, head);
  assert.deepEqual(candidates, new Set([bump, forged]));
  const exempt = await dependabotCommits({ cwd: f.dir, base: f.base, head, candidates, authorOf });
  assert.deepEqual(exempt, new Set([bump]));
  // Only entries holding an unsigned bot commit are looked up.
  assert.deepEqual(asked.sort(), [bump, forged].sort());
});

test("on a merge group with no unsigned bot commits nothing is looked up", async (t) => {
  const f = queue(t);
  f.entry("human", ["Human", "-s"]);
  const head = f.git("rev-parse", "HEAD");
  const authorOf = async () => assert.fail("no lookup expected");
  const candidates = unsignedBots(f, head);
  assert.deepEqual(
    await dependabotCommits({ cwd: f.dir, base: f.base, head, candidates, authorOf }),
    new Set(),
  );
});

test("on a merge group, a bot commit outside any queued merge stays unsigned", async (t) => {
  const f = queue(t);
  const bump = f.commit("Bump", `--author=${BOT}`);
  const head = f.git("rev-parse", "HEAD");
  const authorOf = async () => "dependabot[bot]";
  const candidates = unsignedBots(f, head);
  assert.deepEqual(candidates, new Set([bump]));
  assert.deepEqual(
    await dependabotCommits({ cwd: f.dir, base: f.base, head, candidates, authorOf }),
    new Set(),
  );
});

// A stand-in for the GitHub API: commits/<sha>/pulls answers from `pulls`, by head sha.
async function api(t, pulls, status = 200) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    const sha = /^\/repos\/example\/project\/commits\/([0-9a-f]+)\/pulls$/.exec(req.url)?.[1];
    res.writeHead(sha ? status : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(sha ? (pulls[sha] ?? []) : {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const env = {
    GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
    GITHUB_REPOSITORY: "example/project",
    GITHUB_TOKEN: "token-for-test",
  };
  return { env, seen };
}
const pull = (sha, login) => ({ head: { sha }, user: { login } });

test("pullAuthor names the single author of the pull requests with that head", async (t) => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const c = "c".repeat(40);
  const { env, seen } = await api(t, {
    [a]: [pull(a, "dependabot[bot]"), pull("d".repeat(40), "ada")],
    [b]: [pull(b, "dependabot[bot]"), pull(b, "ada")],
  });
  assert.equal(await pullAuthor(a, env), "dependabot[bot]");
  assert.equal(await pullAuthor(b, env), "");
  assert.equal(await pullAuthor(c, env), "");
  assert.equal(seen[0].authorization, "Bearer token-for-test");
});

test("pullAuthor fails closed when the lookup fails", async (t) => {
  const { env } = await api(t, {}, 500);
  await assert.rejects(pullAuthor("a".repeat(40), env), /^Error: dco: cannot look up .*HTTP 500/);
});

test("the CLI derives the merge group exemption from the GitHub API", async (t) => {
  const f = queue(t);
  const [bump] = f.entry("bump", ["Bump", `--author=${BOT}`]);
  const [forged] = f.entry("forged", ["Forged", `--author=${BOT}`]);
  const head = f.git("rev-parse", "HEAD");
  const { env: apiEnv } = await api(t, {
    [bump]: [pull(bump, "dependabot[bot]")],
    [forged]: [pull(forged, "ada")],
  });
  const cli = (event) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [script], {
        cwd: f.dir,
        env: { ...env, ...apiEnv, DCO_BASE: f.base, DCO_HEAD: head, DCO_EVENT: event },
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => resolve({ status, stderr }));
    });
  for (const event of ["merge_group", "pull_request"]) {
    const run = await cli(event);
    assert.equal(run.status, 1, event);
    assert.match(run.stderr, new RegExp(forged.slice(0, 12)), event);
    // The pull request path keeps its own author rule; only the merge group asks the API.
    assert[event === "merge_group" ? "doesNotMatch" : "match"](
      run.stderr,
      new RegExp(bump.slice(0, 12)),
      event,
    );
  }
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
