#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Public CI and local pre-push scanning: tree, each commit's additions and metadata.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scan, scanAddedFiles, loadAllow, where } from "./privacy-engine.mjs";
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

// The comment string git config fixes for an editor commit, or null when it is
// not certain: no entry means #, and every core.commentChar/commentString
// entry having the same value (never auto, which git picks per message) means
// that value.
export function certainComment(values) {
  if (!values.length) return "#";
  const [first] = values;
  return first && first !== "auto" && values.every((v) => v === first) ? first : null;
}

// What commit-msg knows about the message file: its text, whether an editor ran
// (git sets GIT_EDITOR=: for the hook when none does), the certain comment
// string and commit.cleanup from config. The command line's --cleanup and -v
// stay unseen, so only the trailer-block lookup interprets the file.
function messageForm(file, env, cwd) {
  const values = tryGit(["config", "--get-regexp", "^core\\.comment(char|string)$"], cwd)
    .stdout.split("\n")
    .filter(Boolean)
    .map((line) => (line.includes(" ") ? line.slice(line.indexOf(" ") + 1) : ""));
  return {
    message: fs.readFileSync(file, "utf8"),
    editor: env.GIT_EDITOR !== ":",
    comment: certainComment(values),
    cleanup: tryGit(["config", "--get", "commit.cleanup"], cwd).stdout.trim(),
  };
}

// The message as the trailer-block lookup reads it: `head` (where the trailer
// block is), `tail` (from git's scissors line) and `skip` (git's comment
// lines), with head + tail === message. Only an editor commit with a certain
// comment string cuts at the scissors line, and skips comment lines when
// commit.cleanup is unset, default or strip; anything else reads the file as
// is, so a sign-off followed by text git might keep is refused, never accepted.
export function trailerView({ message, editor = false, comment = null, cleanup = "" }) {
  const raw = { head: message, tail: "", skip: () => false };
  if (!editor || !comment) return raw;
  const scissors = `${comment} ------------------------ >8 ------------------------`;
  const lines = message.split("\n");
  const at = lines.indexOf(scissors);
  const cutAt = at < 0 ? message.length : lines.slice(0, at).join("\n").length + (at && 1);
  const strips = ["", "default", "strip"].includes(cleanup);
  return {
    head: message.slice(0, cutAt),
    tail: message.slice(cutAt),
    skip: strips ? (line) => line.startsWith(comment) : () => false,
  };
}

// The first scissors-shaped line (1-based), whatever its comment string, or
// Infinity: a finding at or below it may be in a -v diff the hook cannot see.
const SCISSORS = /^\S+ -+ >8 -+$/;
function scissorsLine(message) {
  const at = message.split("\n").findIndex((line) => SCISSORS.test(line));
  return at < 0 ? Infinity : at + 1;
}

// Commit-msg: every line of git's message file, comments and any -v diff
// included, since the hook cannot see which lines git drops. Only the
// maintainer's sign-off in the trailer block is masked.
export function scanMessage({ form, privateRulesFile }) {
  const rules = combinedRules(privateRulesFile);
  const { head, tail, skip } = trailerView(form);
  const below = scissorsLine(form.message);
  return withTemp((tmp) => {
    fs.writeFileSync(path.join(tmp, "message.txt"), withoutMaintainerSignoff(head, skip) + tail);
    return scan(tmp, new Map(), { strict: true, rules }).map((f) =>
      f.line >= below ? { ...f, verbose: true } : f,
    );
  });
}

// Commit-msg in a maintainer clone (codesense.requireSigned): the commit being
// made has the maintainer's identity as author and committer (as git var sees
// them, so --author, --amend and GIT_* overrides count), their sign-off in the
// trailer block, no AI co-author trailer on any line, and signing on. The hook
// cannot see -S, so signing is commit.gpgsign plus a key source; this checks
// the config, not the signature, which pre-push checks. Places name no person.
export function commitFindings(cwd, form) {
  const findings = [];
  const found = (rule, place) =>
    findings.push({ rule, sev: "error", place, allowed: false, source: "commit" });
  const identity = (name) => tryGit(["var", name], cwd).stdout.replace(/ \d+ [+-]\d{4}\n?$/, "");
  if (identity("GIT_AUTHOR_IDENT") !== MAINTAINER_IDENTITY) found("author-identity", "author");
  if (identity("GIT_COMMITTER_IDENT") !== MAINTAINER_IDENTITY)
    found("committer-identity", "committer");
  const { head, skip } = trailerView(form);
  if (withoutMaintainerSignoff(head, skip) === head) found("missing-signoff", "trailers");
  for (const [i, line] of form.message.split("\n").entries())
    if (AI_CO_AUTHOR.test(line)) found("ai-co-author", `message:${i + 1}`);
  const config = (key) => tryGit(["config", "--get", key], cwd).stdout.trim();
  // openpgp (the default) and x509 pick a key by the committer's email.
  const keyed =
    config("user.signingkey") !== "" ||
    config("gpg.format").toLowerCase() !== "ssh" ||
    config("gpg.ssh.defaultKeyCommand") !== "";
  if (tryGit(["config", "--bool", "--get", "commit.gpgsign"], cwd).stdout.trim() !== "true")
    found("signing-config", "commit.gpgsign");
  else if (!keyed) found("signing-config", "user.signingkey");
  return findings;
}

