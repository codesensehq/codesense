// SPDX-License-Identifier: MIT
// Decides whether a change can affect rust.yml's test jobs, so a merge group or pull request
// without one skips them. Usage: node scripts/rust-changes.mjs <git diff range>; prints rust=true
// or rust=false for $GITHUB_OUTPUT. Any error exits non-zero, and rust.yml then runs the jobs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Path prefixes that can change what the Rust jobs build or test: the workspace, what the jobs
// install and run, and what build.rs reads outside src-tauri (its docs generators, package
// manifests and settings). Files the Rust sources include or read by a literal path are found by
// includedPaths, so a new include_str! needs no entry here.
export const RUST_PATHS = [
  "src-tauri/",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  ".cargo/",
  ".config/nextest.toml",
  ".github/workflows/rust.yml",
  ".nvmrc",
  "package.json",
  "pnpm-lock.yaml",
  "patches/",
  "release/scanners.lock",
  "scripts/build-",
  "scripts/fetch-git-ai.sh",
  "scripts/flaky-tests.mjs",
  "scripts/generate-",
  "scripts/install-scanners.sh",
  "scripts/lib/",
  "scripts/rust-changes.mjs",
  "src-emulator/",
  "codesense-docs/",
  "site/package.json",
  ".claude/settings.json",
];

// include_str!/include_bytes! paths are relative to the including file; CARGO_MANIFEST_DIR paths
// to the crate. A concat! keeps only its leading literal, which names a directory prefix.
const RELATIVE_TO_FILE = /include_(?:str|bytes)!\(\s*(?:concat!\(\s*)?"([^"]+)"/g;
const RELATIVE_TO_CRATE =
  /env!\("CARGO_MANIFEST_DIR"\)\s*(?:,\s*"([^"]+)"|\)\s*(?:\.parent\(\)\s*\.unwrap\(\)\s*)?\.join\(\s*"([^"]+)")/g;

function rustFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory())
      return ["target", "node_modules", ".git"].includes(entry.name) ? [] : rustFiles(full);
    return entry.name.endsWith(".rs") ? [full] : [];
  });
}

function crateDirectory(file, root) {
  for (let dir = path.dirname(file); dir.startsWith(root); dir = path.dirname(dir))
    if (fs.existsSync(path.join(dir, "Cargo.toml"))) return dir;
  return root;
}

// The repository paths outside src-tauri that Rust sources include or read by a literal path.
export function includedPaths(root) {
  const found = new Set();
  const add = (absolute) => {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const outside = !relative.startsWith("..") && !/^src-tauri(?:\/|$)/.test(relative);
    if (relative && outside) found.add(relative);
  };
  for (const file of rustFiles(path.join(root, "src-tauri"))) {
    const text = fs.readFileSync(file, "utf8");
    for (const [, literal] of text.matchAll(RELATIVE_TO_FILE))
      if (!literal.startsWith("/")) add(path.join(path.dirname(file), literal));
    const crate = crateDirectory(file, root);
    for (const match of text.matchAll(RELATIVE_TO_CRATE)) {
      const literal = match[1] ?? match[2];
      const base = match[0].includes(".parent()") ? path.dirname(crate) : crate;
      add(path.join(base, literal));
    }
  }
  return [...found].sort();
}

// True when any changed path starts with a Rust prefix. No changes at all counts as Rust, so an
// unexpected empty diff runs the jobs rather than skipping them.
export function touchesRust(changed, prefixes) {
  return !changed.length || changed.some((file) => prefixes.some((p) => file.startsWith(p)));
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  if (process.argv.length !== 3) throw new Error("usage: node scripts/rust-changes.mjs <range>");
  const root = fileURLToPath(new URL("..", import.meta.url));
  // --no-renames lists a moved file's old path too, so a move out of src-tauri counts.
  const changed = execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", process.argv[2]],
    { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 },
  )
    .split("\0")
    .filter(Boolean);
  const prefixes = [...RUST_PATHS, ...includedPaths(root)];
  const matched = changed.filter((file) => prefixes.some((p) => file.startsWith(p)));
  console.error(`${changed.length} changed files; Rust-relevant: ${matched.join(", ") || "none"}`);
  console.log(`rust=${touchesRust(changed, prefixes)}`);
}
