// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  scanChange,
  scanStaged,
  commitFindings,
  FIX,
  LOCATION_FIX,
  fixFor,
  placeOf,
  addedLines,
  pairCommitSections,
  addedLineSelection,
} from "./privacy-ci.mjs";
import { scan, allowLines } from "./privacy-engine.mjs";
import { GENERIC_RULES } from "./privacy-rules.mjs";

const token = () => "gh" + "p_" + "aB3".repeat(12);
const bad = (findings) => findings.some((f) => f.sev === "error" && !f.allowed);

function fixture(t, initial = "clean\n") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-ci-test-"));
  const inputs = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-ci-input-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(inputs, { recursive: true, force: true });
  });
  const git = (...args) =>
    execFileSync("git", ["--literal-pathspecs", ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" },
    });
  const put = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), value);
  };
  const head = () => git("rev-parse", "HEAD").trim();
  const commit = (files, message = "Fixture change") => {
    git("add", "--", ...files);
    git("commit", "-m", message);
    return head();
  };
  git("init", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  git("config", "commit.gpgsign", "false");
  put("a.txt", initial);
  const base = commit(["a.txt"], "Initial fixture");
  const metadata = path.join(inputs, "metadata.txt");
  const allowFile = path.join(inputs, "allow");
  fs.writeFileSync(metadata, "Clean request");
  fs.writeFileSync(allowFile, "");
  const change = (options = {}) =>
    scanChange({
      cwd: dir,
      base,
      head: head(),
      branch: "fixture-topic",
      metadata,
      allowFile,
      defaultBranch: "main",
      ...options,
    });
  const cli = (...flags) =>
    spawnSync(
      process.execPath,
      [new URL("./privacy-ci.mjs", import.meta.url).pathname, "--allow", allowFile, ...flags],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          SCAN_BASE: base,
          SCAN_HEAD: head(),
          SCAN_BRANCH: "fixture-topic",
          PR_METADATA_FILE: metadata,
        },
      },
    );
  return { dir, inputs, git, put, head, commit, base, metadata, allowFile, change, cli };
}

test("added-lines parser keeps content resembling a diff header", () => {
  assert.equal(addedLines("diff --git a/a b/a\n+++ b/a\n@@ -0,0 +1 @@\n++++value\n"), "+++value");
});

for (const surface of [
  "tree",
  "added-then-removed",
  "message",
  "early-message",
  "title",
  "body",
  "branch",
]) {
  test(`change scan rejects a planted key in ${surface}`, (t) => {
    const f = fixture(t);
    f.put("a.txt", surface === "added-then-removed" ? token() : "changed\n");
    const planted = f.commit(
      ["a.txt"],
      ["message", "early-message"].includes(surface) ? token() : "Fixture change",
    );
    if (["added-then-removed", "early-message"].includes(surface)) {
      f.put("a.txt", "clean again\n");
      f.commit(["a.txt"], "Later fixture");
    }
    if (surface === "tree") f.put("untracked.txt", token());
    fs.writeFileSync(
      f.metadata,
      surface === "title"
        ? `${token()}\nClean body`
        : surface === "body"
          ? `Clean title\n${token()}`
          : "Clean request",
    );
    const findings = f.change({ branch: surface === "branch" ? token() : "fixture-topic" });
    assert.ok(bad(findings));
    if (surface === "added-then-removed") {
      assert.ok(
        findings.some(
          (x) => x.commit === planted && x.file === "a.txt" && x.line === 1 && x.rule === "token",
        ),
      );
    }
  });
}

test("clean history passes", (t) => {
  const f = fixture(t);
  f.put("a.txt", "Clean update");
  f.commit(["a.txt"]);
  assert.equal(bad(f.change()), false);
});

