#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Public CI and local pre-push scanning: tree, each commit's additions and metadata.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scan, scanAddedFiles, loadAllow } from "./privacy-engine.mjs";
import { INVENTORY_ERROR, combinedRules, ruleIds } from "./privacy-private-rules.mjs";
import { DEFAULT_ALLOW, report } from "./privacy-scan.mjs";
import { resolveRange, revision, gitOptions, git } from "./ci-scan-range.mjs";

// A git call that may fail: { status, stdout }.
const tryGit = (args, cwd) =>
  spawnSync("git", ["--literal-pathspecs", ...args], { ...gitOptions(cwd), encoding: "utf8" });
// A git call fed one item per stdin line.
const gitStdin = (args, lines, cwd, encoding) =>
  execFileSync("git", ["--literal-pathspecs", ...args], {
    ...gitOptions(cwd),
    stdio: ["pipe", "pipe", "pipe"],
    input: lines.join("\n") + "\n",
    encoding,
  });
const ZERO = /^0+$/;

export function addedEntries(diff) {
  let next = null;
  const entries = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) next = null;
    else if (line.startsWith("@@ ")) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!match) throw new Error();
      next = Number(match[1]);
    } else if (next !== null && line.startsWith("+")) {
      entries.push({ line: next++, text: line.slice(1) });
    } else if (next !== null && line.startsWith(" ")) next++;
  }
  return entries;
}
export const addedLines = (diff) =>
  addedEntries(diff)
    .map((entry) => entry.text)
    .join("\n");

const GITLINK_ERROR =
  "privacy-scan: gitlink entries are unsupported; remove them on a fresh branch";

// Read raw blobs in one subprocess per commit, never through paths or filters.
function commitBlobs(cwd, oids) {
  const unique = [...new Set(oids)];
  const blobs = new Map();
  if (!unique.length) return blobs;
  const output = gitStdin(["cat-file", "--batch"], unique, cwd);
  let offset = 0;
  for (const oid of unique) {
    const newline = output.indexOf(10, offset);
    if (newline < 0) throw new Error();
    const [actual, type, sizeText] = output.subarray(offset, newline).toString("ascii").split(" ");
    const size = Number(sizeText);
    if (actual !== oid || type !== "blob" || !/^\d+$/.test(sizeText) || !Number.isSafeInteger(size))
      throw new Error();
    const end = newline + 1 + size;
    if (output[end] !== 10) throw new Error();
    blobs.set(oid, output.subarray(newline + 1, end));
    offset = end + 1;
  }
  if (offset !== output.length) throw new Error();
  return blobs;
}

// Use authoritative raw names to recognise headers, without splitting paths on
// whitespace. Ordinary and Git-quoted spellings are accepted; others fail closed.
export function pairCommitSections(records, patch) {
  const headers = new Map();
  const sections = new Map(records.map((record) => [record.file, []]));
  for (const { file } of records) {
    for (const left of [`a/${file}`, JSON.stringify(`a/${file}`)]) {
      for (const right of [`b/${file}`, JSON.stringify(`b/${file}`)]) {
        const header = `diff --git ${left} ${right}`;
        if (headers.has(header) && headers.get(header) !== file) throw new Error();
        headers.set(header, file);
      }
    }
  }
  for (const part of patch.split(/(?=^diff --git )/m).filter(Boolean)) {
    const newline = part.indexOf("\n");
    const file = headers.get(newline < 0 ? part : part.slice(0, newline));
    if (file === undefined) throw new Error();
    sections.get(file).push(part);
  }
  if ([...sections.values()].some((parts) => parts.length === 0)) throw new Error();
  return sections;
}

// Without hunks, a content change still needs a full blob scan. Only an
// executable-bit-only change with the same blob can safely skip text lines.
export function addedLineSelection(record, sections) {
  const pureModeChange =
    record.oldOid === record.oid &&
    record.oldMode !== record.mode &&
    ["100644", "100755"].includes(record.oldMode) &&
    ["100644", "100755"].includes(record.mode);
  if (sections.some((section) => !/^@@ /m.test(section))) return pureModeChange ? new Set() : null;
  return new Set(sections.flatMap(addedEntries).map((entry) => entry.line));
}

