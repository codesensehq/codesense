// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  isPublicRemote,
  scanPush,
  withoutMaintainerTagIdentity,
  LOCATION_FIX,
} from "./privacy-ci.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const INSTALL = path.join(SCRIPTS, "git-hooks", "install.sh");
const CLI = path.join(SCRIPTS, "privacy-ci.mjs");
// Fake terms only: the fixture inventory fills every private slot.
const TERM = "zqfixtureprivateterm";
const INVENTORY = {
  version: 1,
  rules: [5, 6, 7, 8, 9, 24].map((order) => ({
    id: `fixture-${order}`,
    sev: order === 24 ? "text" : "error",
    kind: "show",
    source: order === 24 ? "zqfixturetextonly" : `${TERM}${order === 5 ? "" : order}`,
    flags: [6, 7, 8].includes(order) ? "gi" : "g",
    order,
    classification: "private-only",
  })),
};
// The maintainer's identity, built so this file never holds the handle whole.
const HANDLE = ["alfy", "pops"].join("");
const NOREPLY = `6836580+${HANDLE}@users.noreply.github.com`;
const SIGNOFF = `Signed-off-by: ${HANDLE} <${NOREPLY}>`;
const PUBLIC_URLS = [
  "https://github.com/codesensehq/codesense",
  "https://github.com/CodeSenseHQ/codesense.git",
  "https://github.com/codesensehq/codesense/",
  "https://git@github.com/codesensehq/codesense.git",
  "git@github.com:codesensehq/codesense.git",
  "ssh://git@github.com/codesensehq/codesense.git",
  "ssh://git@github.com:22/codesensehq/codesense",
  "github-alias:codesensehq/codesense.git",
  "https://github.com/%63odesensehq/codesense",
  "https://github.com",
  "https://GitHub.com/only-owner",
  "github.com:weird//",
];
const OTHER_URLS = [
  "https://github.com/example/project.git",
  "git@github.com:example/project.git",
  "ssh://git@github.com/example/project/",
  "https://gitlab.com/example/project.git",
  "/tmp/somewhere.git",
];

// The real clone's hooks directory is shared by every worktree; the suite must
// never write to it. Compare names and contents (link targets for links).
const realHooks = execFileSync(
  "git",
  ["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
  { cwd: SCRIPTS, encoding: "utf8" },
).trim();
const snapshot = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true })
        .sort()
        .map((name) => {
          const file = path.join(dir, name);
          const stat = fs.lstatSync(file);
          if (stat.isSymbolicLink()) return `${name} -> ${fs.readlinkSync(file)}`;
          if (stat.isDirectory()) return `${name}/`;
          return `${name} ${stat.mode} ${fs.readFileSync(file, "base64")}`;
        })
    : [];
const realBefore = snapshot(realHooks);
test.after(() => assert.deepEqual(snapshot(realHooks), realBefore));

// handle: the fixture inventory blocks the maintainer's handle too, as the real one does.
function sandbox(t, { inventory = true, handle = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-hooks-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const work = path.join(root, "work");
  const bare = path.join(root, "public.git");
  const other = path.join(root, "other.git");
  fs.mkdirSync(home);
  const terms = path.join(root, "terms.json");
  const rules = INVENTORY.rules.map((rule) =>
    handle && rule.order === 5 ? { ...rule, source: `${TERM}|${HANDLE}` } : rule,
  );
  fs.writeFileSync(terms, JSON.stringify({ ...INVENTORY, rules }));
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_") || key.startsWith("CODESENSE_PRIVACY")) delete env[key];
  Object.assign(env, {
    HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    CODESENSE_PRIVACY_PUBLIC_REMOTES: bare,
  });
  if (inventory) env.CODESENSE_PRIVACY_TERMS = terms;
  const run = (args, options = {}) =>
    spawnSync("git", args, { cwd: work, encoding: "utf8", env, ...options });
  const git = (...args) => {
    const result = run(args);
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };
  // Pushes and commits start a detached `git maintenance run --auto` that can
  // outlive the test and write into the sandbox while it is removed.
  execFileSync("git", ["config", "--global", "maintenance.auto", "false"], { env });
  execFileSync("git", ["config", "--global", "gc.auto", "0"], { env });
  for (const dir of [bare, other]) execFileSync("git", ["init", "--bare", "-q", dir], { env });
  execFileSync("git", ["init", "-q", "--initial-branch=main", work], { env });
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  git("remote", "add", "public", bare);
  git("remote", "add", "other", other);
  // The dispatcher runs the checkout's own scripts/git-hooks, as in a real clone.
  fs.symlinkSync(SCRIPTS, path.join(work, "scripts"));
  fs.appendFileSync(path.join(work, ".git", "info", "exclude"), "/scripts\n/release\n");
  const stage = (file, content) => {
    fs.writeFileSync(path.join(work, file), content);
    git("add", "--", file);
  };
  const commit = (file, content, message = "Fixture change") => {
    stage(file, content);
    // Fixture commits skip commit-msg so the pre-push layer is what is tested.
    git("commit", "-q", "--no-verify", "-m", message);
    return git("rev-parse", "HEAD").trim();
  };
  const install = (extraEnv = {}) =>
    spawnSync("sh", [INSTALL], { cwd: work, encoding: "utf8", env: { ...env, ...extraEnv } });
  const hooks = path.join(work, ".git", "hooks");
  // A push that skips the hooks, to seed remote state.
  const seed = (...args) => git("-c", `core.hooksPath=${os.devNull}`, "push", "-q", ...args);
  const remoteHas = (ref) =>
    spawnSync("git", ["--git-dir", bare, "rev-parse", "--verify", "-q", ref], { env }).status === 0;
  return {
    root,
    env,
    work,
    bare,
    other,
    hooks,
    git,
    run,
    stage,
    commit,
    install,
    seed,
    remoteHas,
    terms,
  };
}

const blocked = (result) => {
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /privacy-scan: fixture-\d+ x\d+/);
  assert.ok(!result.stderr.includes(TERM), "output is redacted");
  assert.ok(!result.stdout.includes(TERM), "output is redacted");
};
const passed = (result) => assert.equal(result.status, 0, result.stderr);
// Blocked by one named rule, with the handle never printed.
const refused = (result, rule) => {
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`privacy-scan: ${rule} x\\d+`));
  assert.ok(!result.stderr.includes(HANDLE), "output is redacted");
};
// A commit refused at commit time: one `rule  place  fix` line per finding, the
// fix a rerun, and no term, handle or staged path printed.
const commitRefused = (result, rule) => {
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`^privacy-scan: ${rule}  \\S.*  rerun (with|your) `, "m"));
  for (const output of [result.stderr, result.stdout]) {
    assert.ok(!output.includes(TERM), "output is redacted");
    assert.ok(!output.includes(HANDLE), "output is redacted");
    assert.ok(!/\b[a-z]\.txt\b/.test(output), "output names no staged file");
  }
};
// The hook's own stderr lines, without git's.
const hookLines = (stderr) => stderr.split("\n").filter((line) => line.startsWith("privacy-scan:"));
const PUBLIC_NOTICE = /privacy hook: public rules only; no private inventory/;
const UNSCANNED = /privacy hook: skipped the local scan of .*; CI scans this/;
// A fake key, split so this file never holds it whole.
const FAKE_KEY = "AKIA" + "ABCDEFGHIJKLMNOP";

test("public remote detection covers GitHub URL forms and fails closed", () => {
  for (const url of PUBLIC_URLS) assert.equal(isPublicRemote(url), true, url);
  for (const url of OTHER_URLS) assert.equal(isPublicRemote(url), false, url);
  assert.equal(isPublicRemote("/tmp/x.git", "/tmp/y.git /tmp/x.git"), true);
});

test("a clean push to a public remote is allowed", (t) => {
  const s = sandbox(t);
  passed(s.install());
  s.commit("a.txt", "clean\n");
  passed(s.run(["push", "-q", "public", "main"]));
  assert.ok(s.remoteHas("refs/heads/main"));
});

for (const surface of [
  "added line",
  "commit message",
  "branch name",
  "tag message",
  "nested tag",
]) {
  test(`a private term in the ${surface} blocks a public push`, (t) => {
    const s = sandbox(t);
    passed(s.install());
    s.commit(
      "a.txt",
      surface === "added line" ? `x ${TERM} y\n` : "clean\n",
      surface === "commit message" ? `Fix ${TERM.toUpperCase()}7` : "Fixture change",
    );
    let ref = "main";
    let check = "refs/heads/main";
    if (surface === "branch name") {
      ref = `main:refs/heads/topic-${TERM}`;
      check = `refs/heads/topic-${TERM}`;
    }
    if (surface === "tag message") s.git("tag", "-a", "v1", "-m", `Release ${TERM}`);
    if (surface === "nested tag") {
      s.git("tag", "-a", "inner", "-m", `Release ${TERM}`);
      s.git("tag", "-a", "v1", "-m", "Clean outer tag", "inner");
    }
    if (surface.includes("tag")) [ref, check] = ["refs/tags/v1", "refs/tags/v1"];
    blocked(s.run(["push", "-q", "public", ref]));
    assert.ok(!s.remoteHas(check));
  });
}

