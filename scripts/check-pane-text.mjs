// SPDX-License-Identifier: MIT
// Usage: node scripts/check-pane-text.mjs [<pane file> ...]
//
// Built-in panes run on every OS, so none spells a macOS key glyph, Option wording or "This Mac".
// A hint names its keys through the page SDK (`data-keys`, `codesense.formatKeys`), and machine
// words come from `codesense.localMachineLabel` / `localMachinePhrase`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtInPaneFiles } from "./lib/builtin-panes.mjs";

const RULES = [
  [/[⌘⌥⇧⌃↵⏎⇥⌫⌦]/gu, "a macOS key glyph; use data-keys or codesense.formatKeys"],
  [/\bOption[-+]/g, "Option wording; use codesense.formatKeys or formatModifierClick"],
  [/\b[Tt]his Mac\b/g, "the macOS machine word; use codesense.localMachineLabel or Phrase"],
];

/** Each line of `source` that names a macOS-only key or machine, as `line: text (why)`. */
export function paneTextProblems(source) {
  const problems = [];
  source.split("\n").forEach((text, index) => {
    for (const [pattern, why] of RULES)
      for (const match of text.matchAll(pattern))
        problems.push(`${index + 1}: ${match[0]} (${why})`);
  });
  return problems;
}

export function check(root = process.cwd(), paths = builtInPaneFiles(root)) {
  return paths.flatMap((path) =>
    paneTextProblems(readFileSync(resolve(root, path), "utf8")).map((p) => `${path}:${p}`),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2);
  const errors = check(process.cwd(), paths.length ? paths : undefined);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("Built-in pane text names no macOS-only keys or machine.");
}
