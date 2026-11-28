// SPDX-License-Identifier: MIT
// node --test scripts/rust-changes.node-test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  OS_ONLY_PATHS,
  RUST_PATHS,
  includedPaths,
  touchesMacos,
  touchesRust,
} from "./rust-changes.mjs";

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

test("a change to what the two-window e2e job drives runs the Rust jobs", () => {
  for (const file of [
    "src/shared/windows/satellite-root.tsx",
    "src/app/e2e-windows-control.ts",
    "src/app/e2e-satellite-probe.tsx",
    // It mounts the probe route and registers the webdriver controls.
    "src/main.tsx",
    "tests/windows/two-window-smoke.e2e.ts",
    "tests/windows/fixtures/probe.html",
    "wdio.windows.conf.ts",
  ])
    assert.equal(touchesRust([file], RUST_PATHS), true, file);
  for (const file of ["src/shared/window-title.ts", "tests/e2e-mock/satellite-boot.spec.ts"])
    assert.equal(touchesRust([file], RUST_PATHS), false, file);
});

// The macOS jobs skip only when every Rust-relevant change is a listed file only Windows or Linux
// compiles; any other Rust-relevant path, an empty diff, or an error runs them.
test("touchesMacos skips only changes confined to the OS-only files", () => {
  const windows = "src-tauri/crates/codesense-platform/src/fs/windows.rs";
  const vendorLinux = "src-tauri/vendor/tauri-plugin-wdio-webdriver/src/platform/linux.rs";
  assert.equal(touchesMacos([windows], RUST_PATHS), false);
  assert.equal(touchesMacos([vendorLinux], RUST_PATHS), false);
  // Paths the Rust jobs ignore don't count.
  assert.equal(touchesMacos([windows, vendorLinux, "src/app.tsx", "docs/x.md"], RUST_PATHS), false);
  assert.equal(touchesMacos(["src/app.tsx"], RUST_PATHS), false);
  for (const file of [
    // Shared Rust, the filter itself, and paths beside or under a listed file: exact paths only.
    "src-tauri/crates/codesense-platform/src/fs.rs",
    "src-tauri/crates/codesense-platform/src/fs/unix.rs",
    "src-tauri/vendor/tauri-plugin-wdio-webdriver/src/platform/macos.rs",
    "scripts/rust-changes.mjs",
    ".github/workflows/rust.yml",
    "Cargo.lock",
    `${windows}.orig`,
    windows.replace(".rs", "/mod.rs"),
    "src-tauri/crates/codesense-platform/src/fs/windows_extra.rs",
  ])
    assert.equal(touchesMacos([windows, file], RUST_PATHS), true, file);
  assert.equal(touchesMacos([], RUST_PATHS), true);
});