test("historical additions retain real paths, tree severities and generated-notice exemptions", (t) => {
  const f = fixture(t);
  const text = ["SV", "PBF", "999"].join("-");
  f.put("src/a name.ts", `// ${text}\n`);
  f.put("THIRD_PARTY_NOTICES.md", ["author", "package-vendor.com"].join("@") + "\n");
  const commit = f.commit(["src/a name.ts", "THIRD_PARTY_NOTICES.md"]);
  const findings = f.change();
  assert.equal(bad(findings), false);
  assert.ok(
    findings.some((x) => x.commit === commit && x.file === "src/a name.ts" && x.sev === "warn"),
  );
  assert.ok(
    findings.some(
      (x) => x.commit === commit && x.file === "THIRD_PARTY_NOTICES.md" && x.allowed && x.exempt,
    ),
  );
  f.put("note.md", text);
  const doc = f.commit(["note.md"]);
  assert.ok(
    f
      .change()
      .some((x) => x.commit === doc && x.file === "note.md" && x.sev === "error" && !x.allowed),
  );
});

test("historical additions use real-path fingerprints without staling unused allowances", (t) => {
  const f = fixture(t);
  f.put("src/fixture.ts", `const value = "${token()}";\n`);
  const commit = f.commit(["src/fixture.ts"]);
  const candidates = scan(f.dir, new Map(), { skipRoot: [".git"] }).filter((x) => x.fp);
  fs.writeFileSync(f.allowFile, allowLines(candidates, () => "Reviewed fixture").join("\n"));
  const findings = f.change();
  assert.equal(bad(findings), false);
  assert.ok(findings.some((x) => x.commit === commit && x.file === "src/fixture.ts" && x.allowed));
});

test("a stale allow entry fails by default and is a counted warning with --stale-warn", (t) => {
  const f = fixture(t);
  f.put("src/fixture.ts", `const value = "${token()}";\n`);
  const candidates = scan(f.dir, new Map(), { skipRoot: [".git"] }).filter((x) => x.fp);
  fs.writeFileSync(f.allowFile, allowLines(candidates, () => "Reviewed fixture").join("\n"));
  fs.rmSync(path.join(f.dir, "src/fixture.ts"));
  const stale = (findings) => findings.filter((x) => x.rule === "allow-stale");
  const plain = f.change();
  const warned = f.change({ staleWarn: true });
  assert.equal(stale(plain).length, 1);
  assert.equal(bad(plain), true);
  assert.equal(bad(warned), false);
  assert.deepEqual(
    stale(warned).map((x) => x.sev),
    ["warn"],
  );
  const result = f.cli("--stale-warn");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^privacy-scan: stale allow entries=1 \(warnings\)$/m);
  assert.doesNotMatch(result.stdout, /^STALE /m);
  const shown = f.cli("--stale-warn", "--show");
  assert.match(shown.stdout, /^STALE src\/fixture\.ts \S+ \| fp:[0-9a-f]{20} used 0 of 1$/m);
  const strict = f.cli();
  assert.equal(strict.status, 1);
  assert.doesNotMatch(strict.stdout, /stale allow entries/);
  // A real finding next to the stale entry stays an error.
  f.put("src/other.ts", `const value = "${token()}";\n`);
  assert.equal(bad(f.change({ staleWarn: true })), true);
  assert.equal(f.cli("--stale-warn").status, 1);
});

test("--stale-warn downgrades only the engine's stale entries, not a rule that shares the name", (t) => {
  const f = fixture(t);
  const inventory = path.join(f.inputs, "terms.json");
  const layout = [
    [5, "error", "g"],
    [6, "error", "gi"],
    [7, "error", "gi"],
    [8, "error", "gi"],
    [9, "error", "g"],
    [24, "text", "g"],
  ];
  const rules = layout.map(([order, sev, flags], i) => ({
    id: i ? `fixture-${i}` : "allow-stale",
    sev,
    kind: "show",
    source: `qqstale${i}qq`,
    flags,
    order,
    classification: "private-only",
  }));
  fs.writeFileSync(inventory, JSON.stringify({ version: 1, rules }));
  f.put("notes.txt", "qqstale0qq\n");
  const findings = f.change({ staleWarn: true, privateRulesFile: inventory });
  assert.ok(findings.some((x) => x.rule === "allow-stale" && x.sev === "error" && !x.allowed));
  assert.equal(bad(findings), true);
});

