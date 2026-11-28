// SPDX-License-Identifier: MIT
// node --test scripts/clippy-webdriver-module.node-test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clippyProblems } from "./clippy-webdriver-module.mjs";

const script = fileURLToPath(new URL("clippy-webdriver-module.mjs", import.meta.url));

const ROOT = "/home/runner/work/codesense/codesense/src-tauri";
const APP = { name: "codesense_lib", src_path: `${ROOT}/src/lib.rs` };
const PLATFORM = {
  name: "codesense_platform",
  src_path: `${ROOT}/crates/codesense-platform/src/lib.rs`,
};

const message = (
  level,
  file,
  { code = "clippy::needless_return", text = "a lint", target = APP } = {},
) =>
  JSON.stringify({
    reason: "compiler-message",
    target,
    message: {
      level,
      message: text,
      code: code && { code },
      spans: file ? [{ file_name: file, is_primary: true, line_start: 7 }] : [],
      rendered: `${level}: ${text}`,
    },
  });
const aborting = (target) =>
  message("error", null, { code: null, text: "aborting due to 1 previous error", target });
const artifact = (target) => JSON.stringify({ reason: "compiler-artifact", target });
const finished = (success) => JSON.stringify({ reason: "build-finished", success });

test("passes a clean run: the app crate checked and the build finished", () => {
  assert.deepEqual(
    clippyProblems([artifact(PLATFORM), artifact(APP), finished(true)].join("\n")),
    [],
  );
});

test("passes warnings and deny lints in the app crate outside the module", () => {
  const lines = [
    message("warning", "src-tauri/crates/codesense-platform/src/limits/unix.rs", {
      target: PLATFORM,
    }),
    message("warning", "src-tauri/src/windows/mod.rs", { code: "unused_imports" }),
    message("warning", "src-tauri/src/windows/e2e_names.rs"),
    message("error", "src-tauri/src/commands/fs.rs", { code: "clippy::never_loop" }),
    aborting(APP),
    finished(false),
  ];
  assert.deepEqual(clippyProblems(lines.join("\n")), []);
});

test("fails closed when the app crate's check ends without rustc's summary after a lint", () => {
  // A killed rustc leaves the lint it had printed and no "aborting due to" summary, so the
  // lint pass may never have reached the module.
  const lines = [
    message("error", "src-tauri/src/commands/fs.rs", { code: "clippy::never_loop" }),
    finished(false),
  ];
  assert.deepEqual(clippyProblems(lines.join("\n")), [
    "the app crate's check ended without rustc's summary (a crash or a killed rustc), so the module may not have been linted",
  ]);
});

test("fails closed when an app compile error ends without rustc's summary", () => {
  // Any error in the app crate, not only a lint, needs the crate's own summary to show its
  // check was not cut short.
  const lines = [
    message("error", "src-tauri/src/lib.rs", { code: "E0425", text: "cannot find value" }),
    finished(false),
  ];
  assert.deepEqual(clippyProblems(lines.join("\n")), [
    "src-tauri/src/lib.rs:7: error: cannot find value",
    "the app crate's check ended without rustc's summary (a crash or a killed rustc), so the module may not have been linted",
  ]);
});

test("a dependency's summary does not stand in for the app crate's", () => {
  const lines = [
    message("error", "src-tauri/src/commands/fs.rs", { code: "clippy::never_loop" }),
    aborting(PLATFORM),
    finished(false),
  ];
  assert.deepEqual(clippyProblems(lines.join("\n")), [
    "the app crate's check ended without rustc's summary (a crash or a killed rustc), so the module may not have been linted",
  ]);
});

test("fails an error level it does not know, even with the app crate's summary", () => {
  const lines = [
    message("error", "src-tauri/src/commands/fs.rs", { code: "clippy::never_loop" }),
    message("error: a new kind", null, { code: null, text: "something went wrong" }),
    aborting(APP),
    finished(false),
  ];
  assert.deepEqual(clippyProblems(lines.join("\n")), [
    "the compiler reported an error level this script does not know (error: a new kind): something went wrong",
  ]);
});

