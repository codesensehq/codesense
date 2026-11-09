#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Checks the changelog fragments in changes/ (see scripts/lib/changelog-fragments.mjs).
// Every run checks their format. On a pull request (CHANGELOG_EVENT=pull_request) it also
// requires a new fragment when the app's source changed, unless the pull request has the
// no-changelog label or a bot opened it. A merge group checks the format only, so this is
// safe as a required check.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git, revision } from "./ci-scan-range.mjs";
import { FRAGMENT_DIR, readFragments } from "./lib/changelog-fragments.mjs";

export const NO_CHANGELOG_LABEL = "no-changelog";
// Paths users can notice a change in. Tests under them don't count.
const SOURCE = /^(?:src|src-tauri|src-emulator)\//;
const TEST =
  /(?:^|\/)(?:tests?|__tests__|fixtures?)\/|\.(?:test|spec|node-test)\.[cm]?[jt]sx?$|(?:^|\/)tests?\.rs$|_tests?\.rs$/;

export const isUserFacing = (file) => SOURCE.test(file) && !TEST.test(file);

// Decides whether a pull request needs a fragment. changes is git diff --name-status output
// lines ("A\tchanges/x.md"). Returns an error message, or "" when the pull request passes.
export function presenceError({ changes, labels = [], author = "" }) {
  if (author.endsWith("[bot]")) return "";
  if (labels.includes(NO_CHANGELOG_LABEL)) return "";
  const rows = changes.map((line) => line.split("\t"));
  const fragment = new RegExp(`^${FRAGMENT_DIR}/(?!README\\.md$)[^/]+\\.md$`);
  if (rows.some(([status, file]) => status !== "D" && fragment.test(file))) return "";
  // A release pull request assembles the fragments into CHANGELOG.md itself.
  if (rows.some(([, file]) => file === "CHANGELOG.md")) return "";
  const source = rows.map(([, file]) => file).filter(isUserFacing);
  if (!source.length) return "";
  return (
    `This pull request changes the app (${source.slice(0, 3).join(", ")}${source.length > 3 ? ", …" : ""}) ` +
    `but adds no changelog entry. Add ${FRAGMENT_DIR}/<slug>.md (see ${FRAGMENT_DIR}/README.md), ` +
    `or ask a maintainer for the ${NO_CHANGELOG_LABEL} label if users won't notice the change.`
  );
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { fragments, errors } = readFragments(path.join(root, FRAGMENT_DIR));
  for (const error of errors) console.error(`changelog: ${FRAGMENT_DIR}/${error}`);
  if (errors.length) return 1;

  if (process.env.CHANGELOG_EVENT === "pull_request") {
    const base = revision(process.env.CHANGELOG_BASE, "base");
    const head = revision(process.env.CHANGELOG_HEAD, "head");
    const changes = git(["diff", "--name-status", "--no-renames", `${base}...${head}`], root)
      .split("\n")
      .filter(Boolean);
    let labels = [];
    try {
      labels = JSON.parse(process.env.CHANGELOG_LABELS || "[]").map((label) => label.name ?? label);
    } catch {
      console.error("changelog: CHANGELOG_LABELS is not JSON");
      return 1;
    }
    const error = presenceError({ changes, labels, author: process.env.CHANGELOG_AUTHOR ?? "" });
    if (error) {
      console.error(`changelog: ${error}`);
      return 1;
    }
  }
  console.log(`changelog: ${fragments.length} fragment(s) OK`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main();
