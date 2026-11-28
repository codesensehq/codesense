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

const message = (level, file, { code = "clippy::needless_return", text = "a lint" } = {}) =>
  JSON.stringify({
    reason: "compiler-message",
    message: {
      level,
      message: text,
      code: code && { code },
      spans: file ? [{ file_name: file, is_primary: true, line_start: 7 }] : [],
      rendered: `${level}: ${text}`,
    },
  });
const finished = (success) => JSON.stringify({ reason: "build-finished", success });

test("passes a finished build whose warnings are all outside the module", () => {
  const lines = [
    message("warning", "src-tauri/crates/codesense-platform/src/limits/unix.rs"),
    message("warning", "src-tauri/src/windows/mod.rs", { code: "unused_imports" }),
    message("warning", "src-tauri/src/windows/e2e_names.rs"),
    finished(true),
  ];
  assert.deepEqual(clippyProblems(lines.join("\n")), []);
});

test("fails any lint or warning in the module or a file under it", () => {
  const lines = [
    message("warning", "src-tauri/src/windows/e2e.rs"),
    message("warning", "src-tauri/src/windows/e2e/seed.rs", { code: "unused_mut" }),
    message("error", "/home/runner/work/x/x/src-tauri/src/windows/e2e.rs"),
    finished(false),
  ];
  assert.deepEqual(clippyProblems(lines.join("\n")), [
    "src-tauri/src/windows/e2e.rs:7: warning: a lint",
    "src-tauri/src/windows/e2e/seed.rs:7: warning: a lint",
    "/home/runner/work/x/x/src-tauri/src/windows/e2e.rs:7: error: a lint",
  ]);
});

test("fails a compile error anywhere, but not a deny lint outside the module", () => {
  const lines = [
    message("error", "src-tauri/src/lib.rs", { code: "E0425", text: "cannot find value" }),
    message("error", "src-tauri/crates/codesense-platform/src/fs.rs"),
    message("error", null, { code: null, text: "aborting due to 2 previous errors" }),
    finished(false),
  ];
  assert.deepEqual(clippyProblems(lines.join("\n")), [
    "src-tauri/src/lib.rs:7: error: cannot find value",
  ]);
});

test("fails a build that did not finish or failed with nothing to show for it", () => {
  assert.deepEqual(clippyProblems(message("warning", "src-tauri/src/lib.rs")), [
    "clippy did not finish: no build-finished line",
  ]);
  assert.deepEqual(clippyProblems(finished(false)), [
    "the build failed and no diagnostic says why",
  ]);
  assert.deepEqual(clippyProblems(""), ["clippy did not finish: no build-finished line"]);
});

test("ignores cargo's other lines and text that is not JSON", () => {
  const lines = [
    "   Compiling codesense v0.1.0",
    JSON.stringify({ reason: "compiler-artifact", target: { name: "codesense" } }),
    finished(true),
  ];
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
  fs.writeFileSync(good, finished(true));
  assert.throws(
    () => execFileSync("node", [script, bad], { stdio: "pipe" }),
    (e) => e.status === 1 && /e2e\.rs:7: warning: a lint/.test(String(e.stderr)),
  );
  assert.match(execFileSync("node", [script, good], { encoding: "utf8" }), /clean/);
});