test("a clean annotated tag push is allowed", (t) => {
  const s = sandbox(t);
  passed(s.install());
  s.commit("a.txt", "clean\n");
  s.git("tag", "-a", "v1", "-m", "Clean release");
  passed(s.run(["push", "-q", "public", "refs/tags/v1"]));
  assert.ok(s.remoteHas("refs/tags/v1"));
});

test("a term added then removed in the same push is still blocked", (t) => {
  const s = sandbox(t);
  passed(s.install());
  s.commit("a.txt", `${TERM}\n`);
  s.commit("a.txt", "clean\n");
  blocked(s.run(["push", "-q", "public", "main"]));
});

test("a non-public remote passes even with a private term", (t) => {
  const s = sandbox(t, { inventory: false });
  passed(s.install());
  s.commit("a.txt", `${TERM}\n`, `Fix ${TERM}`);
  passed(s.run(["push", "-q", "other", "main"]));
});

test("without an inventory, a clone runs the public rules with a notice", (t) => {
  const s = sandbox(t, { inventory: false });
  passed(s.install());
  // A directory where the user inventory goes is not an inventory.
  fs.mkdirSync(path.join(s.env.HOME, ".config", "codesense", "privacy-terms.json"), {
    recursive: true,
  });
  // A private term passes: no private rules are loaded.
  s.stage("a.txt", `${TERM}\n`);
  let result = s.run(["commit", "-q", "-m", `Fix ${TERM}`]);
  passed(result);
  assert.match(result.stderr, PUBLIC_NOTICE);
  result = s.run(["push", "-q", "public", "main"]);
  passed(result);
  assert.match(result.stderr, PUBLIC_NOTICE);
  // A key still blocks, in a message and in a pushed file.
  const keyBlocked = (r) => {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /privacy-scan: token x1/);
    assert.ok(!r.stderr.includes(FAKE_KEY), "output is redacted");
  };
  s.stage("b.txt", `${FAKE_KEY}\n`);
  const keyCommit = s.run(["commit", "-q", "-m", `Add ${FAKE_KEY}`]);
  commitRefused(keyCommit, "token");
  assert.ok(!keyCommit.stderr.includes(FAKE_KEY), "output is redacted");
  s.git("commit", "-q", "--no-verify", "-m", "Add key");
  keyBlocked(s.run(["push", "-q", "public", "main"]));
  // A destination that is not public stays silent, required or not.
  for (const extra of [{ CODESENSE_PRIVACY_REQUIRED: "1" }, {}]) {
    s.git("commit", "-q", "--no-verify", "--allow-empty", "-m", "Next");
    const result = s.run(["push", "-q", "other", "main"], { env: { ...s.env, ...extra } });
    passed(result);
    assert.equal(result.stderr, "");
  }
});

test("the dispatcher blocks a required clone without an inventory before the checkout's hooks run", (t) => {
  const s = sandbox(t, { inventory: false });
  passed(s.install());
  s.commit("a.txt", "clean\n");
  // A crafted checkout whose hooks allow everything.
  fs.rmSync(path.join(s.work, "scripts"));
  fs.mkdirSync(path.join(s.work, "scripts", "git-hooks"), { recursive: true });
  for (const name of ["pre-push", "commit-msg"])
    fs.writeFileSync(path.join(s.work, "scripts", "git-hooks", name), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
  // Its own term list does not count either.
  fs.mkdirSync(path.join(s.work, "release"));
  fs.copyFileSync(s.terms, path.join(s.work, "release", "privacy-terms.json"));
  const blocksBoth = (env = s.env) => {
    for (const result of [
      s.run(["push", "-q", "public", "main"], { env }),
      s.run(["commit", "-q", "--allow-empty", "-m", "Clean"], { env }),
    ]) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /CODESENSE_PRIVACY_TERMS/);
    }
  };
  // Either switch requires it.
  blocksBoth({ ...s.env, CODESENSE_PRIVACY_REQUIRED: "1" });
  s.git("config", "codesense.privacyRequired", "true");
  blocksBoth();
  // A user inventory must be a readable file, and an empty HOME has none.
  const user = path.join(s.env.HOME, ".config", "codesense", "privacy-terms.json");
  fs.mkdirSync(user, { recursive: true });
  blocksBoth();
  blocksBoth({ ...s.env, HOME: "" });
  // With only non-public remotes, a required commit passes silently.
  s.git("remote", "remove", "public");
  const quiet = s.run(["commit", "-q", "--allow-empty", "-m", "Clean"]);
  passed(quiet);
  assert.equal(quiet.stderr, "");
  s.git("remote", "add", "public", s.bare);
  // With an inventory outside the tree, the checkout's hooks decide.
  const env = { ...s.env, CODESENSE_PRIVACY_TERMS: s.terms };
  passed(s.run(["push", "-q", "public", "main"], { env }));
  passed(s.run(["commit", "-q", "--allow-empty", "-m", "Clean"], { env }));
});

test("a clone that requires the private rules blocks without an inventory", (t) => {
  const s = sandbox(t, { inventory: false });
  passed(s.install());
  s.commit("a.txt", "clean\n");
  const both = (env) => [
    s.run(["push", "-q", "public", "main"], { env }),
    s.run(["commit", "-q", "--allow-empty", "-m", "Clean"], { env }),
  ];
  const blocksBoth = (extra = {}) => {
    for (const result of both({ ...s.env, ...extra })) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /CODESENSE_PRIVACY_TERMS/);
    }
  };
  // The env value is read as a git boolean; one git cannot read requires them.
  blocksBoth({ CODESENSE_PRIVACY_REQUIRED: "1" });
  blocksBoth({ CODESENSE_PRIVACY_REQUIRED: "maybe" });
  for (const value of ["0", "off"])
    for (const result of both({ ...s.env, CODESENSE_PRIVACY_REQUIRED: value })) {
      passed(result);
      assert.match(result.stderr, PUBLIC_NOTICE);
    }
  // So does git config, at any scope, and a value git cannot read as a boolean.
  const global = path.join(s.root, "global.gitconfig");
  fs.writeFileSync(global, "[codesense]\n\tprivacyRequired = true\n");
  blocksBoth({ GIT_CONFIG_GLOBAL: global });
  s.git("config", "codesense.privacyRequired", "maybe");
  blocksBoth();
  s.git("config", "codesense.privacyRequired", "true");
  blocksBoth();
  // A file in the tree never satisfies them.
  fs.mkdirSync(path.join(s.work, "release"));
  fs.copyFileSync(s.terms, path.join(s.work, "release", "privacy-terms.json"));
  blocksBoth();
  // The user inventory does: the private rules run as usual.
  fs.mkdirSync(path.join(s.env.HOME, ".config", "codesense"), { recursive: true });
  fs.copyFileSync(s.terms, path.join(s.env.HOME, ".config", "codesense", "privacy-terms.json"));
  s.stage("b.txt", "two\n");
  commitRefused(s.run(["commit", "-q", "-m", `Fix ${TERM}`]), "fixture-5");
  for (const result of both(s.env)) {
    passed(result);
    assert.doesNotMatch(result.stderr, PUBLIC_NOTICE);
  }
});

test("user and repo inventories are found", (t) => {
  const s = sandbox(t, { inventory: false });
  passed(s.install());
  s.commit("a.txt", "clean\n");
  // The repo's own inventory is the last fallback.
  fs.mkdirSync(path.join(s.work, "release"));
  fs.copyFileSync(s.terms, path.join(s.work, "release", "privacy-terms.json"));
  s.commit("b.txt", `${TERM}\n`);
  blocked(s.run(["push", "-q", "public", "main"]));
  // The user-level inventory comes before it.
  fs.writeFileSync(path.join(s.work, "release", "privacy-terms.json"), "{}");
  fs.mkdirSync(path.join(s.env.HOME, ".config", "codesense"), { recursive: true });
  fs.copyFileSync(s.terms, path.join(s.env.HOME, ".config", "codesense", "privacy-terms.json"));
  blocked(s.run(["push", "-q", "public", "main"]));
  s.git("reset", "-q", "--hard", "HEAD~1");
  const result = s.run(["push", "-q", "public", "main"]);
  passed(result);
  assert.doesNotMatch(result.stderr, PUBLIC_NOTICE);
});