// Why each listed file might be one the macOS build compiles or reads: a module declaration of it
// without a Windows or Linux cfg, or an include, #[path] attribute or other path literal naming
// it. (A test that walks a whole source tree can still read one; the nightly covers that.)
function osOnlyProblems(root, list) {
  const sources = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!["target", "node_modules", ".git"].includes(entry.name)) walk(full);
      } else if (entry.name.endsWith(".rs")) sources.push(full);
    }
  };
  walk(path.join(root, "src-tauri"));
  const relative = (file) => path.relative(root, file).split(path.sep).join("/");
  const osOnly = /^#\[cfg\((?:windows|target_os = "windows"|target_os = "linux")\)\]$/;
  const declared = new Map(list.map((file) => [file, []]));
  const problems = [];
  const tails = list.map((file) => file.split("/").slice(-2).join("/"));
  for (const source of sources) {
    const lines = fs.readFileSync(source, "utf8").split("\n");
    // A non-mod-rs file's submodules live in a directory of its own name.
    const base = ["lib.rs", "main.rs", "mod.rs"].includes(path.basename(source))
      ? path.dirname(source)
      : source.slice(0, -".rs".length);
    lines.forEach((line, i) => {
      const at = `${relative(source)}:${i + 1}`;
      const declaration = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/.exec(line);
      if (declaration) {
        const target = [`${declaration[1]}.rs`, `${declaration[1]}/mod.rs`]
          .map((leaf) => relative(path.join(base, leaf)))
          .find((file) => declared.has(file));
        if (target) {
          // The attributes and doc comments right above the declaration.
          let above = i - 1;
          const attributes = [];
          while (above >= 0 && /^\s*(?:#\[|\/\/)/.test(lines[above]))
            attributes.push(lines[above--].trim());
          declared.get(target).push(at);
          if (!attributes.some((attribute) => osOnly.test(attribute)))
            problems.push(`${at} declares ${target} without a Windows or Linux cfg`);
        }
      }
      for (const [, literal] of line.matchAll(
        /(?:include(?:_str|_bytes)?!\(\s*(?:concat!\(\s*)?|#\[path\s*=\s*)"([^"]+)"/g,
      )) {
        const candidates = [path.dirname(source), base].map((dir) =>
          relative(path.join(dir, literal)),
        );
        const file = candidates.find((candidate) => declared.has(candidate));
        if (file) problems.push(`${at} includes ${file}`);
      }
      // Nor a path a test reads it by, such as "src/fs/windows.rs".
      for (const [, literal] of line.matchAll(/"([^"\\]+)"/g))
        if (tails.some((tail) => literal === tail || literal.endsWith(`/${tail}`)))
          problems.push(`${at} names "${literal}"`);
    });
  }
  for (const [file, declarations] of declared) {
    if (!fs.existsSync(path.join(root, file))) problems.push(`${file} does not exist`);
    else if (!declarations.length) problems.push(`${file} is not declared as a module`);
  }
  return problems;
}

test("each OS-only file is a module only Windows or Linux declares, and nothing includes it", () => {
  assert.deepEqual(
    osOnlyProblems(fileURLToPath(new URL("..", import.meta.url)), OS_ONLY_PATHS),
    [],
  );
});

test("the OS-only guard refuses a file macOS could compile or read", () => {
  const list = [
    "src-tauri/crates/a/src/fs/windows.rs",
    "src-tauri/crates/a/src/net/linux.rs",
    "src-tauri/crates/a/src/io/windows.rs",
  ];
  const files = {
    ...Object.fromEntries(list.map((file) => [file, "fn f() {}\n"])),
    "src-tauri/crates/a/src/lib.rs": "mod fs;\nmod net;\nmod io;\n",
    "src-tauri/crates/a/src/fs.rs": "#[cfg(windows)]\nmod windows;\n",
    "src-tauri/crates/a/src/net.rs":
      '/// Doc.\n#[cfg(target_os = "linux")]\n#[allow(dead_code)]\nmod linux;\n',
    "src-tauri/crates/a/src/io.rs": '#[cfg(target_os = "windows")]\npub(crate) mod windows;\n',
  };
  const good = tree(files);
  assert.deepEqual(osOnlyProblems(good, list), []);
  for (const [file, text, problem] of [
    ["src-tauri/crates/a/src/fs.rs", "mod windows;\n", /declares .*fs\/windows\.rs without/],
    ["src-tauri/crates/a/src/fs.rs", "#[cfg(unix)]\nmod windows;\n", /without a Windows/],
    [
      "src-tauri/crates/a/src/fs.rs",
      '#[cfg(windows)]\nmod windows;\ninclude!("fs/windows.rs");\n',
      /includes/,
    ],
    [
      "src-tauri/crates/a/src/lib.rs",
      'mod fs;\nmod net;\nmod io;\nconst W: &str = include_str!("fs/windows.rs");\n',
      /includes/,
    ],
    [
      "src-tauri/crates/a/src/lib.rs",
      'mod fs;\nmod net;\nmod io;\n#[path = "net/linux.rs"]\nmod other;\n',
      /includes/,
    ],
    ["src-tauri/src/tests.rs", 'let p = "crates/a/src/io/windows.rs";\n', /names/],
  ]) {
    const root = tree({ ...files, [file]: text });
    assert.match(osOnlyProblems(root, list).join("\n"), problem, text);
  }
  assert.match(
    osOnlyProblems(good, [...list, "src-tauri/crates/a/src/gone.rs"]).join("\n"),
    /does not exist/,
  );
  fs.writeFileSync(path.join(good, "src-tauri/crates/a/src/stray.rs"), "");
  assert.match(
    osOnlyProblems(good, [...list, "src-tauri/crates/a/src/stray.rs"]).join("\n"),
    /not declared/,
  );
});

test("every script rust.yml runs is Rust-relevant, so changing one runs the Rust jobs", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/rust.yml"), "utf8");
  const scripts = [...new Set(workflow.match(/\bscripts\/[\w./-]+\.(?:sh|mjs)\b/g))];
  assert.ok(scripts.includes("scripts/install-linux-app-libs.sh"), "the pattern finds the scripts");
  for (const script of scripts)
    assert.equal(touchesRust(["src/app.tsx", script], RUST_PATHS), true, script);
});

test("the real tree's includes keep src/tauri/commands.ts Rust-relevant", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  assert.ok(includedPaths(root).includes("src/tauri/commands.ts"));
});

test("the CLI diffs a range and prints rust= and macos=", () => {
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
  assert.equal(run("HEAD~1..HEAD"), "rust=false\nmacos=false\n");
  commit("src-tauri/crates/codesense-platform/src/ipc/windows.rs");
  assert.equal(run("HEAD~1..HEAD"), "rust=true\nmacos=false\n");
  commit("src-tauri/src/lib.rs");
  assert.equal(run("HEAD~3...HEAD"), "rust=true\nmacos=true\n");
  assert.equal(run("HEAD..HEAD"), "rust=true\nmacos=true\n");
  // An error prints nothing and fails, and rust.yml then runs the jobs.
  assert.throws(
    () => run("missing..HEAD"),
    (error) => error.stdout === "",
  );
});

// includedPaths can't resolve a read through a helper such as the guards' root().join("../src").
// The guards crate runs on every change (rust.yml's Rust guards job), so it may read that way;
// anywhere else, a new one would let a frontend-only change skip a test that reads it.
test("only the always-run guards crate reads outside src-tauri through root().join", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const helperRead = /\broot\(\)\s*\.join\(\s*"\.\.\//;
  const offenders = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!["target", "node_modules", ".git"].includes(entry.name)) walk(full);
      } else if (entry.name.endsWith(".rs") && helperRead.test(fs.readFileSync(full, "utf8"))) {
        offenders.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(root, "src-tauri"));
  assert.ok(offenders.length, "the guards' own reads keep this check live");
  assert.deepEqual(
    offenders.filter((file) => !file.startsWith("src-tauri/crates/codesense-guards/")),
    [],
    'read through env!("CARGO_MANIFEST_DIR") with a literal path, which includedPaths finds',
  );
});