// Each file the commit has, changed against one side: its blob and the line
// numbers added there (null: the whole file).
function sideAdditions(cwd, command) {
  const options = [
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--no-color",
    "--no-abbrev",
    "--ignore-submodules=none",
    "--submodule=short",
  ];
  const raw = git([...command, ...options, "--raw", "-z", "--"], cwd).split("\0");
  if (raw.pop() !== "" || raw.length % 2 !== 0) throw new Error();
  const records = [];
  for (let i = 0; i < raw.length; i += 2) {
    const match =
      /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([AMDT])$/.exec(
        raw[i],
      );
    if (!match || !raw[i + 1]) throw new Error();
    if (match[1] === "160000" || match[2] === "160000") throw new Error(GITLINK_ERROR);
    records.push({
      file: raw[i + 1],
      oldMode: match[1],
      mode: match[2],
      oldOid: match[3],
      oid: match[4],
      deleted: match[5] === "D",
    });
  }
  // --text overrides binary attributes such as -diff. Quote non-ASCII paths
  // literally so normal and JSON-quoted header spellings match raw UTF-8 names.
  const patch = git(
    [
      "-c",
      "core.quotePath=false",
      ...command,
      ...options,
      "--patch",
      "--text",
      "--unified=0",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--",
    ],
    cwd,
  );
  // A typechange can have separate deletion and creation sections for one path.
  const sections = pairCommitSections(records, patch);
  return new Map(
    records
      .filter((record) => !record.deleted)
      .map((record) => [
        record.file,
        { oid: record.oid, lineNumbers: addedLineSelection(record, sections.get(record.file)) },
      ]),
  );
}

const intersectLines = (a, b) =>
  a === null ? b : b === null ? a : new Set([...a].filter((line) => b.has(line)));

// A merge adds only the lines that are new against every parent: its own
// resolutions. Lines a parent already has were added by a commit on that side,
// which the scan visits too unless the destination already has it. Binary
// files and paths changed against every parent are scanned whole.
function* commitAdditions(cwd, commit) {
  const [, ...parents] = git(["rev-list", "--parents", "--max-count=1", commit], cwd)
    .trim()
    .split(" ");
  const [first, ...others] = parents.length
    ? parents.map((parent) => sideAdditions(cwd, ["diff", parent, commit]))
    : [sideAdditions(cwd, ["diff-tree", "--root", "--no-commit-id", "-r", commit])];
  const blobs = commitBlobs(
    cwd,
    [...first.values()].map(({ oid }) => oid),
  );
  for (const [file, { oid, lineNumbers }] of first) {
    // A file some parent already has as is brings nothing new, its path included.
    if (others.some((side) => !side.has(file))) continue;
    const lines = others.reduce(
      (acc, side) => intersectLines(acc, side.get(file).lineNumbers),
      lineNumbers,
    );
    yield { file, data: blobs.get(oid), lineNumbers: lines };
  }
}

// The maintainer's identity is the one a commit or tag may name: exactly their
// sign-off line in the trailer block, and exactly their tagger header. Built at
// load so this file does not carry the handle.
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MAINTAINER = ["alfy", "pops"].join("");
const MAINTAINER_IDENTITY = `${MAINTAINER} <6836580+${MAINTAINER}@users.noreply.github.com>`;
const MAINTAINER_SIGNOFF = `Signed-off-by: ${MAINTAINER_IDENTITY}`;
const MAINTAINER_TAGGER = new RegExp(
  `^tagger ${escapeRegExp(MAINTAINER_IDENTITY)} \\d+ [+-]\\d{4}$`,
);
const BLANK = /^[ \t]*$/;

// Lines are split on \n only, so \r, U+2028 and U+2029 never end one. The
// trailer block is the last paragraph, never the subject; `skip` lines (comments
// git will strip) may follow it. Masked lines are blanked, not removed, so every
// other line keeps its number.
export function withoutMaintainerSignoff(message, skip = () => false) {
  const lines = message.split("\n");
  let end = lines.length;
  while (end > 0 && (BLANK.test(lines[end - 1]) || skip(lines[end - 1]))) end--;
  let start = end;
  while (start > 0 && !BLANK.test(lines[start - 1])) start--;
  for (let i = Math.max(start, 1); i < end; i++) if (lines[i] === MAINTAINER_SIGNOFF) lines[i] = "";
  return lines.join("\n");
}

