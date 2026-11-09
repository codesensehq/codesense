// SPDX-License-Identifier: MIT
// Commit email audit: every commit's author and committer email must be a
// project identity or a GitHub noreply address. Commits GitHub creates (merges,
// the merge queue, "Update branch") take the acting account's primary email,
// so a personal address can reach main without passing through a local hook.
// A violation prints only the short SHA and the field, never an email or name.
//
//   node scripts/commit-email-audit.mjs [--hours N]   commits on HEAD from the last N hours (26)
//   node scripts/commit-email-audit.mjs <base>..<head>
//   node scripts/commit-email-audit.mjs --all         the full history of HEAD, with counts
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { git } from "./ci-scan-range.mjs";

// Every allowed identity, compared case-insensitively. The release identity
// signs release commits, the maintainers identity made the public export, and
// CI commits as the security identity inside its runners.
export const ALLOWED_EMAILS = Object.freeze({
  patterns: [/^[^@\s]+@users\.noreply\.github\.com$/],
  exact: [
    "noreply@github.com",
    "49699333+dependabot[bot]@users.noreply.github.com",
    "release@codesense.ai",
    "maintainers@codesense.ai",
    "security@codesense.ai",
  ],
});

export const DEFAULT_HOURS = 26;

export const allowedEmail = (email) => {
  const value = email.toLowerCase();
  return (
    ALLOWED_EMAILS.exact.includes(value) || ALLOWED_EMAILS.patterns.some((re) => re.test(value))
  );
};

// The rev-list arguments for one of the three modes; refs never start an option.
export function revisionArgs({ all = false, range, hours = DEFAULT_HOURS, now = Date.now() }) {
  if (all) return ["HEAD"];
  if (range !== undefined) {
    if (!/^[^\s-][^\s]*\.\.[^\s-][^\s]*$/.test(range) || range.includes("..."))
      throw new Error("commit-email-audit: the range must be <base>..<head>");
    return [range];
  }
  if (!Number.isFinite(hours) || hours <= 0)
    throw new Error("commit-email-audit: --hours must be a positive number");
  return [`--since=${new Date(now - hours * 3_600_000).toISOString()}`, "HEAD"];
}

// [{ sha, field }] for each disallowed email, and the number of commits read.
// NUL separates the fields: git identities cannot contain it.
export function auditCommits({ cwd, ...mode }) {
  const out = git(
    [
      "-c",
      "log.showSignature=false",
      "log",
      "-z",
      "--no-color",
      "--no-mailmap",
      "--format=%h%x00%ae%x00%ce",
      ...revisionArgs(mode),
      "--",
    ],
    cwd,
    "commit-email-audit: cannot read the commits",
  );
  const fields = out ? out.replace(/\0$/, "").split("\0") : [];
  if (fields.length % 3) throw new Error("commit-email-audit: unexpected git output");
  const violations = [];
  for (let i = 0; i < fields.length; i += 3) {
    const [sha, author, committer] = fields.slice(i, i + 3);
    if (!allowedEmail(author)) violations.push({ sha, field: "author" });
    if (!allowedEmail(committer)) violations.push({ sha, field: "committer" });
  }
  return { violations, checked: fields.length / 3 };
}

export function parseArgs(argv) {
  const mode = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") mode.all = true;
    else if (arg === "--hours") {
      if (!/^\d+(?:\.\d+)?$/.test(argv[i + 1] ?? ""))
        throw new Error("commit-email-audit: --hours needs a number");
      mode.hours = Number(argv[++i]);
    } else if (!arg.startsWith("-") && mode.range === undefined) mode.range = arg;
    else throw new Error("usage: commit-email-audit.mjs [--hours N | <base>..<head> | --all]");
  }
  if ([mode.all, mode.range !== undefined, mode.hours !== undefined].filter(Boolean).length > 1)
    throw new Error("commit-email-audit: use one of --hours, a range or --all");
  return mode;
}

export function main(argv, cwd = process.cwd()) {
  try {
    const mode = parseArgs(argv);
    const { violations, checked } = auditCommits({ cwd, ...mode });
    for (const { sha, field } of violations) console.log(`${sha} ${field}`);
    if (mode.all) {
      const commits = new Set(violations.map(({ sha }) => sha)).size;
      console.log(`commit-email-audit: ${commits} of ${checked} commits have a disallowed email`);
    } else if (!violations.length) console.log(`commit-email-audit: ${checked} commits OK`);
    return violations.length ? 1 : 0;
  } catch (error) {
    // Our own messages only: git's stderr is not echoed.
    console.error(
      error.message.startsWith("commit-email-audit") || error.message.startsWith("usage")
        ? error.message
        : "commit-email-audit: failed",
    );
    return 2;
  }
}

// A realpath guard keeps imports inert, including when /tmp is a symlink on macOS.
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
)
  process.exitCode = main(process.argv.slice(2));