test("fails a compiler crash anywhere, even with the app crate's summary", () => {
  const lines = [
    message("error", "src-tauri/src/commands/fs.rs", { code: "clippy::never_loop" }),
    message("error: internal compiler error", null, { code: null, text: "unexpected panic" }),
    aborting(APP),
    finished(false),
  ];
  assert.deepEqual(clippyProblems(lines.join("\n")), [
    "the compiler crashed (error: internal compiler error): unexpected panic",
  ]);
});

test("fails any lint or warning in the module or a file under it", () => {
  const lines = [
    message("warning", "src-tauri/src/windows/e2e.rs"),
    message("warning", "src-tauri/src/windows/e2e/seed.rs", { code: "unused_mut" }),
    message("error", "/home/runner/work/x/x/src-tauri/src/windows/e2e.rs"),
    aborting(APP),
    finished(false),
  ];
  assert.deepEqual(clippyProblems(lines.join("\n")), [
    "src-tauri/src/windows/e2e.rs:7: warning: a lint",
    "src-tauri/src/windows/e2e/seed.rs:7: warning: a lint",
    "/home/runner/work/x/x/src-tauri/src/windows/e2e.rs:7: error: a lint",
  ]);
});

test("fails a compile error in the app crate", () => {
  const lines = [
    message("error", "src-tauri/src/lib.rs", { code: "E0425", text: "cannot find value" }),
    message("error", null, { code: null, text: "aborting due to 1 previous error" }),
    finished(false),
  ];
  assert.deepEqual(clippyProblems(lines.join("\n")), [
    "src-tauri/src/lib.rs:7: error: cannot find value",
  ]);
});

test("fails closed when a dependency's error stops the app crate being linted", () => {
  // A deny-by-default lint in a dependency ends the build before the app crate is checked.
  const lines = [
    message("warning", "src-tauri/crates/codesense-platform/src/limits/unix.rs", {
      code: "unused_mut",
      target: PLATFORM,
    }),
    message("error", "src-tauri/crates/codesense-platform/src/limits/unix.rs", {
      code: "clippy::never_loop",
      text: "this loop never actually loops",
      target: PLATFORM,
    }),
    finished(false),
  ];
  assert.deepEqual(clippyProblems(lines.join("\n")), [
    "src-tauri/crates/codesense-platform/src/limits/unix.rs:7: error in codesense_platform, which the app crate needs: this loop never actually loops",
    "the app crate (src-tauri/src/lib.rs) was never checked, so the module was not linted",
  ]);
});

test("fails closed when nothing shows the app crate was checked", () => {
  assert.deepEqual(clippyProblems([artifact(PLATFORM), finished(true)].join("\n")), [
    "the app crate (src-tauri/src/lib.rs) was never checked, so the module was not linted",
  ]);
});

test("fails a build that did not finish or failed with nothing to show for it", () => {
  assert.deepEqual(
    clippyProblems([artifact(APP), message("warning", "src-tauri/src/lib.rs")].join("\n")),
    ["clippy did not finish: no build-finished line"],
  );
  assert.deepEqual(clippyProblems([artifact(APP), finished(false)].join("\n")), [
    "the build failed and no diagnostic says why",
  ]);
  assert.deepEqual(clippyProblems(""), [
    "clippy did not finish: no build-finished line",
    "the app crate (src-tauri/src/lib.rs) was never checked, so the module was not linted",
  ]);
});

test("ignores cargo's other lines and text that is not JSON", () => {
  const lines = ["   Compiling codesense v0.1.1", artifact(APP), finished(true)];
  assert.deepEqual(clippyProblems(lines.join("\n")), []);
});

test("the command exits non-zero on a problem and prints it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clippy-module-"));
  const bad = path.join(dir, "bad.json");
  const good = path.join(dir, "good.json");
  fs.writeFileSync(
    bad,
    [message("warning", "src-tauri/src/windows/e2e.rs"), finished(true)].join("\n"),
  );
  fs.writeFileSync(good, [artifact(APP), finished(true)].join("\n"));
  assert.throws(
    () => execFileSync("node", [script, bad], { stdio: "pipe" }),
    (e) => e.status === 1 && /e2e\.rs:7: warning: a lint/.test(String(e.stderr)),
  );
  assert.match(execFileSync("node", [script, good], { encoding: "utf8" }), /clean/);
});
