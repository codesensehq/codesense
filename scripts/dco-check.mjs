// SPDX-License-Identifier: MIT
// Developer Certificate of Origin check for a pull request: every non-merge
// commit in DCO_BASE..DCO_HEAD needs a Signed-off-by trailer with its author's
// email. Dependabot cannot sign off: its bot-email commits are exempt, but only
// on a pull request that Dependabot opened. A merge group (DCO_EVENT=merge_group)
// has no pull request author, so the exemption there is derived per queued pull
// request: see dependabotCommits.
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

// The merge queue merges each entry with a merge commit on the first-parent
// chain whose second parent is that pull request's head. Of the unsigned
// commits in `candidates`, returns those under the head of a pull request that
// `authorOf(head sha)` says Dependabot opened. Anything else stays unsigned.
export async function dependabotCommits({ cwd, base, head, candidates, authorOf }) {
  const exempt = new Set();
  if (!candidates.size) return exempt;
  const entries = git(["log", "--first-parent", "--merges", "--format=%P", `${base}..${head}`], cwd)
    .split("\n")
    .filter(Boolean)
    .map((parents) => parents.split(" "));
  for (const [parent, pull] of entries) {
    const under = git(["rev-list", "--no-merges", `${parent}..${pull}`], cwd)
      .split("\n")
      .filter((sha) => candidates.has(sha));
    if (!under.length || (await authorOf(pull)) !== DEPENDABOT) continue;
    for (const sha of under) exempt.add(sha);
  }
  return exempt;
}

// The login of whoever opened the pull requests whose head is `sha`, or "" when
// none or several people did.
export async function pullAuthor(sha, env = process.env) {
  const api = env.GITHUB_API_URL || "https://api.github.com";
  const response = await fetch(`${api}/repos/${env.GITHUB_REPOSITORY}/commits/${sha}/pulls`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok)
    throw new Error(`dco: cannot look up the pull request for ${sha}: HTTP ${response.status}`);
  const authors = new Set(
    (await response.json())
      .filter((pull) => pull.head?.sha === sha)
      .map((pull) => pull.user?.login),
  );
  return authors.size === 1 ? [...authors][0] : "";
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const range = {
      cwd: process.cwd(),
      base: process.env.DCO_BASE,
      head: process.env.DCO_HEAD,
    };
    let unsigned = unsignedCommits({ ...range, prAuthor: process.env.DCO_PR_AUTHOR });
    if (process.env.DCO_EVENT === "merge_group") {
      const candidates = new Set(
        unsigned.filter(({ author }) => BOT_EMAIL.test(author)).map(({ sha }) => sha),
      );
      const exempt = await dependabotCommits({ ...range, candidates, authorOf: pullAuthor });
      unsigned = unsigned.filter(({ sha }) => !exempt.has(sha));
    }
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
