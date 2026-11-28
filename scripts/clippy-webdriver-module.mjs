// SPDX-License-Identifier: MIT
// Judges a `cargo clippy --features e2e-webdriver --message-format=json` run for the webdriver-only
// module (`src-tauri/src/windows/e2e`, the module webdriver_cfg_guard.rs keeps behind the feature):
// any warning or lint in it fails, as does a compile error in the app crate, any error in a crate
// the app crate needs, or a build that did not finish. It fails closed: unless the JSON shows the
// app crate itself was checked, the module was never linted. Lints elsewhere in the app crate are
// left to their own owners: no job lints the whole tree with `-D warnings`.
// Usage: node scripts/clippy-webdriver-module.mjs <clippy json file>
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const MODULE = /(?:^|\/)src-tauri\/src\/windows\/e2e(?:\.rs$|\/)/;
/** The app crate's lib or bin root, whose check is what lints the module. */
const APP_ROOT = /(?:^|\/)src-tauri\/src\/(?:lib|main)\.rs$/;

/** The problems in `text`, cargo's JSON lines, one line per problem. */
export function clippyProblems(text) {
  const problems = [];
  let finished = null;
  let appChecked = false;
  let lintedElsewhere = false;
  for (const line of text.split("\n")) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.reason === "build-finished") finished = record.success === true;
    const inApp = APP_ROOT.test(String(record?.target?.src_path ?? ""));
    if (record?.reason === "compiler-artifact" && inApp) appChecked = true;
    if (record?.reason !== "compiler-message") continue;
    if (inApp) appChecked = true;
    const { level, message, code, spans = [] } = record.message ?? {};
    if (level !== "warning" && level !== "error") continue;
    const span = spans.find((s) => s.is_primary) ?? spans[0];
    const where = span ? `${span.file_name}:${span.line_start}` : null;
    const lint = String(code?.code ?? "").startsWith("clippy::");
    if (span && MODULE.test(span.file_name)) problems.push(`${where}: ${level}: ${message}`);
    else if (level !== "error" || !where) continue;
    else if (!inApp) {
      const crate = record.target?.name ?? "a dependency";
      problems.push(`${where}: error in ${crate}, which the app crate needs: ${message}`);
    } else if (lint) lintedElsewhere = true;
    else problems.push(`${where}: ${level}: ${message}`);
  }
  if (finished === null) problems.push("clippy did not finish: no build-finished line");
  else if (!finished && problems.length === 0 && !lintedElsewhere)
    problems.push("the build failed and no diagnostic says why");
  if (!appChecked)
    problems.push(
      "the app crate (src-tauri/src/lib.rs) was never checked, so the module was not linted",
    );
  return problems;
}

function main(argv) {
  if (argv.length !== 1) {
    console.error("usage: clippy-webdriver-module.mjs <clippy json file>");
    return 2;
  }
  const problems = clippyProblems(fs.readFileSync(argv[0], "utf8"));
  for (const problem of problems) console.error(problem);
  if (problems.length === 0) console.log("webdriver module: clippy clean");
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
