// SPDX-License-Identifier: MIT
// Decides whether a change can affect rust.yml's test jobs, so a merge group or pull request
// without one skips them, and whether it can affect the macOS build, so a change only Windows or
// Linux compiles skips the macOS jobs. Usage: node scripts/rust-changes.mjs <git diff range>;
// prints rust= and macos=, each true or false, for $GITHUB_OUTPUT. Any error exits non-zero, and
// rust.yml then runs the jobs.
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
  ".npmrc",
  "package.json",
  "pnpm-lock.yaml",
  "patches/",
  "release/scanners.lock",
  "scripts/build-",
  "scripts/clippy-webdriver-module.mjs",
  "scripts/fetch-bundled.sh",
  "scripts/fetch-git-ai.sh",
  "scripts/fetch-pinned.sh",
  "scripts/flaky-tests.mjs",
  "scripts/generate-",
  "scripts/install-",
  "scripts/lib/",
  "scripts/run-secret-service-tests.sh",
  "scripts/rust-changes.mjs",
  "scripts/verify-wdio-plugin-release-absence.sh",
  "scripts/verify-webdriver-absence.ts",
  "src-emulator/",
  "codesense-docs/",
  "site/package.json",
  ".claude/settings.json",
  // What windows-e2e-linux runs: the two-window specs, their runner and the front-end they drive.
  "src/shared/windows/",
  "src/app/e2e-windows-control.ts",
  "src/app/e2e-satellite-probe.tsx",
  "src/main.tsx",
  "tests/windows/",
  "wdio.windows.conf.ts",
];

// Rust-relevant files that the macOS build never compiles or reads: each is a module declared only
// under a Windows or Linux cfg, and nothing includes it (rust-changes.node-test.mjs checks both).
// Exact paths, never prefixes, so a new file next to one of them still runs the macOS jobs.
export const OS_ONLY_PATHS = [
  "src-tauri/crates/codesense-platform/src/fs/windows.rs",
  "src-tauri/crates/codesense-platform/src/ipc/windows.rs",
  "src-tauri/crates/codesense-platform/src/limits/windows.rs",
  "src-tauri/crates/codesense-platform/src/process/windows.rs",
  "src-tauri/crates/codesense-platform/src/win.rs",
  "src-tauri/vendor/tauri-plugin-wdio-webdriver/src/platform/linux.rs",
  "src-tauri/vendor/tauri-plugin-wdio-webdriver/src/platform/windows.rs",
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

// True unless every Rust-relevant changed path is on the OS-only list. Paths the Rust jobs ignore
// don't count, and no changes at all counts as macOS, as in touchesRust.
export function touchesMacos(changed, prefixes) {
  return (
    !changed.length ||
    changed.some(
      (file) => prefixes.some((p) => file.startsWith(p)) && !OS_ONLY_PATHS.includes(file),
    )
  );
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
  console.log(`macos=${touchesMacos(changed, prefixes)}`);
}