test("a merge-only addition remains blocked after a later removal", (t) => {
  const f = fixture(t);
  f.git("checkout", "-b", "topic");
  f.put("topic.txt", "Topic change");
  f.commit(["topic.txt"]);
  f.git("checkout", "main");
  f.put("main.txt", "Main change");
  f.commit(["main.txt"]);
  f.git("merge", "--no-ff", "--no-commit", "topic");
  f.put("merge.txt", token());
  const merge = f.commit(["merge.txt"], "Merge fixture");
  f.put("merge.txt", "Clean again");
  f.commit(["merge.txt"]);
  assert.ok(
    f
      .change()
      .some(
        (x) => x.commit === merge && x.file === "merge.txt" && x.rule === "token" && !x.allowed,
      ),
  );
});

test("a merge is blamed only for lines new against every parent", (t) => {
  const f = fixture(t);
  f.put("shared.txt", "one\n");
  f.commit(["shared.txt"]);
  f.git("checkout", "-b", "topic");
  f.put("topic.txt", token());
  const side = f.commit(["topic.txt"]);
  f.put("shared.txt", "one\ntopic\n");
  f.commit(["shared.txt"]);
  f.git("checkout", "main");
  f.put("shared.txt", "main\none\n");
  f.commit(["shared.txt"]);
  f.git("merge", "--no-ff", "--no-commit", "topic");
  // The resolution keeps both sides' lines and adds one of its own.
  f.put("shared.txt", `main\none\ntopic\n${token()}\n`);
  const merge = f.commit(["shared.txt"], "Merge fixture");
  const tokens = f.change().filter((x) => x.commit && x.rule === "token" && !x.allowed);
  assert.deepEqual(
    tokens.map((x) => [x.commit, x.file]).sort(),
    [
      [merge, "shared.txt"],
      [side, "topic.txt"],
    ].sort(),
  );
});

test("zero before with the fetched default tip scans through the root commit", (t) => {
  const f = fixture(t, token());
  f.put("a.txt", "Clean now");
  f.commit(["a.txt"]);
  f.git("update-ref", "refs/remotes/origin/main", f.head());
  assert.ok(
    f
      .change({ base: "0".repeat(40) })
      .some((x) => x.commit === f.base && x.rule === "token" && !x.allowed),
  );
});

test("a non-ancestor before uses the default-branch merge-base", (t) => {
  const f = fixture(t);
  f.put("a.txt", "Old tip");
  const old = f.commit(["a.txt"]);
  f.git("checkout", "-b", "rewritten", f.base);
  f.put("a.txt", token());
  const planted = f.commit(["a.txt"]);
  f.put("a.txt", "Clean now");
  f.commit(["a.txt"]);
  f.git("update-ref", "refs/remotes/origin/main", old);
  assert.ok(
    f.change({ base: old }).some((x) => x.commit === planted && x.rule === "token" && !x.allowed),
  );
});

test("no resolvable default-branch base fails closed", (t) => {
  const f = fixture(t);
  assert.throws(() => f.change({ base: "0".repeat(40) }));
  f.git("checkout", "--orphan", "unrelated");
  f.put("a.txt", "Unrelated root");
  f.commit(["a.txt"]);
  f.git("update-ref", "refs/remotes/origin/main", f.base);
  assert.throws(() => f.change({ base: f.base }));
});