test("an invalid inventory blocks", (t) => {
  const s = sandbox(t);
  fs.writeFileSync(s.terms, "{}");
  passed(s.install());
  s.commit("a.txt", "clean\n");
  const result = s.run(["push", "-q", "public", "main"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid or unavailable private rule inventory/);
});

test("a push scans only commits the destination does not have", (t) => {
  const s = sandbox(t);
  passed(s.install());
  // History already on the destination (seeded without hooks) is not rescanned.
  s.commit("a.txt", `${TERM}\n`);
  s.seed("public", "main");
  s.git("switch", "-q", "-c", "topic");
  s.commit("b.txt", "clean\n");
  passed(s.run(["push", "-q", "public", "topic"]));
  // Pushing by URL, with no remote-tracking refs, does the same.
  s.commit("c.txt", "clean\n");
  passed(s.run(["push", "-q", s.bare, "topic"]));
  // An unpublished commit on a new branch is scanned.
  s.git("switch", "-q", "-c", "second");
  s.commit("d.txt", `${TERM}\n`);
  s.commit("e.txt", "clean\n");
  blocked(s.run(["push", "-q", "public", "second"]));
  // An update scans remote..local only.
  s.git("switch", "-q", "topic");
  s.commit("f.txt", "still clean\n");
  passed(s.run(["push", "-q", "public", "topic"]));
});

for (const repoint of ["set-url", "pushurl"]) {
  test(`remote-tracking refs from another URL are not trusted (${repoint})`, (t) => {
    const s = sandbox(t);
    passed(s.install());
    // A private history is on the private remote and its tracking refs.
    s.commit("a.txt", `${TERM}\n`);
    s.seed("other", "main");
    s.git("fetch", "-q", "other");
    assert.ok(s.git("rev-parse", "refs/remotes/other/main"));
    // The same remote name now pushes to the public destination.
    s.git("remote", "set-url", ...(repoint === "pushurl" ? ["--push"] : []), "other", s.bare);
    s.git("switch", "-q", "-c", "topic");
    s.commit("b.txt", "clean\n");
    blocked(s.run(["push", "-q", "other", "topic"]));
    assert.ok(!s.remoteHas("refs/heads/topic"));
  });
}

// A fast-import stream of `count` commits on main, starting from `base`; `salt`
// keeps two streams from the same base apart.
function commitStream(base, count, salt = "") {
  let stream = "";
  for (let i = 1; i <= count; i++) {
    const data = `${salt}${i}\n`;
    stream +=
      `commit refs/heads/main\ncommitter Fixture <fixture@example.com> ${1700000000 + i} +0000\n` +
      `data 2\nc\n${i === 1 ? `from ${base}\n` : ""}M 644 inline n.txt\ndata ${data.length}\n${data}\n`;
  }
  return stream;
}

// Adds `count` commits on top of HEAD (on main) in one fast-import run.
function addCommits(s, count) {
  const stream = commitStream(s.git("rev-parse", "HEAD").trim(), count);
  const result = s.run(["fast-import", "--quiet", "--force"], { input: stream });
  assert.equal(result.status, 0, result.stderr);
  s.git("reset", "-q", "--hard", "main");
}

test("a push with too many new commits is refused at once, with counts only", (t) => {
  const s = sandbox(t);
  passed(s.install());
  s.commit("a.txt", "clean\n");
  addCommits(s, 5000);
  const started = Date.now();
  const result = s.run(["push", "-q", "public", "main"]);
  // The missing progress line proves nothing was scanned; the time bound is loose.
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /this push carries more than 200 commits or tags the public repo does not have/,
  );
  assert.doesNotMatch(hookLines(result.stderr).join("\n"), /[0-9a-f]{40}|scanned/);
  assert.ok(!s.remoteHas("main"));
  // The limit can be raised or lowered; an invalid one blocks.
  const limit = (value) => ({ ...s.env, CODESENSE_PRIVACY_MAX_NEW_COMMITS: value });
  for (const value of ["-1", "many", "1e9", "2147483647", "99999999999999999999"]) {
    const invalid = s.run(["push", "-q", "public", "main"], { env: limit(value) });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /invalid CODESENSE_PRIVACY_MAX_NEW_COMMITS/);
  }
  s.git("reset", "-q", "--hard", "HEAD~4997");
  assert.notEqual(s.run(["push", "-q", "public", "main"], { env: limit("3") }).status, 0);
  passed(s.run(["push", "-q", "public", "main"], { env: limit("4") }));
  // Tag objects new to the destination count too.
  s.git("tag", "-a", "-m", "Release", "v1");
  const tag = (value) => s.run(["push", "-q", "public", "v1"], { env: limit(value) });
  assert.match(tag("0").stderr, /carries more than 0 commits or tags/);
  passed(tag("1"));
});

test("a clone behind the destination fetches the tips it lacks, then counts", (t) => {
  const s = sandbox(t);
  passed(s.install());
  s.commit("a.txt", "clean\n");
  addCommits(s, 30);
  const held = s.git("rev-parse", "HEAD").trim();
  s.seed("public", "main");
  // The destination moves on by more than the limit, with commits this clone lacks.
  const ahead = s.run(["--git-dir", s.bare, "fast-import", "--quiet"], {
    input: commitStream(held, 25, "remote"),
  });
  assert.equal(ahead.status, 0, ahead.stderr);
  const env = { ...s.env, CODESENSE_PRIVACY_MAX_NEW_COMMITS: "20" };
  const push = (ref) => s.run(["push", "-q", "public", `HEAD:refs/heads/${ref}`], { env });
  // Without a fetch first, the small push counts as one and is scanned; the large one is refused.
  s.git("checkout", "-q", "-b", "small", held);
  s.commit("b.txt", "clean\n");
  passed(push("small"));
  s.git("checkout", "-q", "-b", "large", held);
  addCommits(s, 25);
  assert.match(push("large").stderr, /this push carries more than 20 commits or tags/);
  // The fetch wrote no ref: no local ref reaches the destination's new main.
  const remoteMain = s.run(["--git-dir", s.bare, "rev-parse", "main"]).stdout.trim();
  assert.equal(s.git("for-each-ref", "--contains", remoteMain), "");
  assert.ok(!fs.existsSync(path.join(s.work, ".git", "FETCH_HEAD")));
});

test("a tip the destination lists but cannot send fails closed", (t) => {
  const s = sandbox(t);
  passed(s.install());
  s.commit("a.txt", "clean\n");
  s.seed("public", "main");
  fs.writeFileSync(path.join(s.bare, "refs", "heads", "ghost"), `${"1234567890".repeat(4)}\n`);
  s.git("switch", "-q", "-c", "topic");
  s.commit("b.txt", "clean\n");
  const result = s.run(["push", "-q", "public", "topic"]);
  assert.notEqual(result.status, 0);
  assert.deepEqual(hookLines(result.stderr), [
    "privacy-scan: cannot fetch the commits the destination already has; fetch and retry.",
  ]);
  assert.ok(!s.remoteHas("refs/heads/topic"));
});

// Main on the destination moves past this clone's last fetch. Its history holds
// a commit the hook would block, already published (seeded without hooks).
function staleMain(t) {
  const s = sandbox(t);
  passed(s.install());
  s.commit("a.txt", "clean\n");
  // An address outside the allowed set, built so this file holds none.
  s.commit(
    "old.txt",
    "clean\n",
    `Old change\n\nCo-authored-by: Pat <${["pat", "mail.org"].join("@")}>`,
  );
  s.commit("term.txt", `${TERM}\n`);
  s.seed("public", "main");
  s.git("fetch", "-q", "public");
  const fetched = s.git("rev-parse", "HEAD").trim();
  const ahead = s.run(["--git-dir", s.bare, "fast-import", "--quiet"], {
    input: commitStream(fetched, 3, "remote"),
  });
  assert.equal(ahead.status, 0, ahead.stderr);
  return { s, fetched };
}

test("a branch that merges main is scanned for its new commits only", (t) => {
  const { s } = staleMain(t);
  s.git("switch", "-q", "-c", "topic", "HEAD~2");
  s.commit("b.txt", "clean\n");
  s.seed("public", "topic");
  // The merge brings in the published history up to this clone's last fetch.
  s.git("merge", "-q", "--no-edit", "--no-verify", "refs/remotes/public/main");
  passed(s.run(["push", "-q", "public", "topic"]));
  // A new commit that the hook blocks still fails.
  s.commit("c.txt", `${TERM}\n`);
  blocked(s.run(["push", "-q", "public", "topic"]));
  s.git("reset", "-q", "--hard", "HEAD~1");
  s.commit(
    "d.txt",
    "clean\n",
    `New change\n\nCo-authored-by: Pat <${["pat", "mail.org"].join("@")}>`,
  );
  refused(s.run(["push", "-q", "public", "topic"]), "email");
});

test("a first push of a new branch scans only commits the destination lacks", (t) => {
  const { s, fetched } = staleMain(t);
  s.git("switch", "-q", "-c", "fresh", fetched);
  s.commit("e.txt", "clean\n");
  passed(s.run(["push", "-q", "public", "fresh"]));
  s.git("switch", "-q", "-c", "fresh-bad", fetched);
  s.commit("f.txt", `${TERM}\n`);
  blocked(s.run(["push", "-q", "public", "fresh-bad"]));
});

test("a long push scan prints progress, counts only", (t) => {
  const s = sandbox(t);
  passed(s.install());
  s.commit("a.txt", "clean\n");
  addCommits(s, 100);
  const result = s.run(["push", "-q", "public", "main"]);
  passed(result);
  assert.deepEqual(result.stderr.trim().split("\n"), ["privacy-scan: scanned 100/101 commits"]);
});

