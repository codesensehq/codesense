// SPDX-License-Identifier: MIT
// node --test scripts/rust-changes.node-test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RUST_PATHS, includedPaths, touchesRust } from "./rust-changes.mjs";

const script = fileURLToPath(new URL("rust-changes.mjs", import.meta.url));

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rust-changes-"));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

test("includedPaths finds files Rust includes or reads by a literal path outside src-tauri", () => {
  const root = tree({
    "src-tauri/Cargo.toml": "",
    "src-tauri/src/a.rs": [
      'include_str!("../../src/tauri/commands.ts");',
      'include_bytes!(concat!("../../src/assets/packs/", $pack, "/", $file));',
      'include_str!("own.json");',
      'let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../codesense-docs");',
      'let r = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()\n  .join("scripts/x.mjs");',
      'let c = concat!(env!("CARGO_MANIFEST_DIR"), "/../site/package.json");',
      'let s = concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json");',
    ].join("\n"),
    "src-tauri/crates/demo/Cargo.toml": "",
    "src-tauri/crates/demo/src/lib.rs":
      'Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/x.json")',
    "src-tauri/target/debug/skip.rs": 'include_str!("../../../src/skipped.ts")',
  });
  assert.deepEqual(includedPaths(root), [
    "codesense-docs",
    "scripts/x.mjs",
    "site/package.json",
    "src/assets/packs",
    "src/tauri/commands.ts",
    "tests/fixtures/x.json",
  ]);
});

test("touchesRust matches any changed path under a prefix, and an empty diff counts", () => {
  assert.equal(touchesRust(["src/app.tsx", "docs/x.md"], RUST_PATHS), false);
  for (const file of [
    "src-tauri/src/lib.rs",
    "Cargo.lock",
    ".github/workflows/rust.yml",
    "scripts/generate-yaml-schemas.mjs",
    "codesense-docs/bundle.json",
  ])
    assert.equal(touchesRust(["src/app.tsx", file], RUST_PATHS), true, file);
  assert.equal(touchesRust([], RUST_PATHS), true);
});

test("the real tree's includes keep src/tauri/commands.ts Rust-relevant", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  assert.ok(includedPaths(root).includes("src/tauri/commands.ts"));
});

test("the CLI diffs a range and prints rust=true or rust=false", () => {
  const root = tree({ "README.md": "x\n" });
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(script, path.join(root, "scripts/rust-changes.mjs"));
  const git = (...args) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base");
  const commit = (file) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "x\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", file);
  };
  const run = (range) =>
    execFileSync(process.execPath, ["scripts/rust-changes.mjs", range], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  fs.mkdirSync(path.join(root, "src-tauri"));
  commit("src/app.tsx");
  assert.equal(run("HEAD~1..HEAD"), "rust=false\n");
  commit("src-tauri/src/lib.rs");
  assert.equal(run("HEAD~2...HEAD"), "rust=true\n");
  assert.throws(() => run("missing..HEAD"));
});