test("public CLI never logs planted content or filenames", (t) => {
  const f = fixture(t);
  f.put(`${token()}.txt`, token());
  const result = spawnSync(
    process.execPath,
    [new URL("./privacy-scan.mjs", import.meta.url).pathname, f.dir],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.ok(!(result.stdout + result.stderr).includes(token()));
});

test("root checkout metadata can be skipped but nested metadata always fails", (t) => {
  const f = fixture(t);
  assert.equal(bad(scan(f.dir, new Map(), { skipRoot: [".git"] })), false);
  fs.mkdirSync(path.join(f.dir, "nested", ".git"), { recursive: true });
  assert.equal(bad(scan(f.dir, new Map(), { skipRoot: [".git"] })), true);
});

test("local --show is the explicit opt-in for public scanner details", (t) => {
  const f = fixture(t);
  f.put(`${token()}.txt`, token());
  const result = spawnSync(
    process.execPath,
    [new URL("./privacy-scan.mjs", import.meta.url).pathname, f.dir, "--show"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes(token()));
});

test("batched commit patches retain literal paths across multiple files", (t) => {
  const f = fixture(t);
  const files = ["src/[draft].ts", "src/d.ts", "src/a name.ts"];
  f.put(files[0], token());
  f.put(files[1], "Clean ordinary file");
  f.put(files[2], "Clean spaced file");
  const planted = f.commit(files);
  for (const file of files) f.put(file, "Clean again");
  f.commit(files);
  assert.ok(
    f
      .change()
      .some(
        (finding) =>
          finding.commit === planted &&
          finding.file === files[0] &&
          finding.rule === "token" &&
          !finding.allowed,
      ),
  );
});

test("gitlink entries fail explicitly instead of being read as blobs", (t) => {
  const f = fixture(t);
  f.git("update-index", "--add", "--cacheinfo", "160000", f.base, "vendor/component");
  f.git("commit", "-m", "Fixture gitlink");
  assert.throws(() => f.change(), /gitlink entries are unsupported/);
  const result = f.cli();
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("gitlink entries are unsupported"));
});

test("binary attributes cannot hide an added-then-removed text key", (t) => {
  const f = fixture(t);
  f.put(".gitattributes", "* -diff\n");
  f.commit([".gitattributes"]);
  f.put("hidden.txt", token());
  const planted = f.commit(["hidden.txt"]);
  f.git("rm", "--", "hidden.txt");
  f.git("commit", "-m", "Remove fixture");
  assert.ok(
    f
      .change()
      .some(
        (finding) =>
          finding.commit === planted &&
          finding.file === "hidden.txt" &&
          finding.rule === "token" &&
          !finding.allowed,
      ),
  );
});

for (const blocked of [false, true]) {
  test(`file-to-symlink sections pair by path (${blocked ? "planted" : "clean"} target)`, (t) => {
    const f = fixture(t);
    f.put("link.txt", "Original regular file");
    f.put("target.txt", "Clean target");
    f.commit(["link.txt", "target.txt"]);
    fs.unlinkSync(path.join(f.dir, "link.txt"));
    fs.symlinkSync(blocked ? token() : "target.txt", path.join(f.dir, "link.txt"));
    const changed = f.commit(["link.txt"]);
    const findings = f.change();
    if (blocked) {
      assert.ok(
        findings.some(
          (finding) =>
            finding.commit === changed &&
            finding.file === "link.txt" &&
            finding.rule === "token" &&
            !finding.allowed,
        ),
      );
    } else assert.equal(bad(findings), false);
  });
}

test("hunkless content changes select the full blob; pure mode changes do not", () => {
  const sections = ["diff --git a/file.txt b/file.txt\nBinary files differ\n"];
  const change = { oldMode: "100644", mode: "100644", oldOid: "a".repeat(40), oid: "b".repeat(40) };
  assert.equal(addedLineSelection(change, sections), null);
  assert.equal(
    addedLineSelection(change, [
      ...sections,
      "diff --git a/file.txt b/file.txt\n@@ -1 +1 @@\n-old\n+new\n",
    ]),
    null,
  );
  assert.deepEqual(
    addedLineSelection({ ...change, mode: "100755", oid: change.oldOid }, sections),
    new Set(),
  );
});

test("diff sections whose header path is absent from the raw records fail closed", () => {
  assert.throws(() =>
    pairCommitSections([{ file: "expected.txt" }], "diff --git a/other.txt b/other.txt\n"),
  );
});

// The staged scan: what the next commit adds, against HEAD or the empty tree.
const staged = (f, options = {}) => scanStaged({ cwd: f.dir, allowFile: f.allowFile, ...options });
const errors = (findings) => findings.filter((x) => x.sev === "error" && !x.allowed);

test("the staged scan finds only added lines, with their real line numbers", (t) => {
  const f = fixture(t, `keep\n${token()}\nclean\n`);
  assert.deepEqual(errors(staged(f)), []);
  // A removed line and an unchanged context line add nothing.
  f.put("a.txt", "keep\nclean\nmore\n");
  f.git("add", "a.txt");
  assert.deepEqual(errors(staged(f)), []);
  f.put("a.txt", `keep\nclean\n${token()}\n`);
  f.git("add", "a.txt");
  const [finding, ...rest] = errors(staged(f));
  assert.deepEqual(rest, []);
  assert.equal(finding.file, "a.txt");
  assert.equal(finding.line, 3);
  assert.equal(finding.path, undefined);
});

test("the staged scan judges paths and honours the allow-list", (t) => {
  const f = fixture(t);
  const inventory = path.join(f.inputs, "terms.json");
  const rules = [5, 6, 7, 8, 9, 24].map((order) => ({
    id: `fixture-${order}`,
    sev: order === 24 ? "text" : "error",
    kind: "show",
    source: `qqstaged${order}qq`,
    flags: [6, 7, 8].includes(order) ? "gi" : "g",
    order,
    classification: "private-only",
  }));
  fs.writeFileSync(inventory, JSON.stringify({ version: 1, rules }));
  f.put("qqstaged5qq.txt", "clean\n");
  f.git("add", "qqstaged5qq.txt");
  const [finding] = errors(staged(f, { privateRulesFile: inventory }));
  assert.equal(finding.rule, "fixture-5");
  assert.equal(finding.path, true);
  f.git("rm", "-q", "--cached", "qqstaged5qq.txt");
  // An allow entry for the staged finding lets it pass; the scan never stales one.
  f.put("src/fixture.ts", `const value = "${token()}";\n`);
  f.git("add", "src/fixture.ts");
  const candidates = scan(f.dir, new Map(), { skipRoot: [".git"] }).filter((x) => x.fp);
  fs.writeFileSync(f.allowFile, allowLines(candidates, () => "Reviewed fixture").join("\n"));
  const findings = staged(f);
  assert.deepEqual(errors(findings), []);
  assert.ok(findings.some((x) => x.file === "src/fixture.ts" && x.allowed));
  assert.ok(!findings.some((x) => x.rule === "allow-stale"));
});

test("binary files and mode-only changes pass the staged scan", (t) => {
  const f = fixture(t);
  f.put("image.bin", Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]));
  f.git("add", "image.bin");
  assert.deepEqual(errors(staged(f)), []);
  f.git("update-index", "--chmod=+x", "a.txt");
  assert.deepEqual(errors(staged(f)), []);
});