test("commit-msg blocks with a reason when the remotes cannot be listed", (t) => {
  const s = sandbox(t);
  const message = path.join(s.root, "message.txt");
  fs.writeFileSync(message, "Clean\n");
  const result = spawnSync("node", [CLI, "--hook", "commit-msg", message], {
    cwd: s.root,
    encoding: "utf8",
    env: { ...s.env, GIT_CEILING_DIRECTORIES: s.root },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /privacy-scan: cannot list remotes/);
});

test("an unreachable destination fails closed", (t) => {
  const s = sandbox(t);
  const head = s.commit("a.txt", "clean\n");
  const missing = path.join(s.root, "missing.git");
  const result = spawnSync("node", [CLI, "--hook", "pre-push", "public", missing], {
    cwd: s.work,
    encoding: "utf8",
    env: { ...s.env, CODESENSE_PRIVACY_PUBLIC_REMOTES: missing },
    input: `refs/heads/main ${head} refs/heads/main ${"0".repeat(40)}\n`,
  });
  assert.notEqual(result.status, 0);
});

test("listing the destination never prompts and times out closed", (t) => {
  const s = sandbox(t);
  const head = s.commit("a.txt", "clean\n");
  // An SSH transport that records the prompt settings, then hangs.
  const seen = path.join(s.root, "ssh-env");
  const saved = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = `sh -c 'echo "$GIT_TERMINAL_PROMPT $GCM_INTERACTIVE" >"${seen}"; sleep 5'`;
  t.after(() =>
    saved === undefined
      ? delete process.env.GIT_SSH_COMMAND
      : (process.env.GIT_SSH_COMMAND = saved),
  );
  const started = Date.now();
  assert.throws(() =>
    scanPush({
      cwd: s.work,
      url: "ssh://git@hang.invalid/project.git",
      updates: `refs/heads/main ${head} refs/heads/main ${"0".repeat(40)}\n`,
      privateRulesFile: s.terms,
      remoteTimeoutMs: 1000,
    }),
  );
  assert.ok(Date.now() - started < 4000);
  assert.equal(fs.readFileSync(seen, "utf8").trim(), "0 never");
});

test("a deletion push is allowed", (t) => {
  const s = sandbox(t);
  passed(s.install());
  s.commit("a.txt", "clean\n");
  s.seed("public", `main:refs/heads/topic-${TERM}`);
  passed(s.run(["push", "-q", "public", "--delete", `topic-${TERM}`]));
  assert.ok(!s.remoteHas(`refs/heads/topic-${TERM}`));
});

test("commit-msg blocks a private term only when a remote is public", (t) => {
  const s = sandbox(t);
  passed(s.install());
  s.stage("a.txt", "one\n");
  commitRefused(s.run(["commit", "-q", "-m", `Fix ${TERM}`]), "fixture-5");
  // Every message line counts: comments, and text below a scissors line, which
  // the hook cannot tell from git's own -v diff.
  const file = path.join(s.root, "message.txt");
  fs.writeFileSync(file, `Clean subject\n# ${TERM}\n`);
  commitRefused(s.run(["commit", "-q", "--cleanup=strip", "-F", file]), "fixture-5");
  fs.writeFileSync(
    file,
    `Clean subject\n# ------------------------ >8 ------------------------\n+${TERM}\n`,
  );
  commitRefused(s.run(["commit", "-q", "--cleanup=strip", "-F", file]), "fixture-5");
  s.git("config", "commit.cleanup", "scissors");
  commitRefused(s.run(["commit", "-q", "-F", file]), "fixture-5");
  s.git("config", "--unset", "commit.cleanup");
  // Without the extra-URL env, the shell prefilter and node still find a public URL.
  const env = { ...s.env, CODESENSE_PRIVACY_PUBLIC_REMOTES: "" };
  s.git("remote", "remove", "public");
  s.git("remote", "set-url", "other", "https://github.com/codesensehq/project.git");
  s.stage("a.txt", "two\n");
  commitRefused(s.run(["commit", "-q", "-m", `Fix ${TERM}`], { env }), "fixture-5");
  // No public remote: no scan.
  s.git("remote", "set-url", "other", "https://example.com/project.git");
  passed(s.run(["commit", "-q", "-m", `Fix ${TERM}`], { env }));
});

test("commit-msg scans comment lines whatever the comment character or cleanup", (t) => {
  const s = sandbox(t);
  passed(s.install());
  const file = path.join(s.root, "message.txt");
  s.stage("a.txt", "one\n");
  // Config that strips ; lines, overridden on the command line: the hook sees
  // only the config, so it scans every line either way.
  s.git("config", "commit.cleanup", "strip");
  s.git("config", "core.commentChar", ";");
  for (const cleanup of [[], ["--cleanup=verbatim"], ["--cleanup=strip"]])
    for (const char of [";", "#"]) {
      fs.writeFileSync(file, `Clean subject\n${char} ${TERM}\n`);
      commitRefused(s.run(["commit", "-q", ...cleanup, "-F", file]), "fixture-5");
    }
  s.git("config", "commit.cleanup", "whitespace");
  fs.writeFileSync(file, `Clean subject\n; ${TERM}\n`);
  commitRefused(s.run(["commit", "-q", "-F", file]), "fixture-5");
  // core.commentChar auto: whichever character a line starts with, it is scanned.
  s.git("config", "core.commentChar", "auto");
  s.git("config", "commit.cleanup", "strip");
  for (const char of "#;@!$%^&|:")
    commitRefused(s.run(["commit", "-q", "-m", `${char}12 ${TERM}`]), "fixture-5");
});

test("a -v diff is scanned, with its own fix; --no-verbose leaves it out", (t) => {
  const s = sandbox(t);
  s.commit("a.txt", `keep\n${TERM}\n`);
  passed(s.install());
  s.stage("a.txt", "keep\n");
  const verbose = s.run(["commit", "-q", "-v"], {
    env: { ...s.env, ...editor(s, "Clean subject") },
  });
  commitRefused(verbose, "fixture-5");
  const [line] = hookLines(verbose.stderr);
  const [, at] = /^privacy-scan: fixture-5  message:(\d+)  (.*)$/.exec(line);
  assert.ok(Number(at) > 3, line);
  assert.ok(line.endsWith(`  ${LOCATION_FIX.verbose}`), line);
  passed(
    s.run(["commit", "-q", "--no-verbose"], { env: { ...s.env, ...editor(s, "Clean subject") } }),
  );
});

test("a refused message names no command, and rerunning the same one keeps -a or --amend", (t) => {
  const s = sandbox(t);
  passed(s.install());
  s.commit("a.txt", "one\n");
  const count = () => s.git("rev-list", "--count", "HEAD").trim();
  const noCommand = (result) => {
    commitRefused(result, "fixture-5");
    assert.ok(!result.stderr.includes("-F"), result.stderr);
    assert.ok(!result.stderr.includes("GIT_EDITOR="), result.stderr);
    assert.ok(hookLines(result.stderr).some((l) => l.endsWith(LOCATION_FIX.message)));
  };
  fs.writeFileSync(path.join(s.work, "a.txt"), "two\n");
  noCommand(s.run(["commit", "-q", "-a", "-m", `Subject ${TERM}`]));
  assert.equal(count(), "1");
  passed(s.run(["commit", "-q", "-a", "-m", "Subject clean"]));
  assert.equal(s.git("show", "HEAD:a.txt"), "two\n");
  assert.equal(count(), "2");
  noCommand(s.run(["commit", "-q", "--amend", "-m", `Subject ${TERM}`]));
  passed(s.run(["commit", "-q", "--amend", "-m", "Amended clean"]));
  assert.equal(count(), "2");
  assert.equal(s.git("log", "-1", "--format=%s").trim(), "Amended clean");
});

test("the installer is idempotent and chains a git-ai style hook under its own name", (t) => {
  const s = sandbox(t);
  // As git-ai sets it up: an absolute local core.hooksPath and a hook that is a
  // relative symlink to a program that dispatches on its own name.
  const hooks = path.join(s.root, "managed-hooks");
  fs.mkdirSync(hooks);
  s.git("config", "core.hooksPath", hooks);
  const log = path.join(s.root, "chained.log");
  const program = path.join(s.root, "dispatcher");
  fs.writeFileSync(
    program,
    `#!/bin/sh\n{ basename "$0"; cat; } >>'${log}'\n[ ! -e '${log}.fail' ]\n`,
  );
  fs.chmodSync(program, 0o755);
  fs.symlinkSync(path.join("..", "dispatcher"), path.join(hooks, "pre-push"));
  fs.symlinkSync(path.join("..", "dispatcher"), path.join(hooks, "commit-msg"));

  const first = s.install();
  passed(first);
  assert.match(first.stderr, /moved the existing pre-push hook/);
  assert.match(first.stderr, /moved the existing commit-msg hook/);
  const hook = fs.readFileSync(path.join(hooks, "pre-push"), "utf8");
  assert.equal(fs.realpathSync(path.join(hooks, "chained", "pre-push")), fs.realpathSync(program));
  const again = s.install();
  passed(again);
  assert.doesNotMatch(again.stderr, /moved/);
  assert.equal(fs.readFileSync(path.join(hooks, "pre-push"), "utf8"), hook);
  assert.deepEqual(fs.readdirSync(path.join(hooks, "chained")).sort(), ["commit-msg", "pre-push"]);
  assert.ok(!fs.existsSync(path.join(s.work, ".git", "hooks", "pre-push")));

  const head = s.commit("a.txt", "clean\n");
  passed(s.run(["push", "-q", "public", "main"]));
  const [name, line] = fs.readFileSync(log, "utf8").split("\n");
  assert.equal(name, "pre-push");
  assert.match(line, new RegExp(`^refs/heads/main ${head} refs/heads/main 0+$`));
  s.stage("b.txt", "clean\n");
  passed(s.run(["commit", "-q", "-m", "Clean"]));
  assert.match(fs.readFileSync(log, "utf8"), /^commit-msg$/m);

  // A failing chained hook still blocks; a term is still blocked after it passes.
  fs.writeFileSync(`${log}.fail`, "");
  s.stage("c.txt", "clean\n");
  assert.notEqual(s.run(["commit", "-q", "-m", "Clean"]).status, 0);
  s.commit("c.txt", "clean\n");
  assert.notEqual(s.run(["push", "-q", "public", "main"]).status, 0);
  fs.rmSync(`${log}.fail`);
  s.commit("d.txt", `${TERM}\n`);
  blocked(s.run(["push", "-q", "public", "main"]));

  // A new foreign hook when one is already chained is never clobbered.
  fs.rmSync(path.join(hooks, "pre-push"));
  fs.writeFileSync(path.join(hooks, "pre-push"), "#!/bin/sh\nexit 0\n");
  const conflict = s.install();
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /merge them by hand/);
  assert.equal(fs.readFileSync(path.join(hooks, "pre-push"), "utf8"), "#!/bin/sh\nexit 0\n");
});

