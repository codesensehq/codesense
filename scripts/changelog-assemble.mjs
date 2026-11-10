#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Folds the changelog fragments in changes/ into CHANGELOG.md and deletes them.
//
//   node scripts/changelog-assemble.mjs                       # into [Unreleased]
//   node scripts/changelog-assemble.mjs --version 0.1.1 --date 2026-11-20
//   node scripts/changelog-assemble.mjs --dry-run [...]       # print, change nothing
//
// With --version, the [Unreleased] content becomes the release's section. Write the release's
// summary paragraph under ## [Unreleased] before running it; the release check reads it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FRAGMENT_DIR, assembleChangelog, readFragments } from "./lib/changelog-fragments.mjs";

export function parseArgs(argv) {
  const options = { dryRun: false, root: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (["--version", "--date", "--root"].includes(arg) && argv[i + 1])
      options[arg.slice(2)] = argv[++i];
    else
      throw new Error(
        `usage: changelog-assemble.mjs [--version X.Y.Z --date YYYY-MM-DD] [--dry-run] [--root dir] (bad argument ${arg})`,
      );
  }
  if (options.version && !options.date) throw new Error("--version needs --date");
  if (options.date && !options.version) throw new Error("--date needs --version");
  return options;
}

export function run(options) {
  const root = options.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = path.join(root, FRAGMENT_DIR);
  const { fragments, errors } = readFragments(dir);
  if (errors.length) throw new Error(errors.map((e) => `${FRAGMENT_DIR}/${e}`).join("\n"));
  const file = path.join(root, "CHANGELOG.md");
  const text = assembleChangelog(fs.readFileSync(file, "utf8"), fragments, options);
  if (options.dryRun) return { text, fragments };
  fs.writeFileSync(file, text);
  for (const { name } of fragments) fs.rmSync(path.join(dir, name));
  return { text, fragments };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { text, fragments } = run(options);
    if (options.dryRun) process.stdout.write(text);
    else console.error(`changelog: folded ${fragments.length} fragment(s) into CHANGELOG.md`);
  } catch (error) {
    console.error(`changelog: ${error.message}`);
    process.exitCode = 1;
  }
}