// Commit-msg: what the commit being made adds, with the same engine and
// allow-list as pre-push. The index is the one git uses for this commit (a
// temporary GIT_INDEX_FILE under commit -a or a pathspec), compared with HEAD,
// or the empty tree on an unborn branch; under --amend that is the amend's own
// change. A merge in progress is skipped (null): pre-push scans its
// resolutions. A gitlink, a malformed allow-list or any other failure is one
// finding of the hook's own rule (`hook`, with its place). Each finding
// carries `index` and `count`: the file's position in, and the length of, the
// commit's file list (`git diff --cached --name-only` under the same index),
// so a report can place it without naming it.
export function scanStaged({ cwd, privateRulesFile, allowFile = DEFAULT_ALLOW }) {
  const rules = combinedRules(privateRulesFile);
  const refuse = (rule, place = "the staged changes") => [
    { rule, sev: "error", file: "", line: 0, allowed: false, hook: true, place },
  ];
  let files, order;
  try {
    const gitPath = (name) =>
      git(["rev-parse", "--path-format=absolute", "--git-path", name], cwd).trim();
    if (fs.existsSync(gitPath("MERGE_HEAD"))) return null;
    // With no commit, --cached compares the index with HEAD, or with the empty
    // tree on an unborn branch.
    const changed = sideAdditions(cwd, ["diff", "--cached"]);
    const blobs = commitBlobs(
      cwd,
      [...changed.values()].map(({ oid }) => oid),
    );
    files = [...changed].map(([file, { oid, lineNumbers }]) => ({
      file,
      data: blobs.get(oid),
      lineNumbers,
    }));
    order = git(["diff", "--cached", "--name-only", "-z", "--"], cwd).split("\0").filter(Boolean);
  } catch (error) {
    return refuse(error.message === GITLINK_ERROR ? "gitlink" : "scan-error");
  }
  let allow;
  try {
    allow = loadAllow(allowFile, ruleIds(rules));
  } catch {
    return refuse("allow-file", "the allow-list");
  }
  try {
    return scanAddedFiles(files, allow, { rules }).map((f) => ({
      ...f,
      index: order.indexOf(f.file) + 1 || null,
      count: order.length,
    }));
  } catch {
    return refuse("scan-error");
  }
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

// Commit-msg's fixes: one fixed string each, pinned by tests. The commit was
// never made, so each fix is a rerun, never an amend (except resetting an
// amended commit's author). The hook cannot see the command that ran it, so a
// fix names no git commit command of its own: the committer reruns theirs.
const MAINTAINER_SETUP = "the maintainer clone setup in CONTRIBUTING.md (AI assistance)";
const IDENTITY = `set to the maintainer's GitHub login and noreply address as in ${MAINTAINER_SETUP}`;

// A content rule (public or private) takes the fix for where it was found.
export const LOCATION_FIX = Object.freeze({
  message:
    "rerun your git commit command with the message reworded, keeping its -a, pathspec or --amend; " +
    "for a line in git's own comments, rename the branch or file instead; " +
    "an editor message is kept in the file git rev-parse --git-path COMMIT_EDITMSG names, to copy from",
  verbose:
    "rerun your git commit command without -v (--no-verbose if commit.verbose is set), " +
    "or with the text below the scissors line reworded; the hook can't see -v, so it scans the verbose diff git would cut",
  content: "rerun with the line edited and the file staged again (git add)",
  path: "rerun with the file renamed (git mv)",
});

// Each rule with a fix of its own: the structural rules, and every rule
// commit-msg itself reports, which must have one.
export const FIX = Object.freeze({
  "forbidden-path": "rerun with the file unstaged (git rm --cached)",
  "key-file": "rerun with the key file unstaged (git rm --cached)",
  "image-metadata": "rerun with the image's metadata stripped and the file staged again (git add)",
  gitlink: "rerun with the gitlink unstaged (git rm --cached); submodules are not supported",
  "scan-error":
    "rerun with the index checked (git status, git diff --cached --stat); report the hook if it repeats",
  "allow-file": "rerun with the malformed entry in scripts/privacy-scan.allow fixed",
  "author-identity": `rerun with user.name and user.email ${IDENTITY}, and no --author or GIT_AUTHOR_* override; for an amended commit, rerun with --amend --reset-author`,
  "committer-identity": `rerun with user.name and user.email ${IDENTITY}, and no GIT_COMMITTER_* override`,
  "missing-signoff":
    "rerun with -s (git commit -s) as the maintainer identity and nothing after its Signed-off-by line; " +
    "in an editor commit under core.commentChar auto, core.commentString, or a commit.cleanup that keeps comments, " +
    "commit with -m or -F instead",
  "ai-co-author": "rerun with the AI Co-authored-by line removed from the message",
  "signing-config":
    "rerun with git config commit.gpgsign true and a key (user.signingkey, or gpg.ssh.defaultKeyCommand for ssh); " +
    "this checks the config, not the signature, and needs commit.gpgsign because the hook cannot see -S",
});

// A rule commit-msg reports itself (a commit check, or the staged scan's own)
// has no fallback: a missing fix throws, which the guard test catches.
export function fixFor(finding) {
  if (Object.hasOwn(FIX, finding.rule)) return FIX[finding.rule];
  if (finding.source === "commit" || finding.hook) throw new Error(`no fix for ${finding.rule}`);
  if (finding.source !== "staged")
    return finding.verbose ? LOCATION_FIX.verbose : LOCATION_FIX.message;
  return finding.path ? LOCATION_FIX.path : LOCATION_FIX.content;
}

// Where a commit-msg finding is. By default a staged file is named only by its
// position in the commit's file list, since even a filename can carry private
// data; `show` names it, and adds a show-kind rule's match.
export function placeOf(finding, show = false) {
  const shown = show && finding.shown ? ` ${finding.shown}` : "";
  if (finding.source === "commit") return `${finding.place}${shown}`;
  if (finding.source !== "staged") return `message:${finding.line}${shown}`;
  if (finding.hook) return finding.place;
  if (show) return `${finding.path ? finding.file : where(finding)}${shown}`;
  if (finding.path) return "a staged path";
  const of = finding.count ? ` of ${finding.count}` : "";
  const file = finding.index ? `staged file ${finding.index}${of}` : "a staged file";
  if (finding.offset !== undefined) return `${file}, byte ${finding.offset}`;
  return finding.line ? `${file}, line ${finding.line}` : file;
}

// Commit-msg: one `rule  place  fix` line per unresolved error, then the rule.
function commitReport(findings, show) {
  const errors = findings.filter((f) => f.sev === "error" && !f.allowed);
  for (const f of errors)
    console.error(`privacy-scan: ${f.rule}  ${placeOf(f, show)}  ${fixFor(f)}`);
  if (!errors.length) return 0;
  console.error(
    "privacy-scan: refused this commit; nothing was committed. Fix each line above and " +
      "rerun the same git commit command. Never --no-verify.",
  );
  return 1;
}

const HOOK_FIX =
  "Rewrite the text (amend the message, rename the branch, edit the line); never --no-verify.";
const INVENTORY_FIX =
  "privacy-scan: no private term inventory, and this clone requires one. Set " +
  "CODESENSE_PRIVACY_TERMS or place it at ~/.config/codesense/privacy-terms.json.";
const PUBLIC_NOTICE = "privacy hook: public rules only; no private inventory";
const MERGE_NOTICE =
  "privacy hook: skipped the staged scan during a merge; pre-push scans what it adds";

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
    const form = messageForm(args[0], env, cwd);
    const findings = scanMessage({ form, privateRulesFile });
    const staged = scanStaged({ cwd, privateRulesFile });
    if (staged === null) console.error(MERGE_NOTICE);
    else findings.push(...staged.map((f) => ({ ...f, source: "staged" })));
    if (gitBoolean(cwd, "codesense.requireSigned")) findings.push(...commitFindings(cwd, form));
    return commitReport(findings, env.CODESENSE_PRIVACY_SHOW === "1");
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