test("the installer warns when a chained hook is not executable", (t) => {
  const s = sandbox(t);
  fs.mkdirSync(s.hooks, { recursive: true });
  fs.writeFileSync(path.join(s.hooks, "pre-push"), "#!/bin/sh\nexit 1\n", { mode: 0o644 });
  const result = s.install();
  passed(result);
  assert.match(result.stderr, /is not executable/);
});

test("the installer never touches a global or system hooks path", (t) => {
  const s = sandbox(t);
  const shared = path.join(s.root, "global-hooks");
  const config = path.join(s.root, "global-config");
  fs.writeFileSync(config, `[core]\n\thooksPath = ${shared}\n`);
  const result = s.install({ GIT_CONFIG_GLOBAL: config });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NOT installed/);
  assert.ok(!fs.existsSync(shared));
});

test("the installer refuses to run concurrently", (t) => {
  const s = sandbox(t);
  fs.mkdirSync(path.join(s.hooks, ".privacy-hooks-install.lock"), { recursive: true });
  const result = s.install();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /another install is running/);
  assert.ok(!fs.existsSync(path.join(s.hooks, "pre-push")));
});

test("without node or the checkout's hooks, a public commit or push gets a notice unless required", (t) => {
  const s = sandbox(t);
  passed(s.install());
  const head = s.commit("a.txt", "clean\n");
  // A PATH with git and the system tools, but no node.
  const bin = path.join(s.root, "bin");
  fs.mkdirSync(bin);
  const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.symlinkSync(gitPath, path.join(bin, "git"));
  const noNode = { ...s.env, PATH: `${bin}:/usr/bin:/bin`, CODESENSE_PRIVACY_PUBLIC_REMOTES: "" };
  assert.notEqual(spawnSync("sh", ["-c", "command -v node"], { env: noNode }).status, 0);
  const message = path.join(s.root, "message.txt");
  fs.writeFileSync(message, "Clean\n");
  const global = path.join(s.root, "global.gitconfig");
  fs.writeFileSync(global, "[codesense]\n\tprivacyRequired = true\n");
  // The installed dispatcher, or the checkout's own hooks chained by hand.
  const dispatcher = s.hooks;
  const chained = path.join(SCRIPTS, "git-hooks");
  const runHook = (dir, name, args, env, input) =>
    spawnSync("sh", [path.join(dir, name), ...args], { cwd: s.work, encoding: "utf8", env, input });
  const push = (dir, url) => (env) =>
    runHook(
      dir,
      "pre-push",
      ["public", url],
      env,
      `refs/heads/main ${head} refs/heads/main ${"0".repeat(40)}\n`,
    );
  const commitMsg = (dir) => (env) => runHook(dir, "commit-msg", [message], env);
  // A public destination is allowed with a notice (CI scans it), and blocked when the
  // clone requires the private rules (env, local or global config). Any other
  // destination passes silently, required or not.
  // `sources` adds the other ways to require them: global and local config.
  const check = (run, isPublic, env, sources = false) => {
    const result = run(env);
    passed(result);
    if (isPublic) assert.match(result.stderr, UNSCANNED);
    else assert.equal(result.stderr, "");
    const strict = (e) => {
      const r = run(e);
      assert.equal(r.status !== 0, isPublic, r.stderr);
    };
    strict({ ...env, CODESENSE_PRIVACY_REQUIRED: "1" });
    if (!sources) return;
    strict({ ...env, GIT_CONFIG_GLOBAL: global });
    s.git("config", "codesense.privacyRequired", "true");
    strict(env);
    s.git("config", "--unset", "codesense.privacyRequired");
  };
  for (const url of [...PUBLIC_URLS, ...OTHER_URLS])
    check(push(dispatcher, url), isPublicRemote(url), noNode);
  // Extra public URLs count too.
  check(push(dispatcher, "/tmp/x.git"), true, {
    ...noNode,
    CODESENSE_PRIVACY_PUBLIC_REMOTES: "/tmp/x.git",
  });
  for (const dir of [dispatcher, chained]) {
    // The switches are read as git booleans here too.
    const run = push(dir, PUBLIC_URLS[0]);
    assert.notEqual(run({ ...noNode, CODESENSE_PRIVACY_REQUIRED: "maybe" }).status, 0);
    passed(run({ ...noNode, CODESENSE_PRIVACY_REQUIRED: "off" }));
    s.git("config", "codesense.privacyRequired", "maybe");
    assert.notEqual(run(noNode).status, 0);
    s.git("config", "--unset", "codesense.privacyRequired");
    check(push(dir, PUBLIC_URLS[0]), true, noNode, true);
    check(push(dir, OTHER_URLS[0]), false, noNode, true);
    // commit-msg looks at every remote.
    s.git("remote", "set-url", "public", s.bare);
    check(commitMsg(dir), false, noNode, true);
    s.git("remote", "set-url", "public", "https://github.com/codesensehq/project.git");
    check(commitMsg(dir), true, noNode, true);
  }
  // A checkout without the hook scripts falls back the same way, with node too.
  fs.rmSync(path.join(s.work, "scripts"));
  const withNode = { ...s.env, CODESENSE_PRIVACY_PUBLIC_REMOTES: "" };
  check(push(dispatcher, "git@github.com:example/project.git"), false, withNode);
  check(push(dispatcher, "git@github.com:CodeSenseHQ/project.git"), true, withNode);
  check(commitMsg(dispatcher), true, withNode);
});

test("the maintainer's exact sign-off passes, with the identity as author and committer", (t) => {
  for (const inventory of [true, false]) {
    const s = sandbox(t, { inventory, handle: true });
    passed(s.install());
    s.git("config", "user.name", HANDLE);
    s.git("config", "user.email", NOREPLY);
    s.stage("a.txt", "clean\n");
    passed(s.run(["commit", "-q", "-s", "-m", "Clean subject"]));
    assert.equal(
      s.git(
        "show",
        "--no-patch",
        "--format=%an <%ae>%n%cn <%ce>%n%(trailers:key=Signed-off-by,valueonly)",
        "HEAD",
      ),
      `${HANDLE} <${NOREPLY}>\n`.repeat(3) + "\n",
    );
    passed(s.run(["push", "-q", "public", "main"]));
  }
});

test("the maintainer's handle anywhere else in a message blocks", (t) => {
  const s = sandbox(t, { handle: true });
  passed(s.install());
  const file = path.join(s.root, "message.txt");
  for (const message of [
    `Fix ${HANDLE}\n\n${SIGNOFF}\n`,
    `Clean subject\n\nSee ${HANDLE}\n\n${SIGNOFF}\n`,
    `Clean subject\n\nSigned-off-by: x <x+${HANDLE}@example.com>\n`,
    `Clean subject\n\nSigned-off-by: ${HANDLE} <${HANDLE}@example.com>\n`,
    `Clean subject\n\nSigned-off-by: ${HANDLE} <${NOREPLY}.evil>\n`,
    `Clean subject\n\nSigned-off-by: ${HANDLE} <x${NOREPLY}>\n`,
    `Clean subject\n\nCo-authored-by: ${HANDLE} <${NOREPLY}>\n`,
    `Clean subject\n\n${SIGNOFF} and more\n`,
    `Clean subject\n\n ${SIGNOFF}\n`,
  ]) {
    s.stage("a.txt", `${message.length}\n`);
    fs.writeFileSync(file, message);
    commitRefused(s.run(["commit", "-q", "--cleanup=verbatim", "-F", file]), "fixture-5");
  }
});

test("the maintainer's handle in an added line blocks a push despite a valid sign-off", (t) => {
  const s = sandbox(t, { handle: true });
  passed(s.install());
  s.commit("a.txt", `see ${HANDLE}\n`, `Clean subject\n\n${SIGNOFF}`);
  refused(s.run(["push", "-q", "public", "main"]), "fixture-5");
});

test("the public rules allow only the exact maintainer address in a sign-off", (t) => {
  const s = sandbox(t, { inventory: false });
  passed(s.install());
  s.stage("a.txt", "one\n");
  passed(s.run(["commit", "-q", "-m", `Clean subject\n\n${SIGNOFF}`]));
  for (const [i, address] of [
    `${NOREPLY}.evil`,
    `1+${HANDLE}@users.noreply.github.com`,
    `${HANDLE}@users.noreply.github.com`,
  ].entries()) {
    s.stage("a.txt", `${i}\n`);
    commitRefused(
      s.run(["commit", "-q", "-m", `Clean subject\n\nSigned-off-by: ${HANDLE} <${address}>`]),
      "email",
    );
  }
});