// A raw tag object: the maintainer's tagger header, and their sign-off in the
// message above the signature, which starts at the last whole BEGIN line, as in git.
export function withoutMaintainerTagIdentity(text) {
  const split = text.indexOf("\n\n");
  if (split < 0) return text;
  const headers = text
    .slice(0, split)
    .split("\n")
    .map((line) => (MAINTAINER_TAGGER.test(line) ? "" : line))
    .join("\n");
  const body = text.slice(split + 2).split("\n");
  const signature = body.findLastIndex((line) =>
    /^-----BEGIN [A-Z ]{1,20}SIGNATURE-----$/.test(line),
  );
  const end = signature < 0 ? body.length : signature;
  const message = withoutMaintainerSignoff(body.slice(0, end).join("\n"));
  return [`${headers}\n\n${message}`, ...body.slice(end)].join("\n");
}

// Scan each commit's additions, and its message as metadata in `tmp`.
function scanCommits(cwd, commits, rules, freshAllow, tmp, progress = () => {}) {
  const findings = [];
  for (const [i, commit] of commits.entries()) {
    if (i > 0 && i % 100 === 0) progress(i, commits.length);
    for (const finding of scanAddedFiles(commitAdditions(cwd, commit), freshAllow(), { rules })) {
      findings.push({ ...finding, commit });
    }
    fs.writeFileSync(
      path.join(tmp, `message-${i}.txt`),
      withoutMaintainerSignoff(git(["show", "--no-patch", "--format=%B", commit, "--"], cwd)),
    );
  }
  return findings;
}

const withTemp = (fn) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-change-"));
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

export function scanChange({
  cwd,
  base,
  head,
  defaultBranch,
  branch,
  metadata,
  allowFile = DEFAULT_ALLOW,
  privateRulesFile,
  staleWarn = false,
}) {
  if (typeof branch !== "string" || !branch) throw new Error();
  const range = resolveRange({ cwd, base, head, defaultBranch });
  const rules = combinedRules(privateRulesFile);
  const freshAllow = () => loadAllow(allowFile, ruleIds(rules));
  // An allow entry with nothing left to excuse hides nothing; staleWarn reports it as a warning.
  const findings = scan(cwd, freshAllow(), { paths: true, skipRoot: [".git"], rules }).map((f) =>
    staleWarn && f.stale === true ? { ...f, sev: "warn" } : f,
  );
  const commits = git(
    [
      "rev-list",
      "--reverse",
      "--topo-order",
      range.allHistory ? head : `${range.base}..${head}`,
      "--",
    ],
    cwd,
  )
    .split("\n")
    .filter(Boolean)
    .map((value) => revision(value));
  return withTemp((tmp) => {
    findings.push(...scanCommits(cwd, commits, rules, freshAllow, tmp));
    if (metadata) fs.copyFileSync(metadata, path.join(tmp, "request.txt"));
    fs.writeFileSync(path.join(tmp, "branch.txt"), branch);
    findings.push(...scan(tmp, new Map(), { strict: true, rules }));
    return findings;
  });
}

const PUBLIC_OWNER = "codesensehq";