test("a staged gitlink, a malformed allow-list and any other scan failure refuse with their own rules", (t) => {
  const f = fixture(t);
  const refusal = (findings) => findings.map((x) => [x.rule, x.sev, x.allowed, x.place]);
  f.git("update-index", "--add", "--cacheinfo", "160000", f.base, "vendor/component");
  assert.deepEqual(refusal(staged(f)), [["gitlink", "error", false, "the staged changes"]]);
  f.git("rm", "-q", "--cached", "vendor/component");
  // A malformed allow entry says so, not that the index is wrong.
  fs.writeFileSync(f.allowFile, "not an entry\n");
  assert.deepEqual(refusal(staged(f)), [["allow-file", "error", false, "the allow-list"]]);
  fs.writeFileSync(f.allowFile, "");
  // A staged blob that cannot be read: the diff parse fails.
  f.put("b.txt", "clean\n");
  f.git("add", "b.txt");
  const oid = f.git("rev-parse", ":b.txt").trim();
  fs.rmSync(path.join(f.dir, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
  assert.deepEqual(refusal(staged(f)), [["scan-error", "error", false, "the staged changes"]]);
  // A directory outside any repository: git fails, and the scan says so.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-ci-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  assert.deepEqual(refusal(scanStaged({ cwd: outside })), [
    ["scan-error", "error", false, "the staged changes"],
  ]);
});