test("a clone that requires signed commits refuses unsigned or AI co-authored ones", (t) => {
  const s = sandbox(t);
  passed(s.install());
  const trailer = "Co-authored-by: Claude <noreply@anthropic.com>";
  // Without the switch, neither is checked: contributors may sign or credit as they like.
  s.commit("a.txt", "one\n", `Clean subject\n\n${trailer}`);
  passed(s.run(["push", "-q", "public", "main"]));
  s.git("config", "codesense.requireSigned", "true");
  s.commit("a.txt", "two\n");
  refused(s.run(["push", "-q", "public", "main"]), "unsigned-commit");
  const key = path.join(s.root, "signing-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  s.git("config", "gpg.format", "ssh");
  s.git("config", "user.signingkey", `${key}.pub`);
  s.git("commit", "-q", "--amend", "--no-verify", "-S", "--no-edit");
  passed(s.run(["push", "-q", "public", "main"]));
  s.stage("a.txt", "three\n");
  s.git("commit", "-q", "--no-verify", "-S", "-m", `Clean subject\n\n${trailer}`);
  const result = s.run(["push", "-q", "public", "main"]);
  refused(result, "ai-co-author");
  assert.doesNotMatch(result.stderr, /unsigned-commit/);
  // Any Anthropic address counts; a signature header split by \r is no header.
  for (const line of [
    "Co-authored-by: A <x" + "@anthropic.com>",
    "co-authored-BY : A <x" + "@mail.anthropic.com>",
  ]) {
    s.git("commit", "-q", "--amend", "--no-verify", "-S", "-m", `Clean subject\n\n${line}`);
    refused(s.run(["push", "-q", "public", "main"]), "ai-co-author");
  }
  s.git("commit", "-q", "--amend", "--no-verify", "-S", "-m", "Clean subject");
  passed(s.run(["push", "-q", "public", "main"]));
  // A signature header only counts at the start of a \n-delimited line.
  const raw = s.git("cat-file", "commit", "HEAD^^");
  const forged = raw.replace(/^(committer .*)$/m, "$1\nx-note y\rgpgsig z");
  const made = s.run(["hash-object", "--literally", "-t", "commit", "-w", "--stdin"], {
    input: forged,
  });
  passed(made);
  s.git("update-ref", "refs/heads/forged", made.stdout.trim());
  const shown = s.run(["push", "-q", "public", "forged"], {
    env: { ...s.env, CODESENSE_PRIVACY_SHOW: "1" },
  });
  assert.notEqual(shown.status, 0);
  // The finding names the commit by its short SHA.
  assert.match(
    shown.stdout,
    new RegExp(`ERROR unsigned-commit commit ${made.stdout.slice(0, 12)}`),
  );
  // An unparseable switch fails closed.
  s.git("config", "codesense.requireSigned", "maybe");
  s.commit("a.txt", "four\n");
  refused(s.run(["push", "-q", "public", "main"]), "unsigned-commit");
});

test("the maintainer's sign-off is masked only as a whole line in the trailer block", (t) => {
  const s = sandbox(t, { handle: true });
  passed(s.install());
  const file = path.join(s.root, "message.txt");
  const commit = (message, cleanup = "verbatim") => {
    s.stage("a.txt", `${message.length}\n`);
    fs.writeFileSync(file, message);
    return s.run(["commit", "-q", `--cleanup=${cleanup}`, "-F", file]);
  };
  // A typed message with a comment block after the sign-off and no editor: the
  // hook reads the file as is, so the block ends the trailer block under every
  // cleanup mode, and the sign-off is scanned.
  const commented = `Clean subject\n\n${SIGNOFF}\n\n# Please enter the commit message.\n# Lines starting with '#' are ignored.\n`;
  for (const mode of [null, "default", "strip", "verbatim", "whitespace", "scissors"]) {
    if (mode) s.git("config", "commit.cleanup", mode);
    s.stage("a.txt", `${mode}\n`);
    fs.writeFileSync(file, commented);
    commitRefused(s.run(["commit", "-q", "-F", file]), "fixture-5");
    if (mode) s.git("config", "--unset", "commit.cleanup");
  }
  // A comment block that names the handle is still scanned.
  s.stage("a.txt", "comment\n");
  fs.writeFileSync(file, `Clean subject\n\n${SIGNOFF}\n\n# ${HANDLE}\n`);
  commitRefused(s.run(["commit", "-q", "-F", file]), "fixture-5");
  for (const message of [
    `${SIGNOFF}\n\nBody\n`,
    `Clean subject\n\n${SIGNOFF}\n\nA later paragraph\n`,
    `Clean subject\n\n${SIGNOFF}\r\n`,
    `Clean subject\n\n${SIGNOFF}\u2028x\n`,
    `Clean subject\n\nx\u2029${SIGNOFF}\n`,
  ])
    commitRefused(commit(message), "fixture-5");
});

test("the maintainer's annotated or signed tag passes; a tag naming the handle elsewhere blocks", (t) => {
  const s = sandbox(t, { handle: true });
  passed(s.install());
  s.git("config", "user.name", HANDLE);
  s.git("config", "user.email", NOREPLY);
  const key = path.join(s.root, "signing-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  s.git("config", "gpg.format", "ssh");
  s.git("config", "user.signingkey", `${key}.pub`);
  s.commit("a.txt", "clean\n", `Clean subject\n\n${SIGNOFF}`);
  s.git("tag", "-a", "v1", "-m", `Release\n\n${SIGNOFF}`);
  s.git("tag", "-s", "v2", "-m", `Release\n\n${SIGNOFF}`);
  passed(s.run(["push", "-q", "public", "main", "refs/tags/v1", "refs/tags/v2"]));
  s.git("tag", "-s", "v3", "-m", `Release for ${HANDLE}\n\n${SIGNOFF}`);
  refused(s.run(["push", "-q", "public", "refs/tags/v3"]), "fixture-5");
  s.git("config", "user.email", `x+${HANDLE}@example.com`);
  s.git("tag", "-a", "v4", "-m", "Release");
  refused(s.run(["push", "-q", "public", "refs/tags/v4"]), "fixture-5");
});

test("without node, a clone that requires signed commits refuses a public push", (t) => {
  const s = sandbox(t);
  passed(s.install());
  const head = s.commit("a.txt", "clean\n");
  const bin = path.join(s.root, "bin");
  fs.mkdirSync(bin);
  const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.symlinkSync(gitPath, path.join(bin, "git"));
  const noNode = { ...s.env, PATH: `${bin}:/usr/bin:/bin`, CODESENSE_PRIVACY_PUBLIC_REMOTES: "" };
  const push = (dir, url) =>
    spawnSync("sh", [path.join(dir, "pre-push"), "public", url], {
      cwd: s.work,
      encoding: "utf8",
      env: noNode,
      input: `refs/heads/main ${head} refs/heads/main ${"0".repeat(40)}\n`,
    });
  for (const dir of [s.hooks, path.join(SCRIPTS, "git-hooks")]) {
    s.git("config", "codesense.requireSigned", "true");
    const result = push(dir, PUBLIC_URLS[0]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /privacy-scan: cannot check commit signatures/);
    // Read as a git boolean, so an unparseable value refuses too.
    s.git("config", "codesense.requireSigned", "maybe");
    assert.notEqual(push(dir, PUBLIC_URLS[0]).status, 0);
    passed(push(dir, OTHER_URLS[0]));
    s.git("config", "codesense.requireSigned", "false");
    const allowed = push(dir, PUBLIC_URLS[0]);
    passed(allowed);
    assert.match(allowed.stderr, UNSCANNED);
    s.git("config", "--unset", "codesense.requireSigned");
  }
});

test("a tag's signature starts at its last whole BEGIN line", () => {
  const begin = "-----BEGIN SSH SIGNATURE-----";
  const head = `object ${"0".repeat(40)}\ntype commit\ntag v1\ntagger x <x@example.com> 1 +0000\n\n`;
  const text = `${head}Release\n${begin}\nnot one\n\n${SIGNOFF}\n${begin}\nAAAA\n-----END SSH SIGNATURE-----\n`;
  assert.equal(withoutMaintainerTagIdentity(text), text.replace(`${SIGNOFF}`, ""));
  // A BEGIN line that is not a whole \n-delimited line is message text.
  const inline = `${head}Release\n\n${SIGNOFF}\n\nx\r${begin}\n`;
  assert.equal(withoutMaintainerTagIdentity(inline), inline);
});

test("pre-push asks for a reinstall when the dispatcher predates the signed-commit check", (t) => {
  const s = sandbox(t);
  passed(s.install());
  s.commit("a.txt", "clean\n");
  const hook = path.join(s.hooks, "pre-push");
  const current = fs.readFileSync(hook, "utf8");
  fs.writeFileSync(hook, current.replace(/^# codesense-privacy-hook-version: .*\n/m, ""));
  const stale = s.run(["push", "-q", "public", "main"]);
  passed(stale);
  assert.match(stale.stderr, /dispatcher is out of date; rerun scripts\/git-hooks\/install\.sh/);
  passed(s.install());
  assert.equal(fs.readFileSync(hook, "utf8"), current);
  s.commit("a.txt", "again\n");
  const fresh = s.run(["push", "-q", "public", "main"]);
  passed(fresh);
  assert.doesNotMatch(fresh.stderr, /out of date/);
});

test("commit-msg refuses a staged private term, and nothing is committed", (t) => {
  const s = sandbox(t);
  passed(s.install());
  s.commit("a.txt", "clean\n");
  const count = () => s.git("rev-list", "--count", "HEAD").trim();
  s.stage("a.txt", "clean\n");
  s.stage("b.txt", `x ${TERM} y\n`);
  const result = s.run(["commit", "-q", "-m", "Clean subject"]);
  commitRefused(result, "fixture-5");
  assert.match(result.stderr, /^privacy-scan: fixture-5  staged file 1 of 1, line 1  /m);
  assert.equal(count(), "1");
  s.stage("b.txt", "clean\n");
  passed(s.run(["commit", "-q", "-m", "Clean subject"]));
  assert.equal(count(), "2");
});

test("commit-msg scans the index the commit uses: commit -a and a pathspec", (t) => {
  const s = sandbox(t);
  passed(s.install());
  s.commit("a.txt", "clean\n");
  s.commit("b.txt", "clean\n");
  s.commit("c.txt", "clean\n");
  // commit -a stages a tracked change in a temporary index, and the place counts
  // the commit's own file list, not the real index's (empty here).
  fs.writeFileSync(path.join(s.work, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(s.work, "b.txt"), `${TERM}\n`);
  const all = s.run(["commit", "-q", "-a", "-m", "Clean subject"]);
  commitRefused(all, "fixture-5");
  assert.match(all.stderr, /^privacy-scan: fixture-5  staged file 2 of 2, line 1  /m);
  s.git("checkout", "--", "a.txt", "b.txt");
  // So does a pathspec commit.
  fs.writeFileSync(path.join(s.work, "b.txt"), `${TERM}\n`);
  commitRefused(s.run(["commit", "-q", "-m", "Clean subject", "--", "b.txt"]), "fixture-5");
  s.git("checkout", "--", "b.txt");
  // A term staged in the real index but left out of a pathspec commit is not committed.
  s.stage("a.txt", `${TERM}\n`);
  fs.writeFileSync(path.join(s.work, "c.txt"), "changed\n");
  passed(s.run(["commit", "-q", "-m", "Clean subject", "--", "c.txt"]));
  assert.equal(s.git("show", "--format=", "--name-only", "HEAD").trim(), "c.txt");
});

test("commit-msg scans a first commit against the empty tree", (t) => {
  const s = sandbox(t);
  passed(s.install());
  s.stage("a.txt", `${TERM}\n`);
  commitRefused(s.run(["commit", "-q", "-m", "Clean subject"]), "fixture-5");
  assert.notEqual(s.run(["rev-parse", "--verify", "-q", "HEAD"]).status, 0);
  s.stage("a.txt", "clean\n");
  passed(s.run(["commit", "-q", "-m", "Clean subject"]));
});

test("commit-msg scans only what an amend adds against HEAD", (t) => {
  const s = sandbox(t);
  passed(s.install());
  s.commit("a.txt", `${TERM}\n`);
  // The term is already in HEAD: rewording it adds nothing new (pre-push still scans it).
  passed(s.run(["commit", "-q", "--amend", "-m", "Clean subject"]));
  s.commit("a.txt", "clean\n");
  s.stage("b.txt", `${TERM}\n`);
  commitRefused(s.run(["commit", "-q", "--amend", "--no-edit"]), "fixture-5");
});

test("commit-msg skips the staged scan during a merge, also in a linked worktree", (t) => {
  const s = sandbox(t);
  passed(s.install());
  s.commit("a.txt", "base\n");
  // A conflicted merge resolved with a term, committed with commit-msg running.
  const conflict = (cwd, branch) => {
    const run = (args) => s.run(args, { cwd });
    const git = (...args) => {
      const result = run(args);
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    };
    const edit = (text, message) => {
      fs.writeFileSync(path.join(cwd, "a.txt"), text);
      git("commit", "-q", "--no-verify", "-am", message);
    };
    git("checkout", "-q", "-b", branch);
    edit("topic\n", "Topic change");
    git("checkout", "-q", "-");
    edit("main\n", "Main change");
    assert.notEqual(run(["merge", "-q", "--no-ff", branch]).status, 0);
    fs.writeFileSync(path.join(cwd, "a.txt"), `${TERM}\n`);
    git("add", "a.txt");
    const result = run(["commit", "-q", "--no-edit"]);
    passed(result);
    assert.match(result.stderr, /privacy hook: skipped the staged scan during a merge/);
  };
  conflict(s.work, "topic");
  // pre-push still blocks the term the merge brought in.
  blocked(s.run(["push", "-q", "public", "main"]));
  const linked = path.join(s.root, "linked");
  s.git("worktree", "add", "-q", "-b", "linked", linked);
  fs.symlinkSync(SCRIPTS, path.join(linked, "scripts"));
  conflict(linked, "linked-topic");
});

// The rule ids of a commit-time refusal, in order.
const commitRules = (stderr) =>
  hookLines(stderr)
    .filter((line) => line.includes("  "))
    .map((line) => line.slice("privacy-scan: ".length).split("  ")[0]);

// A maintainer clone: the switch, the identity and a signing key.
function maintainerClone(t) {
  const s = sandbox(t);
  passed(s.install());
  s.commit("a.txt", "base\n");
  const key = path.join(s.root, "signing-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  for (const [name, value] of [
    ["codesense.requireSigned", "true"],
    ["user.name", HANDLE],
    ["user.email", NOREPLY],
    ["gpg.format", "ssh"],
    ["user.signingkey", `${key}.pub`],
    ["commit.gpgsign", "true"],
  ])
    s.git("config", name, value);
  let n = 0;
  // A commit of a fresh clean change.
  const attempt = (args, extra = {}) => {
    s.stage("a.txt", `${n++}\n`);
    return s.run(["commit", "-q", ...args], { env: { ...s.env, ...extra } });
  };
  // commit-msg alone on a message, with nothing committed (and nothing signed).
  const message = path.join(s.root, "message.txt");
  const hook = (text, extra = {}) => {
    fs.writeFileSync(message, text);
    return spawnSync("node", [CLI, "--hook", "commit-msg", message], {
      cwd: s.work,
      encoding: "utf8",
      env: { ...s.env, ...extra },
    });
  };
  return { ...s, key, attempt, hook };
}

test("a requireSigned clone refuses each part of the maintainer form at commit time", (t) => {
  const s = maintainerClone(t);
  const signed = `Clean subject\n\n${SIGNOFF}`;
  const only = (result, rule) => {
    commitRefused(result, rule);
    assert.deepEqual(commitRules(result.stderr), [rule]);
  };
  const result = s.attempt(["-s", "-m", "Clean subject"]);
  passed(result);
  assert.equal(result.stderr, "");
  assert.match(s.git("cat-file", "commit", "HEAD"), /^gpgsig /m);
  only(s.attempt(["-m", "Clean subject"]), "missing-signoff");
  // A sign-off outside the trailer block is no sign-off (and its address is scanned).
  const body = s.attempt(["-m", `${signed}\n\nA later paragraph`]);
  commitRefused(body, "missing-signoff");
  assert.deepEqual(commitRules(body.stderr), ["email", "missing-signoff"]);
  only(s.attempt(["--author", "Someone <someone@example.com>", "-m", signed]), "author-identity");
  only(s.attempt(["-m", signed], { GIT_COMMITTER_NAME: "Someone" }), "committer-identity");
  only(
    s.attempt([
      "-m",
      `Clean subject\n\nCo-authored-by: Claude <noreply@anthropic.com>\n${SIGNOFF}`,
    ]),
    "ai-co-author",
  );
  // Case-insensitive; this address is also one the public rules refuse.
  const variant = s.attempt([
    "-m",
    `Clean subject\n\nco-authored-BY : A <x${"@mail.anthropic.com"}>\n${SIGNOFF}`,
  ]);
  commitRefused(variant, "ai-co-author");
  assert.deepEqual(commitRules(variant.stderr), ["email", "ai-co-author"]);
  s.git("config", "--unset", "commit.gpgsign");
  const unsigned = s.attempt(["-m", signed]);
  only(unsigned, "signing-config");
  // It says what it checks, and why commit.gpgsign is needed.
  assert.match(unsigned.stderr, /checks the config, not the signature/);
  assert.match(unsigned.stderr, /the hook cannot see -S/);
  s.git("config", "commit.gpgsign", "false");
  only(s.attempt(["-S", "-m", signed]), "signing-config");
  s.git("config", "commit.gpgsign", "true");
  passed(s.attempt(["-m", signed]));
});

test("a signing key can come from ssh's default key command, or from gpg by email", (t) => {
  const s = maintainerClone(t);
  const signed = `Clean subject\n\n${SIGNOFF}\n`;
  s.git("config", "--unset", "user.signingkey");
  commitRefused(s.hook(signed), "signing-config");
  assert.deepEqual(commitRules(s.hook(signed).stderr), ["signing-config"]);
  s.git("config", "gpg.ssh.defaultKeyCommand", "ssh-add -L");
  passed(s.hook(signed));
  s.git("config", "--unset", "gpg.ssh.defaultKeyCommand");
  // openpgp picks the key by the committer's email.
  s.git("config", "gpg.format", "openpgp");
  passed(s.hook(signed));
  s.git("config", "--unset", "gpg.format");
  passed(s.hook(signed));
});

test("the maintainer form is checked only under codesense.requireSigned", (t) => {
  const s = maintainerClone(t);
  s.git("config", "--unset", "codesense.requireSigned");
  s.git("config", "commit.gpgsign", "false");
  s.git("config", "user.name", "Someone");
  s.git("config", "user.email", "someone@example.com");
  const trailer = "Co-authored-by: Claude <noreply@anthropic.com>";
  // Neither switch, then only privacyRequired: no sign-off, a stranger, a trailer.
  passed(s.attempt(["-m", `Clean subject\n\n${trailer}`]));
  s.git("config", "codesense.privacyRequired", "true");
  passed(s.attempt(["-m", `Clean subject\n\n${trailer}`]));
  // An unparseable switch counts as set.
  s.git("config", "codesense.requireSigned", "maybe");
  commitRefused(s.attempt(["-m", "Clean subject"]), "missing-signoff");
});

test("run by hand without node, commit-msg warns only a requireSigned clone that its checks did not run", (t) => {
  // The installed dispatcher never runs this script without node (it calls
  // fallback.sh itself); a hook chained to it by hand does.
  const s = maintainerClone(t);
  const bin = path.join(s.root, "bin");
  fs.mkdirSync(bin);
  const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.symlinkSync(gitPath, path.join(bin, "git"));
  const noNode = { ...s.env, PATH: `${bin}:/usr/bin:/bin` };
  const message = path.join(s.root, "message.txt");
  fs.writeFileSync(message, "Clean subject\n");
  const run = () =>
    spawnSync("sh", [path.join(SCRIPTS, "git-hooks", "commit-msg"), message], {
      cwd: s.work,
      encoding: "utf8",
      env: noNode,
    });
  const warned = run();
  passed(warned);
  assert.match(warned.stderr, /the commit-time checks did not run \(no node\)/);
  assert.match(warned.stderr, UNSCANNED);
  for (const off of [["false"], null]) {
    if (off) s.git("config", "codesense.requireSigned", ...off);
    else s.git("config", "--unset", "codesense.requireSigned");
    const quiet = run();
    passed(quiet);
    assert.match(quiet.stderr, UNSCANNED);
    assert.doesNotMatch(quiet.stderr, /commit-time checks/);
  }
});

test("commit-msg names a staged file only with CODESENSE_PRIVACY_SHOW=1", (t) => {
  const s = sandbox(t);
  passed(s.install());
  s.commit("a.txt", "clean\n");
  s.stage("b.txt", `x ${TERM} y\n`);
  s.stage(`${TERM}.md`, "clean\n");
  const hidden = s.run(["commit", "-q", "-m", "Clean subject"]);
  commitRefused(hidden, "fixture-5");
  assert.deepEqual(
    hookLines(hidden.stderr)
      .filter((line) => line.includes("  "))
      .map((line) => line.split("  ")[1]),
    // `git diff --cached --name-only` order: b.txt, then the term's file.
    ["staged file 1 of 2, line 1", "a staged path"],
  );
  const shown = s.run(["commit", "-q", "-m", "Clean subject"], {
    env: { ...s.env, CODESENSE_PRIVACY_SHOW: "1" },
  });
  assert.notEqual(shown.status, 0);
  assert.match(shown.stderr, new RegExp(`^privacy-scan: fixture-5  ${TERM}\\.md `, "m"));
  assert.match(shown.stderr, new RegExp(`^privacy-scan: fixture-5  b\\.txt:1 ${TERM}  `, "m"));
});

// An editor that puts `text` above the template git wrote, as a person would.
function editor(s, text) {
  const script = path.join(s.root, "editor.sh");
  fs.writeFileSync(
    script,
    '#!/bin/sh\n{ printf "%s\\n" "$EDIT_TEXT"; cat "$1"; } > "$1.new" && mv "$1.new" "$1"\n',
  );
  fs.chmodSync(script, 0o755);
  return { GIT_EDITOR: script, EDIT_TEXT: text };
}

test("the sign-off passes in an editor commit only when the hook knows git's comment string", (t) => {
  const s = maintainerClone(t);
  passed(s.attempt(["-s"], editor(s, "Clean subject")));
  assert.match(s.git("log", "-1", "--format=%B"), /^Clean subject\n\nSigned-off-by: /);
  passed(s.attempt(["-s", "-v"], editor(s, "Clean subject")));
  // core.commentChar auto: git picks the character per message, so the hook
  // cannot skip the comment block and refuses.
  s.git("config", "core.commentChar", "auto");
  commitRefused(s.attempt(["-s"], editor(s, "Clean subject")), "missing-signoff");
  s.git("config", "--unset", "core.commentChar");
  // commit.cleanup whitespace publishes the comments, so they end the trailer block.
  s.git("config", "commit.cleanup", "whitespace");
  const published = s.attempt(["-s"], editor(s, "Clean subject"));
  commitRefused(published, "missing-signoff");
  // Outside the trailer block, the sign-off is not masked and its address is scanned.
  assert.deepEqual(commitRules(published.stderr), ["email", "missing-signoff"]);
  s.git("config", "--unset", "commit.cleanup");
  // -m: no comment block, so the sign-off is found under every cleanup mode.
  for (const mode of [null, "default", "strip", "verbatim", "whitespace", "scissors"]) {
    if (mode) s.git("config", "commit.cleanup", mode);
    passed(s.attempt(["-s", "-m", "Clean subject"]));
    if (mode) s.git("config", "--unset", "commit.cleanup");
  }
  // An AI co-author below a typed scissors line is still refused.
  const file = path.join(s.root, "typed.txt");
  fs.writeFileSync(
    file,
    "Clean subject\n# ------------------------ >8 ------------------------\nCo-authored-by: Claude <noreply@anthropic.com>\n",
  );
  const below = s.attempt(["-s", "-F", file]);
  commitRefused(below, "ai-co-author");
  assert.ok(commitRules(below.stderr).includes("ai-co-author"));
});

test("a commit that breaks three rules prints three lines", (t) => {
  const s = maintainerClone(t);
  s.git("config", "commit.gpgsign", "false");
  const result = s.attempt(["--author", "Someone <someone@example.com>", "-m", "Clean subject"]);
  commitRefused(result, "author-identity");
  assert.deepEqual(commitRules(result.stderr), [
    "author-identity",
    "missing-signoff",
    "signing-config",
  ]);
});

test("a term committed with --no-verify is still refused at pre-push", (t) => {
  const s = sandbox(t);
  passed(s.install());
  s.stage("a.txt", `${TERM}\n`);
  passed(s.run(["commit", "-q", "--no-verify", "-m", "Clean subject"]));
  blocked(s.run(["push", "-q", "public", "main"]));
  assert.ok(!s.remoteHas("refs/heads/main"));
});

test("commit-msg warns about a stale dispatcher as pre-push does, and still checks", (t) => {
  const s = sandbox(t);
  passed(s.install());
  s.commit("a.txt", "clean\n");
  const STALE =
    /privacy hook: the installed dispatcher is out of date; rerun scripts\/git-hooks\/install\.sh/;
  // A version-1 dispatcher: no version marker.
  for (const name of ["pre-push", "commit-msg"]) {
    const hook = path.join(s.hooks, name);
    const text = fs.readFileSync(hook, "utf8");
    fs.writeFileSync(hook, text.replace(/^# codesense-privacy-hook-version: .*\n/m, ""));
  }
  s.stage("b.txt", `${TERM}\n`);
  const refusedStale = s.run(["commit", "-q", "-m", "Clean subject"]);
  commitRefused(refusedStale, "fixture-5");
  assert.match(refusedStale.stderr, STALE);
  s.stage("b.txt", "clean\n");
  const cleanStale = s.run(["commit", "-q", "-m", "Clean subject"]);
  passed(cleanStale);
  assert.match(cleanStale.stderr, STALE);
  const pushed = s.run(["push", "-q", "public", "main"]);
  passed(pushed);
  assert.match(pushed.stderr, STALE);
  // A quiet reinstall is idempotent and clears the warning.
  const quiet = spawnSync("sh", [INSTALL, "--quiet"], {
    cwd: s.work,
    encoding: "utf8",
    env: s.env,
  });
  passed(quiet);
  assert.equal(quiet.stdout + quiet.stderr, "");
  const installed = snapshot(s.hooks);
  passed(spawnSync("sh", [INSTALL, "--quiet"], { cwd: s.work, encoding: "utf8", env: s.env }));
  assert.deepEqual(snapshot(s.hooks), installed);
  s.stage("b.txt", "again\n");
  const fresh = s.run(["commit", "-q", "-m", "Clean subject"]);
  passed(fresh);
  assert.doesNotMatch(fresh.stderr, /out of date/);
  // Every worktree of the clone shares the hooks, so a linked one refuses a term.
  const linked = path.join(s.root, "linked");
  s.git("worktree", "add", "-q", "-b", "linked", linked);
  fs.symlinkSync(SCRIPTS, path.join(linked, "scripts"));
  fs.writeFileSync(path.join(linked, "c.txt"), `${TERM}\n`);
  s.git("-C", linked, "add", "c.txt");
  commitRefused(s.run(["commit", "-q", "-m", "Clean subject"], { cwd: linked }), "fixture-5");
});
