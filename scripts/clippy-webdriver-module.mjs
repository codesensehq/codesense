// SPDX-License-Identifier: MIT
// Judges a `cargo clippy --features e2e-webdriver --message-format=json` run for the webdriver-only
// module (`src-tauri/src/windows/e2e`, the module webdriver_cfg_guard.rs keeps behind the feature):
// any warning or lint in it fails, as does a compile error anywhere or a build that did not finish.
// Lints elsewhere are left to their own owners: no job lints the whole tree with `-D warnings`.
// Usage: node scripts/clippy-webdriver-module.mjs <clippy json file>
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const MODULE = /(?:^|\/)src-tauri\/src\/windows\/e2e(?:\.rs$|\/)/;

/** The problems in `text`, cargo's JSON lines, one line per problem. */
export function clippyProblems(text) {
  const problems = [];
  let finished = null;
  let lintedElsewhere = false;
  for (const line of text.split("\n")) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.reason === "build-finished") finished = record.success === true;
    if (record?.reason !== "compiler-message") continue;
    const { level, message, code, spans = [] } = record.message ?? {};
    if (level !== "warning" && level !== "error") continue;
    const span = spans.find((s) => s.is_primary) ?? spans[0];
    const where = span ? `${span.file_name}:${span.line_start}` : null;
    const lint = String(code?.code ?? "").startsWith("clippy::");
    if (span && MODULE.test(span.file_name)) problems.push(`${where}: ${level}: ${message}`);
    else if (level === "error" && lint) lintedElsewhere = true;
    else if (level === "error" && where) problems.push(`${where}: ${level}: ${message}`);
  }
  if (finished === null) problems.push("clippy did not finish: no build-finished line");
  else if (!finished && problems.length === 0 && !lintedElsewhere)
    problems.push("the build failed and no diagnostic says why");
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
