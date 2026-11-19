// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = resolve(root, "src-tauri");
const rustRoots = ["src-tauri/src", "src-tauri/crates", "src"].map((p) => resolve(root, p));
function assertNarrow(input) {
  const path = resolve(manifest, input);
  const covers = (a, b) => a === b || relative(a, b).split("/")[0] !== "..";
  const directory = statSync(path, { throwIfNoEntry: false })?.isDirectory();
  assert.ok(
    !directory || !rustRoots.some((r) => covers(path, r) || covers(r, path)),
    `broad Rust source rerun input: ${input}`,
  );
}

for (const input of ["src", "crates", "../src-tauri/src", "../src"]) {
  test(`guard rejects ${input}`, () => assert.throws(() => assertNarrow(input), /broad Rust/));
}
function assertBuildInputs(source) {
  // This one emitter consumes the inventories exercised below. Everything else
  // must be a literal path: an unresolvable format argument fails closed.
  const inventoryEmitter = `    for input in String::from_utf8_lossy(&inputs.stdout).lines() {
        println!("cargo:rerun-if-changed={input}");
    }`;
  const trusted = source.indexOf("fn run_docs_generator_with_args(");
  if (trusted >= 0) {
    const prefix = source.slice(0, trusted);
    const runner = source.slice(trusted);
    assert.ok(runner.includes('.args([script_rel, "--list-inputs"])'));
    assert.equal(runner.split(inventoryEmitter).length, 2);
    source = prefix + runner.replace(inventoryEmitter, "");
  }
  for (const [, input] of source.matchAll(/cargo::?rerun-if-changed=([^"\n]*)/g)) {
    assert.ok(input.length && !/[{}]/.test(input), `unresolved rerun path: ${input}`);
    assertNarrow(input);
  }
}
for (const [name, source] of [
  ["double-colon directory", 'println!("cargo::rerun-if-changed=src");'],
  ["interpolated loop", 'for p in ["src", "crates"] { println!("cargo:rerun-if-changed={p}"); }'],
  ["positional interpolation", 'println!("cargo:rerun-if-changed={}", "src");'],
]) {
  test(`guard rejects ${name}`, () => assert.throws(() => assertBuildInputs(source)));
}
test("build.rs declares no broad Rust source directories", () => {
  assertBuildInputs(readFileSync(resolve(manifest, "build.rs"), "utf8"));
});

// `configure_caps(path)` reads the capability table but leaves its rerun watch
// to the caller, so each caller must name the same path in a literal
// `rerun-if-changed` line, and the path must be the table.
function assertTableWatch(source, dir) {
  const calls = [...source.matchAll(/configure_caps\("([^"]+)"\)/g)].map(([, path]) => path);
  assert.equal(calls.length, 1, "one configure_caps call with a literal path");
  const [table] = calls;
  assert.ok(
    source.includes(`println!("cargo:rerun-if-changed=${table}");`),
    `no literal rerun-if-changed for ${table}`,
  );
  assert.equal(resolve(dir, table), resolve(manifest, "platform-caps.json"));
}
for (const [name, source] of [
  ["no watch", 'configure_caps("platform-caps.json");'],
  [
    "another path watched",
    'println!("cargo:rerun-if-changed=other.json");\nconfigure_caps("platform-caps.json");',
  ],
  [
    "an interpolated watch",
    'println!("cargo:rerun-if-changed={}", t);\nconfigure_caps("platform-caps.json");',
  ],
  ["not the table", 'println!("cargo:rerun-if-changed=caps.json");\nconfigure_caps("caps.json");'],
]) {
  test(`table watch guard rejects ${name}`, () =>
    assert.throws(() => assertTableWatch(source, manifest)));
}
// configure_caps also reads the CODESENSE_CAPS_OFF override, so it must rerun when that changes.
test("configure_caps reruns when the capability override changes", () => {
  const source = readFileSync(resolve(manifest, "build_caps.rs"), "utf8");
  assert.ok(source.includes('pub const CAPS_OFF_ENV: &str = "CODESENSE_CAPS_OFF";'));
  const configure = source.slice(source.indexOf("pub fn configure_caps("));
  assert.ok(configure.includes('println!("cargo:rerun-if-env-changed={CAPS_OFF_ENV}");'));
  assert.ok(configure.includes("std::env::var(CAPS_OFF_ENV)"));
});
for (const crate of [".", "crates/codesense-session-server"]) {
  test(`${crate}/build.rs watches the capability table it reads`, () => {
    const dir = resolve(manifest, crate);
    assertTableWatch(readFileSync(resolve(dir, "build.rs"), "utf8"), dir);
  });
}

import { spawnSync } from "node:child_process";
const generators = [
  ["recipes-manifest", "codesense-docs/getting-started/content/examples"],
  ["primitives-reference", "src-tauri/src/http/routes/dashboard_kit/codesense.d.ts"],
  ["yaml-schemas", "src-tauri/src/routines/model.rs"],
  ["ui-mcp-crossref", "src-tauri/src/lib.rs"],
  ["docs-search-index", "codesense-docs/getting-started/content"],
  ["codesense-docs", "codesense-docs"],
  ["sample-source-repo", "codesense-docs/sample-source-repo"],
];
for (const [name, realInput] of generators) {
  const script = resolve(
    root,
    "scripts",
    `${name.startsWith("codesense-docs") || name === "sample-source-repo" ? "build" : "generate"}-${name}.mjs`,
  );
  test(`${name} lists real inputs without broad Rust watches`, () => {
    const result = spawnSync(process.execPath, [script, "--list-inputs"], {
      cwd: manifest,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const inputs = result.stdout
      .trim()
      .split("\n")
      .map((p) => resolve(manifest, p));
    assert.ok(inputs.includes(script), "generator watches itself");
    assert.ok(inputs.includes(resolve(root, realInput)), `missing real input ${realInput}`);
    assert.ok(
      !inputs.includes(resolve(root, "src-tauri/src/domain/source_repo_slug.rs")),
      "unrelated edit is not an input",
    );
    for (const input of inputs) assertNarrow(input);
  });
}

// Use the actual Cargo generator entry points: a second run must not touch
// watched outputs when the generated bytes are already current.
const generated = "codesense-docs/getting-started/content/generated/";
for (const [name, outputs, args] of [
  ["recipes-manifest", ["recipes.json"], []],
  ["primitives-reference", ["primitives.json"], []],
  ["yaml-schemas", ["schemas.json", "schemas/factory-phase.schema.json"], []],
  ["ui-mcp-crossref", ["ui-mcp.json"], []],
  ["docs-search-index", ["search-index.json"], []],
]) {
  test(`${name} repeated generation preserves bytes and mtimes`, () => {
    const script = resolve(root, "scripts", `generate-${name}.mjs`);
    const run = () => {
      const result = spawnSync(process.execPath, [script, ...args], {
        cwd: manifest,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
    };
    const paths = outputs.map((p) => resolve(root, generated, p));
    // Outputs that are build artifacts may be absent in a fresh checkout.
    const originals = paths.map((p) => (existsSync(p) ? readFileSync(p) : null));
    try {
      run();
      const before = paths.map((p) => [readFileSync(p), statSync(p, { bigint: true }).mtimeNs]);
      run();
      for (const [i, path] of paths.entries()) {
        assert.deepEqual(readFileSync(path), before[i][0]);
        assert.equal(statSync(path, { bigint: true }).mtimeNs, before[i][1], path);
      }
    } finally {
      for (const [i, path] of paths.entries()) {
        if (originals[i] === null) rmSync(path, { force: true });
        else if (!readFileSync(path).equals(originals[i])) writeFileSync(path, originals[i]);
      }
    }
  });
}