test("the staged scan on an unborn branch uses the empty tree", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-ci-unborn-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" },
    });
  git("init", "-q", "--initial-branch=main");
  fs.writeFileSync(path.join(dir, "a.txt"), "clean\n");
  git("add", "a.txt");
  assert.deepEqual(errors(scanStaged({ cwd: dir })), []);
  fs.writeFileSync(path.join(dir, "b.txt"), `${token()}\n`);
  git("add", "b.txt");
  assert.deepEqual(
    errors(scanStaged({ cwd: dir })).map((x) => [x.file, x.line]),
    [["b.txt", 1]],
  );
});

test("the staged scan skips a merge in progress", (t) => {
  const f = fixture(t);
  f.put("a.txt", `${token()}\n`);
  f.git("add", "a.txt");
  fs.writeFileSync(path.join(f.dir, ".git", "MERGE_HEAD"), `${f.base}\n`);
  assert.equal(staged(f), null);
});

// Each commit-time fix, pinned: one string per rule or place, a rerun and never an amend.
const EDITMSG = 'git commit -e -v -F "$(git rev-parse --git-path COMMIT_EDITMSG)"';
const SETUP = "the maintainer clone setup in CONTRIBUTING.md (AI assistance)";
const IDENTITY = `set to the maintainer's GitHub login and noreply address as in ${SETUP}`;
const PINNED_LOCATION = {
  message: `rerun with the message reworded (${EDITMSG} reopens it)`,
  content: "rerun with the line edited and the file staged again (git add)",
  path: "rerun with the file renamed (git mv)",
};
const PINNED = {
  "forbidden-path": "rerun with the file unstaged (git rm --cached)",
  "key-file": "rerun with the key file unstaged (git rm --cached)",
  "image-metadata": "rerun with the image's metadata stripped and the file staged again (git add)",
  gitlink: "rerun with the gitlink unstaged (git rm --cached); submodules are not supported",
  "scan-error":
    "rerun with the index checked (git status, git diff --cached --stat); report the hook if it repeats",
  "allow-file": "rerun with the malformed entry in scripts/privacy-scan.allow fixed",
  "author-identity": `rerun with user.name and user.email ${IDENTITY}, and no --author or GIT_AUTHOR_* override; for an amended commit, rerun with --amend --reset-author`,
  "committer-identity": `rerun with user.name and user.email ${IDENTITY}, and no GIT_COMMITTER_* override`,
  "missing-signoff": "rerun with -s (git commit -s) as the maintainer identity",
  "ai-co-author": "rerun with the AI Co-authored-by line removed from the message",
  "signing-config":
    "rerun with git config commit.gpgsign true and a key (user.signingkey, or gpg.ssh.defaultKeyCommand for ssh); " +
    "this checks the config, not the signature, and needs commit.gpgsign because the hook cannot see -S",
};

test("each commit-time rule and place has its one pinned fix", () => {
  assert.deepEqual({ ...FIX }, PINNED);
  assert.deepEqual({ ...LOCATION_FIX }, PINNED_LOCATION);
});

