// SPDX-License-Identifier: MIT
// Developer Certificate of Origin check for a pull request: every non-merge
// commit in DCO_BASE..DCO_HEAD needs a Signed-off-by trailer with its author's
// email. Dependabot cannot sign off: its bot-email commits are exempt, but only
// on a pull request that Dependabot opened.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { git, revision } from "./ci-scan-range.mjs";

const DEPENDABOT = "dependabot[bot]";
const BOT_EMAIL = /^(?:\d+\+)?dependabot\[bot\]@users\.noreply\.github\.com$/;
// "Name <email>", optionally followed by a comment such as "(rebased)".
const emailOf = (signoff) => /<([^<>]+)>[^<>]*$/.exec(signoff)?.[1].trim().toLowerCase();

// Returns the commits in base..head whose author has not signed off.
export function unsignedCommits({ cwd, base, head, prAuthor = "" }) {
  const botExempt = prAuthor === DEPENDABOT;
  try {
    revision(base, "base");
    revision(head, "head");
  } catch (error) {
    throw new Error(error.message.replace(/^scan-range:/, "dco:"));
  }
  let log;
  try {
    log = git(
      [
        "log",
        "-z",
        "--no-merges",
        "--format=%H%x1e%ae%x1e%(trailers:key=Signed-off-by,valueonly,separator=%x1f)",
        `${base}..${head}`,
      ],
      cwd,
    );
  } catch (error) {
    throw new Error(
      `dco: cannot read the commit range: ${error.stderr?.toString().trim() || error.message}`,
    );
  }
  return log
    .split("\0")
    .filter(Boolean)
    .flatMap((record) => {
      const [sha, email, signoffs = ""] = record.split("\x1e");
      const author = email.trim().toLowerCase();
      const signed =
        author &&
        ((botExempt && BOT_EMAIL.test(author)) ||
          signoffs.split("\x1f").map(emailOf).includes(author));
      return signed ? [] : [{ sha, author }];
    });
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const unsigned = unsignedCommits({
      cwd: process.cwd(),
      base: process.env.DCO_BASE,
      head: process.env.DCO_HEAD,
      prAuthor: process.env.DCO_PR_AUTHOR,
    });
    if (unsigned.length) {
      console.error("dco: these commits have no Signed-off-by matching the author email:");
      for (const { sha, author } of unsigned)
        console.error(`  ${sha.slice(0, 12)} ${author || "(no author email)"}`);
      console.error("Sign them off with: git rebase --signoff <base>, then push again.");
      process.exitCode = 1;
    } else console.log("dco: every commit is signed off");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