// rust.yml's filter step, run as written against a scratch repository whose rust-changes.mjs
// always answers rust=false and macos=false: a change to the filter itself must still say true to
// both, as must every way out of the step that doesn't diff.
test("the filter step never lets a change to the filter skip the Rust jobs", () => {
  const workflow = parse(
    fs.readFileSync(new URL("../.github/workflows/rust.yml", import.meta.url), "utf8"),
  );
  const step = workflow.jobs.changes.steps.find((s) => s.id === "filter");
  const root = tree({
    "README.md": "x\n",
    "scripts/rust-changes.mjs": 'console.log("rust=false\\nmacos=false");\n',
  });
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        ...args,
      ],
      { cwd: root, encoding: "utf8" },
    );
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "base");
  const output = path.join(root, "..", `${path.basename(root)}.out`);
  const runStep = (env) => {
    fs.writeFileSync(output, "");
    execFileSync("bash", ["-e", "-c", step.run], {
      cwd: root,
      env: { ...process.env, ...env, GITHUB_OUTPUT: output },
    });
    return fs.readFileSync(output, "utf8");
  };
  const filter = (file) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    // A comment, so the stub script still runs after a change to it.
    fs.appendFileSync(path.join(root, file), "// y\n");
    git("add", ".");
    git("commit", "-qm", file);
    return runStep({ EVENT: "merge_group", GROUP_BASE: "HEAD~1", GROUP_HEAD: "HEAD" });
  };
  assert.equal(filter("docs/a.md"), "rust=false\nmacos=false\n");
  for (const file of [
    ".github/workflows/rust.yml",
    "scripts/rust-changes.mjs",
    "scripts/rust-changes.node-test.mjs",
  ])
    assert.equal(filter(file), "rust=true\nmacos=true\n", file);
  // A push's diff goes to the script; a new branch, the nightly and a dispatched run test all.
  assert.equal(
    runStep({ EVENT: "push", PUSH_BEFORE: "HEAD~1", PUSH_AFTER: "HEAD" }),
    "rust=true\nmacos=true\n",
  );
  filter("docs/b.md");
  assert.equal(
    runStep({ EVENT: "push", PUSH_BEFORE: "HEAD~1", PUSH_AFTER: "HEAD" }),
    "rust=false\nmacos=false\n",
  );
  for (const env of [
    { EVENT: "push", PUSH_BEFORE: "0".repeat(40), PUSH_AFTER: "HEAD" },
    { EVENT: "schedule" },
    { EVENT: "workflow_dispatch" },
  ])
    assert.equal(runStep(env), "rust=true\nmacos=true\n", env.EVENT);
});