test("every rule commit-msg reports itself has its own fix; only content rules fall back", (t) => {
  // The rules are what the checks emit, not a list kept by hand.
  const f = fixture(t);
  f.git("config", "user.name", "Someone");
  f.git("config", "user.email", "someone@example.com");
  const message = "Subject\n\nCo-authored-by: Claude <noreply@anthropic.com>\n";
  const emitted = commitFindings(f.dir, { message });
  const fromStaged = () => emitted.push(...staged(f).map((x) => ({ ...x, source: "staged" })));
  f.git("update-index", "--add", "--cacheinfo", "160000", f.base, "vendor/component");
  fromStaged();
  f.git("rm", "-q", "--cached", "vendor/component");
  fs.writeFileSync(f.allowFile, "not an entry\n");
  fromStaged();
  fs.writeFileSync(f.allowFile, "");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-ci-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  emitted.push(...scanStaged({ cwd: outside }).map((x) => ({ ...x, source: "staged" })));
  for (const finding of emitted)
    assert.equal(fixFor(finding), FIX[finding.rule], `${finding.rule} has no fix of its own`);
  // FIX holds exactly the emitted rules and the scanner's structural ones.
  const structural = ["forbidden-path", "key-file", "image-metadata"];
  const rules = new Set([...emitted.map((x) => x.rule), ...structural]);
  assert.deepEqual(Object.keys(FIX).sort(), [...rules].sort());
  // A rule of the hook's own with no entry has no fallback.
  assert.throws(() => fixFor({ rule: "new-check", source: "commit" }), /no fix for new-check/);
  assert.throws(() => fixFor({ rule: "new-check", source: "staged", hook: true }), /new-check/);
  // Every scanner rule takes the fix for where it was found.
  for (const { id } of GENERIC_RULES) {
    if (Object.hasOwn(FIX, id)) continue;
    assert.equal(fixFor({ rule: id, source: "message" }), LOCATION_FIX.message);
    assert.equal(fixFor({ rule: id, source: "staged" }), LOCATION_FIX.content);
    assert.equal(fixFor({ rule: id, source: "staged", path: true }), LOCATION_FIX.path);
  }
  for (const [rule, fix] of Object.entries({ ...FIX, ...LOCATION_FIX })) {
    assert.match(fix, /^rerun with /, rule);
    const amends = fix.replace("--amend --reset-author", "");
    assert.ok(!amends.includes("--amend"), `${rule} amends`);
    if (rule !== "author-identity") assert.ok(!fix.includes("--amend"), `${rule} amends`);
  }
  // The identity fixes point to the setup and never print the handle.
  const handle = ["alfy", "pops"].join("");
  assert.ok(!Object.values(FIX).join("\n").includes(handle));
  for (const rule of ["author-identity", "committer-identity"])
    assert.ok(
      FIX[rule].includes("noreply address as in the maintainer clone setup in CONTRIBUTING.md"),
    );
  assert.match(FIX["author-identity"], /no --author or GIT_AUTHOR_\* override/);
});

test("a commit-time place names no staged file unless shown", () => {
  const content = { rule: "token", source: "staged", file: "a.txt", line: 4, index: 2, count: 3 };
  const pathFinding = { rule: "fixture", source: "staged", file: "a.txt", line: 0, path: true };
  const binary = {
    rule: "token",
    source: "staged",
    file: "b.bin",
    line: 0,
    offset: 9,
    index: 1,
    count: 1,
  };
  const shown = { ...content, shown: "match" };
  assert.equal(placeOf(content), "staged file 2 of 3, line 4");
  assert.equal(placeOf(pathFinding), "a staged path");
  assert.equal(placeOf(binary), "staged file 1 of 1, byte 9");
  assert.equal(placeOf({ ...content, line: 0 }), "staged file 2 of 3");
  assert.equal(placeOf({ ...content, count: undefined }), "staged file 2, line 4");
  assert.equal(placeOf({ ...content, index: null }), "a staged file, line 4");
  assert.equal(placeOf(shown), "staged file 2 of 3, line 4");
  const own = { source: "staged", hook: true };
  assert.equal(
    placeOf({ ...own, rule: "gitlink", place: "the staged changes" }),
    "the staged changes",
  );
  assert.equal(placeOf({ ...own, rule: "allow-file", place: "the allow-list" }), "the allow-list");
  assert.equal(placeOf({ rule: "token", file: "message.txt", line: 3 }), "message:3");
  assert.equal(placeOf({ rule: "author-identity", source: "commit", place: "author" }), "author");
  // CODESENSE_PRIVACY_SHOW=1: the path, and a show-kind rule's match.
  assert.equal(placeOf(content, true), "a.txt:4");
  assert.equal(placeOf(pathFinding, true), "a.txt");
  assert.equal(placeOf(binary, true), "b.bin@9");
  assert.equal(placeOf(shown, true), "a.txt:4 match");
  assert.equal(placeOf({ rule: "token", line: 3, shown: "m" }, true), "message:3 m");
});