// A push is public when it goes to the public GitHub owner. A github.com URL
// whose owner cannot be read is treated as public, and so is any URL naming
// the owner (an SSH host alias, for example). `extra` only widens the set.
export function isPublicRemote(url, extra = "") {
  const value = url.trim();
  if (extra.split(/\s+/).filter(Boolean).includes(value)) return true;
  if (value.toLowerCase().includes(PUBLIC_OWNER)) return true;
  const match =
    /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]*@)?(?:www\.)?github\.com(?::\d+)?[:/]+([^/]+)\/[^/]+\/*$/i.exec(
      value,
    );
  if (match && /^[a-z0-9-]+$/i.test(match[1])) return false;
  // Any other spelling that still reaches github.com fails closed.
  return /github\.com/i.test(value);
}

const REMOTE_TIMEOUT_MS = 60_000;

// Commit and tag tips the destination already has. The remote is asked
// directly: remote-tracking refs can describe another URL (pushurl, set-url).
// Tips this clone lacks are fetched from that same URL by object id, without
// writing a ref, so a push that merges a newer main than the last fetch is
// still measured against everything the destination holds. Any failure to
// list or fetch fails closed. Other refs (pull requests) are left out:
// excluding fewer tips only scans more.
// Never prompt inside a hook, and never hang: a timeout blocks the push.
function remoteTips(cwd, url, timeout = REMOTE_TIMEOUT_MS) {
  if (url.startsWith("-")) throw new Error();
  const remote = (args) =>
    spawnSync("git", ["--literal-pathspecs", ...args], {
      ...gitOptions(cwd),
      encoding: "utf8",
      timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    });
  const listed = remote(["ls-remote", url, "refs/heads/*", "refs/tags/*"]);
  if (listed.status !== 0) throw new Error();
  const shas = [
    ...new Set(
      listed.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\t")[0]),
    ),
  ].map((value) => revision(value));
  let objects = objectTypes(cwd, shas);
  const missing = objects.filter(([, type]) => type === "missing").map(([sha]) => sha);
  if (missing.length) {
    const fetched = remote([
      "-c",
      "fetch.recurseSubmodules=false",
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-auto-maintenance",
      url,
      ...missing,
    ]);
    if (fetched.status !== 0) throw new PushRefused(FETCH_FIX);
    objects = objectTypes(cwd, shas);
    if (objects.some(([, type]) => type === "missing")) throw new PushRefused(FETCH_FIX);
  }
  return objects
    .filter(([, type]) => type === "commit" || type === "tag")
    .map(([sha]) => revision(sha));
}

// [sha, type] for each object id; type is "missing" for one this clone lacks.
const objectTypes = (cwd, shas) =>
  shas.length
    ? gitStdin(["cat-file", "--batch-check"], shas, cwd, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" "))
    : [];

// Commits a push publishes: everything reachable from the pushed tips that the
// destination does not already have, in one walk.
const pushedCommits = (cwd, localShas, tips) =>
  gitStdin(
    ["rev-list", "--reverse", "--topo-order", "--stdin"],
    [...localShas, "--not", ...tips],
    cwd,
    "utf8",
  )
    .split("\n")
    .filter(Boolean)
    .map((value) => revision(value));

// git's pre-push stdin: <local ref> <local sha> <remote ref> <remote sha>,
// parsed from the right.
function parseUpdates(updates) {
  return updates
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const fields = line.split(" ");
      if (fields.length < 4) throw new Error();
      const [localSha, remoteRef, remoteSha] = fields.slice(-3);
      return { localSha: revision(localSha), remoteRef, remoteSha: revision(remoteSha) };
    });
}

// Counts only: the refusal never names a commit, ref or term.
class PushRefused extends Error {}
const FETCH_FIX =
  "privacy-scan: cannot fetch the commits the destination already has; fetch and retry.";

// Pre-push: the added lines and message of every pushed commit, the text of
// every annotated tag (nested tags peeled), and each destination ref name.
// Deletions publish nothing. Commits and tag objects new to the destination are
// counted first: above `maxNewObjects` the push is refused at once, since a
// branch on private history would otherwise mean a very long scan.
export function scanPush({
  cwd,
  url,
  updates,
  privateRulesFile,
  allowFile = DEFAULT_ALLOW,
  remoteTimeoutMs,
  maxNewObjects = Infinity,
  requireSigned = false,
  progress,
}) {
  const rules = combinedRules(privateRulesFile);
  const freshAllow = () => loadAllow(allowFile, ruleIds(rules));
  const pushes = parseUpdates(updates).filter(({ localSha }) => !ZERO.test(localSha));
  if (!pushes.length) return [];
  const localShas = pushes.map(({ localSha }) => localSha);
  // Each updated ref's old value, when this clone has it, is on the destination too.
  const olds = pushes.map(({ remoteSha }) => remoteSha).filter((sha) => !ZERO.test(sha));
  const tips = [
    ...new Set([
      ...remoteTips(cwd, url, remoteTimeoutMs),
      ...objectTypes(cwd, olds)
        .filter(([, type]) => type === "commit")
        .map(([sha]) => revision(sha)),
    ]),
  ];
  const known = new Set(tips);
  const pushedTags = new Set(
    objectTypes(cwd, localShas)
      .filter(([, type]) => type === "tag")
      .map(([sha]) => sha),
  );
  // Each pushed annotated tag, peeled until the object is no longer a tag.
  const tags = localShas.map((localSha) => {
    const texts = [];
    if (!pushedTags.has(localSha)) return texts;
    for (let object = localSha; ; ) {
      const tag = tryGit(["cat-file", "tag", object], cwd);
      if (tag.status !== 0) break;
      texts.push({ object, text: tag.stdout });
      object = revision(/^object (\S+)$/m.exec(tag.stdout)?.[1]);
    }
    return texts;
  });
  if (Number.isFinite(maxNewObjects)) {
    // Count up to one past the limit.
    const newTags = tags.flat().filter(({ object }) => !known.has(object)).length;
    const newCommits = Number(
      gitStdin(
        ["rev-list", "--count", `--max-count=${maxNewObjects + 1}`, "--stdin"],
        [...localShas, "--not", ...tips],
        cwd,
        "utf8",
      ).trim(),
    );
    if (newCommits + newTags > maxNewObjects)
      throw new PushRefused(
        `privacy-scan: this push carries more than ${maxNewObjects} commits or tags ` +
          "the public repo does not have; that is probably private history. Push a " +
          "branch based on the public main (limit: CODESENSE_PRIVACY_MAX_NEW_COMMITS).",
      );
  }
  const commits = pushedCommits(cwd, localShas, tips);
  return withTemp((tmp) => {
    for (const [i, { remoteRef }] of pushes.entries()) {
      fs.writeFileSync(path.join(tmp, `ref-${i}.txt`), remoteRef);
      for (const [depth, { text }] of tags[i].entries())
        fs.writeFileSync(
          path.join(tmp, `tag-${i}-${depth}.txt`),
          withoutMaintainerTagIdentity(text),
        );
    }
    const findings = scanCommits(cwd, commits, rules, freshAllow, tmp, progress);
    findings.push(...scan(tmp, new Map(), { strict: true, rules }));
    if (requireSigned) findings.push(...maintainerFindings(cwd, commits));
    return findings;
  });
}

const AI_CO_AUTHOR = /^Co-authored-by[ \t]*:.*<[^<>]*@(?:[^<>@]*\.)?anthropic\.com>/i;

// A push from a maintainer clone (codesense.requireSigned) to the public repo
// refuses a commit with no signature or with an AI co-author trailer. Every
// commit the push publishes is checked, a contributor's included. This checks
// that a signature is present, not whose key made it.
function maintainerFindings(cwd, commits) {
  const findings = [];
  for (const commit of commits) {
    const raw = git(["cat-file", "commit", commit], cwd);
    const split = raw.indexOf("\n\n");
    const [headers, message] = split < 0 ? [raw, ""] : [raw.slice(0, split), raw.slice(split + 2)];
    const found = (rule) =>
      findings.push({
        rule,
        sev: "error",
        file: `commit ${commit.slice(0, 12)}`,
        line: 0,
        commit,
        allowed: false,
      });
    if (!headers.split("\n").some((line) => /^gpgsig(?:-sha256)? /.test(line)))
      found("unsigned-commit");
    if (message.split("\n").some((line) => AI_CO_AUTHOR.test(line))) found("ai-co-author");
  }
  return findings;
}

// Commit-msg: the message up to the verbose diff below the scissors. Comment
// lines are dropped only when the configured cleanup mode drops them; anything
// else (an unknown or "auto" comment char) keeps every line.
export function scanMessage({ message, privateRulesFile, cleanup = "", commentChar = "#" }) {
  const rules = combinedRules(privateRulesFile);
  const known = commentChar.length === 1 ? escapeRegExp(commentChar) : null;
  let text = known ? message.split(new RegExp(`^${known} -+ >8 -+$`, "m"))[0] : message;
  if (known && cleanup === "strip") text = text.replace(new RegExp(`^${known}.*$`, "gm"), "");
  return withTemp((tmp) => {
    // With commit.cleanup strip, comment lines are blank already. Unset or default
    // strips them from an editor message, so a comment block after the sign-off
    // does not end the trailer block (the comments are still scanned, and pre-push
    // scans the final message). Other modes publish them, so they end it.
    const editorStrips = !!known && (cleanup === "" || cleanup === "default");
    fs.writeFileSync(
      path.join(tmp, "message.txt"),
      withoutMaintainerSignoff(text, (line) => editorStrips && line.startsWith(commentChar)),
    );
    return scan(tmp, new Map(), { strict: true, rules });
  });
}

// The private inventory never leaves this machine and is never printed. A clone
// that requires the private rules takes it only from outside the tree, so a
// committed file can never satisfy or replace them. `required` is asked only
// when no inventory exists outside the tree.
export function findInventory({ env = process.env, cwd, required = () => false } = {}) {
  if (env.CODESENSE_PRIVACY_TERMS) return env.CODESENSE_PRIVACY_TERMS;
  const user = env.HOME && path.join(env.HOME, ".config", "codesense", "privacy-terms.json");
  if (user && readableFile(user)) return user;
  if (required()) return null;
  const top = tryGit(["rev-parse", "--show-toplevel"], cwd);
  const repo = top.status === 0 && path.join(top.stdout.trim(), "release", "privacy-terms.json");
  return repo && readableFile(repo) ? repo : null;
}

// As in fallback.sh: an inventory location counts only as a readable file.
function readableFile(file) {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Redacted summary: rule ids and counts only, never the matched text.
function hookReport(findings, show) {
  if (show) return report(findings, { show: true });
  const errors = findings.filter((f) => f.sev === "error" && !f.allowed);
  const counts = new Map();
  for (const finding of errors) counts.set(finding.rule, (counts.get(finding.rule) ?? 0) + 1);
  for (const [rule, count] of counts) console.error(`privacy-scan: ${rule} x${count}`);
  return errors.length === 0;
}

const HOOK_FIX =
  "Rewrite the text (amend the message, rename the branch, edit the line); never --no-verify.";
const INVENTORY_FIX =
  "privacy-scan: no private term inventory, and this clone requires one. Set " +
  "CODESENSE_PRIVACY_TERMS or place it at ~/.config/codesense/privacy-terms.json.";
const PUBLIC_NOTICE = "privacy hook: public rules only; no private inventory";

// A git config boolean: set and not readable as false (unparseable included) is true.
function gitBoolean(cwd, key, override = []) {
  const read = tryGit([...override, "config", "--bool", "--get", key], cwd);
  return read.status !== 1 && read.stdout.trim() !== "false";
}

// A maintainer clone opts in to the private rules; nothing public sets it.
// Both the env value and git config are read as git booleans, like fallback.sh:
// set and not readable as false (unparseable included) means required.
function privacyRequired(env, cwd) {
  const key = "codesense.privacyRequired";
  const flag = env.CODESENSE_PRIVACY_REQUIRED;
  return (!!flag && gitBoolean(cwd, key, ["-c", `${key}=${flag}`])) || gitBoolean(cwd, key);
}

// The new commits and tags a public push may carry: 200 by default, or a
// non-negative integer from the env. null for any other value (fail closed).
function maxNewCommits(env) {
  const value = env.CODESENSE_PRIVACY_MAX_NEW_COMMITS ?? "";
  if (!value) return 200;
  const max = /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(max) && max < 2 ** 31 - 1 ? max : null;
}

export function runHook(kind, args, { env = process.env, cwd = process.cwd(), stdin = "" } = {}) {
  const extra = env.CODESENSE_PRIVACY_PUBLIC_REMOTES ?? "";
  if (kind === "pre-push") {
    const [remote, url] = args;
    if (!remote || !isPublicRemote(url ?? remote, extra)) return 0;
  } else if (kind === "commit-msg") {
    const urls = tryGit(["remote", "-v"], cwd);
    if (urls.status !== 0) {
      console.error("privacy-scan: cannot list remotes");
      return 1;
    }
    const publicRemote = urls.stdout
      .split("\n")
      .filter(Boolean)
      .some((line) => isPublicRemote(line.split(/\s+/)[1] ?? "", extra));
    if (!publicRemote) return 0;
  } else throw new Error();
  // Without an inventory, the generic and structural rules still run, as in CI.
  let required = false;
  const privateRulesFile = findInventory({
    env,
    cwd,
    required: () => (required = privacyRequired(env, cwd)),
  });
  if (!privateRulesFile) {
    if (required) {
      console.error(INVENTORY_FIX);
      return 1;
    }
    console.error(PUBLIC_NOTICE);
  }
  if (kind === "commit-msg") {
    const findings = scanMessage({
      message: fs.readFileSync(args[0], "utf8"),
      privateRulesFile,
      cleanup: tryGit(["config", "--get", "commit.cleanup"], cwd).stdout.trim(),
      commentChar: tryGit(["config", "--get", "core.commentChar"], cwd).stdout.trim() || "#",
    });
    return blockedReport(findings, "commit", env);
  }
  const maxNewObjects = maxNewCommits(env);
  if (maxNewObjects === null) {
    console.error("privacy-scan: invalid CODESENSE_PRIVACY_MAX_NEW_COMMITS");
    return 1;
  }
  try {
    const findings = scanPush({
      cwd,
      url: args[1] ?? args[0],
      updates: stdin,
      privateRulesFile,
      maxNewObjects,
      requireSigned: gitBoolean(cwd, "codesense.requireSigned"),
      progress: (done, total) => console.error(`privacy-scan: scanned ${done}/${total} commits`),
    });
    return blockedReport(findings, "push", env);
  } catch (error) {
    if (!(error instanceof PushRefused)) throw error;
    console.error(error.message);
    return 1;
  }
}

// 0 when clean; otherwise the redacted summary and the fix, and 1.
function blockedReport(findings, what, env) {
  if (hookReport(findings, env.CODESENSE_PRIVACY_SHOW === "1")) return 0;
  console.error(`privacy-scan: blocked a ${what} to a public remote. ${HOOK_FIX}`);
  return 1;
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    if (args[0] === "--hook") {
      process.exitCode = runHook(args[1], args.slice(2), {
        stdin: args[1] === "pre-push" ? fs.readFileSync(0, "utf8") : "",
      });
    } else {
      for (let i = 0; i < args.length; i++) {
        const key = args[i];
        if (options[key]) throw new Error();
        if (key === "--show" || key === "--stale-warn") options[key] = true;
        else {
          if (!["--private-rules", "--allow"].includes(key) || !args[i + 1]) throw new Error();
          options[key] = args[++i];
        }
      }
      const staleWarn = options["--stale-warn"] === true;
      const show = options["--show"] === true;
      const findings = scanChange({
        cwd: process.cwd(),
        base: process.env.SCAN_BASE,
        head: process.env.SCAN_HEAD,
        defaultBranch: process.env.DEFAULT_BRANCH,
        branch: process.env.SCAN_BRANCH,
        metadata: process.env.PR_METADATA_FILE,
        privateRulesFile: options["--private-rules"],
        allowFile: options["--allow"] ?? DEFAULT_ALLOW,
        staleWarn,
      });
      if (staleWarn) {
        const stale = findings.filter((f) => f.stale === true);
        // An entry names a rule, a path and a fingerprint, never a matched value.
        if (show) for (const f of stale) console.log(`STALE ${f.file} ${f.shown}`);
        console.log(`privacy-scan: stale allow entries=${stale.length} (warnings)`);
      }
      process.exitCode = report(findings, { show }) ? 0 : 1;
    }
  } catch (error) {
    console.error(
      [GITLINK_ERROR, INVENTORY_ERROR].includes(error.message)
        ? error.message
        : "privacy-scan: unable to complete change scan",
    );
    process.exitCode = 1;
  }
}
