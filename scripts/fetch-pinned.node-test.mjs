// SPDX-License-Identifier: MIT
// node --test scripts/fetch-pinned.node-test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(root, "scripts/fetch-pinned.sh");
const binary = "#!/bin/sh\necho pinned-tool 1.0.0\n";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-pinned-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const pin = (fields) => {
    const file = path.join(dir, "tool.pin");
    const lines = Object.entries({
      version: "1.0.0",
      platform: "linux-x86_64",
      repo: "starship/starship",
      tag: "v1.0.0",
      ...fields,
    })
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}\n`);
    fs.writeFileSync(file, lines.join(""));
    return file;
  };
  // Runs from the fixture directory, never the repository root.
  const run = (...args) => spawnSync("bash", [script, ...args], { cwd: dir, encoding: "utf8" });
  const dest = path.join(dir, "out/tool");
  return { dir, sha256, pin, run, dest };
}

// A directory holding the tool as `name`, packed by `pack` into `asset`.
function packed(f, asset, name, pack) {
  const src = path.join(f.dir, "src");
  fs.mkdirSync(path.join(src, path.dirname(name)), { recursive: true });
  fs.writeFileSync(path.join(src, name), binary, { mode: 0o644 });
  fs.writeFileSync(path.join(src, "README.md"), "not the tool\n");
  const file = path.join(f.dir, asset);
  pack(src, file);
  return file;
}
const tarGz = (src, file) => execFileSync("tar", ["-czf", file, "-C", src, ...fs.readdirSync(src)]);
const zip = (src, file) => execFileSync("zip", ["-qry", file, "."], { cwd: src });

function assertInstalled(f, run) {
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(f.dest, "utf8"), binary);
  assert.equal(fs.statSync(f.dest).mode & 0o777, 0o755);
  assert.equal(execFileSync(f.dest, { encoding: "utf8" }), "pinned-tool 1.0.0\n");
  assert.deepEqual(fs.readdirSync(path.dirname(f.dest)), ["tool"]);
}

test("a raw binary from the git-ai repository installs as is", (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "tool-macos");
  fs.writeFileSync(file, binary);
  const gitAi = fs.readFileSync(path.join(root, "src-tauri/git-ai.pin"), "utf8");
  const pin = f.pin({
    asset: "tool-macos",
    platform: "macos-arm64",
    repo: gitAi.match(/^repo=(.*)$/m)[1],
    sha256: f.sha256(file),
  });
  assertInstalled(f, f.run(pin, f.dest, "--from", file));
});

test("a tar.gz installs only its member", (t) => {
  const f = fixture(t);
  const file = packed(f, "tool.tar.gz", "tool", tarGz);
  const pin = f.pin({
    asset: "tool.tar.gz",
    sha256: f.sha256(file),
    archive: "tar.gz",
    member: "tool",
  });
  assertInstalled(f, f.run(pin, f.dest, "--from", file));
});

test("a zip installs only its member, from a subdirectory too", (t) => {
  const f = fixture(t);
  const file = packed(f, "tool.zip", "bin/tool.exe", zip);
  const pin = f.pin({
    asset: "tool.zip",
    platform: "windows-x86_64",
    sha256: f.sha256(file),
    archive: "zip",
    member: "bin/tool.exe",
  });
  assertInstalled(f, f.run(pin, f.dest, "--from", file));
});

test("a wrong checksum is refused and nothing is installed", (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "tool-linux");
  fs.writeFileSync(file, binary);
  const pin = f.pin({ asset: "tool-linux", sha256: "0".repeat(64) });
  const run = f.run(pin, f.dest, "--from", file);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /SHA-256 mismatch/);
  assert.equal(fs.existsSync(path.dirname(f.dest)), false);
});

test("a member that is not a regular file is refused", (t) => {
  for (const [label, make] of [
    ["directory", (src) => fs.mkdirSync(path.join(src, "tool"))],
    ["symlink", (src) => fs.symlinkSync("/bin/sh", path.join(src, "tool"))],
  ]) {
    const f = fixture(t);
    const src = path.join(f.dir, "src");
    fs.mkdirSync(src);
    make(src);
    const file = path.join(f.dir, "tool.tar.gz");
    tarGz(src, file);
    const pin = f.pin({
      asset: "tool.tar.gz",
      sha256: f.sha256(file),
      archive: "tar.gz",
      member: "tool",
    });
    const run = f.run(pin, f.dest, "--from", file);
    assert.equal(run.status, 1, label);
    assert.match(run.stderr, /not a regular file/, label);
    assert.equal(fs.existsSync(f.dest), false, label);
  }
});

test("invalid pins are refused", (t) => {
  const sha256 = "a".repeat(64);
  const cases = [
    [{ archive: "tar.gz" }, /archive and member go together/],
    [{ member: "tool" }, /archive and member go together/],
    [{ archive: "rar", member: "tool" }, /unknown archive/],
    [{ archive: "zip", member: "../tool" }, /must be a relative path/],
    [{ archive: "zip", member: "/tool" }, /must be a relative path/],
    [{ archive: "zip", member: "to*l" }, /must be a relative path/],
    [{ extra: "1" }, /Unknown pin key in .*tool\.pin: extra/],
    [{ platform: "linux-riscv64" }, /unknown platform/],
    [{ repo: "someone/tool" }, /unknown repo/],
    [{ tag: "1.0.0" }, /tag must be v1\.0\.0/],
    [{ sha256: "A".repeat(64) }, /sha256 must be/],
    [{ sha256: "a".repeat(63) }, /sha256 must be/],
    [{ asset: undefined }, /version and asset are required/],
  ];
  for (const [fields, message] of cases) {
    const f = fixture(t);
    const file = path.join(f.dir, "tool");
    fs.writeFileSync(file, binary);
    const run = f.run(f.pin({ asset: "tool", sha256, ...fields }), f.dest, "--from", file);
    assert.equal(run.status, 1, JSON.stringify(fields));
    assert.match(run.stderr, message, JSON.stringify(fields));
    assert.equal(fs.existsSync(f.dest), false);
  }
});

test("bad arguments print the usage", (t) => {
  const f = fixture(t);
  for (const args of [[], ["a.pin"], ["a.pin", "dest", "--from"], ["a.pin", "dest", "--force"]]) {
    const run = f.run(...args);
    assert.equal(run.status, 2, args.join(" "));
    assert.match(run.stderr, /^Usage: /);
  }
});

test("--dry-run prints the URL of every committed pin, given relative to the repository root", (t) => {
  const f = fixture(t);
  const pins = [
    "src-tauri/git-ai.pin",
    ...fs.readdirSync(path.join(root, "src-tauri/pins")).map((name) => `src-tauri/pins/${name}`),
  ];
  for (const pin of pins) {
    const fields = Object.fromEntries(
      fs
        .readFileSync(path.join(root, pin), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
    const run = f.run(pin, "src-tauri/resources/fetched/unused", "--dry-run");
    assert.equal(run.status, 0, `${pin}: ${run.stderr}`);
    assert.equal(
      run.stdout,
      `https://github.com/${fields.repo}/releases/download/${fields.tag}/${fields.asset}\n`,
    );
  }
});

test("fetch-bundled maps each host to its pins", (t) => {
  const f = fixture(t);
  const bin = path.join(f.dir, "bin");
  fs.mkdirSync(bin);
  const host = (os, arch, flag = "--dry-run") => {
    fs.writeFileSync(
      path.join(bin, "uname"),
      `#!/bin/sh\ncase "$1" in -s) echo ${os} ;; -m) echo ${arch} ;; esac\n`,
      { mode: 0o755 },
    );
    return spawnSync("bash", [path.join(root, "scripts/fetch-git-ai.sh"), flag], {
      cwd: f.dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  };
  const release = "https://github.com/starship/starship/releases/download/v1.24.2";
  for (const [os, arch, url] of [
    ["Darwin", "arm64", /\/git-ai\/releases\/download\/.*\/git-ai-macos-arm64\n$/],
    ["Darwin", "x86_64", /\/git-ai-macos-arm64\n$/],
    ["Linux", "x86_64", `${release}/starship-x86_64-unknown-linux-musl.tar.gz\n`],
    ["Linux", "aarch64", `${release}/starship-aarch64-unknown-linux-musl.tar.gz\n`],
  ]) {
    const run = host(os, arch);
    assert.equal(run.status, 0, `${os} ${arch}: ${run.stderr}`);
    if (typeof url === "string") assert.equal(run.stdout, url);
    else assert.match(run.stdout, url);
  }
  // The pin and destination other scripts read from here, so the mapping lives in one place.
  for (const [os, arch, pin, dest] of [
    ["Darwin", "arm64", "src-tauri/git-ai.pin", "src-tauri/resources/git-ai"],
    [
      "Linux",
      "x86_64",
      "src-tauri/pins/starship-linux-x86_64.pin",
      "src-tauri/resources/fetched/starship",
    ],
    [
      "Linux",
      "aarch64",
      "src-tauri/pins/starship-linux-aarch64.pin",
      "src-tauri/resources/fetched/starship",
    ],
  ]) {
    for (const [flag, expected] of [
      ["--print-pin", pin],
      ["--print-dest", dest],
    ]) {
      const run = host(os, arch, flag);
      assert.equal(run.status, 0, `${os} ${arch} ${flag}: ${run.stderr}`);
      assert.equal(run.stdout, `${expected}\n`);
    }
    assert.ok(fs.existsSync(path.join(root, pin)), pin);
  }
  for (const [os, arch] of [
    ["Linux", "riscv64"],
    ["FreeBSD", "amd64"],
  ]) {
    const run = host(os, arch);
    assert.equal(run.status, 1);
    assert.equal(run.stderr, `No pinned binaries for this host: ${os} ${arch}\n`);
    assert.equal(host(os, arch, "--print-pin").status, 1);
  }
  const bad = host("Linux", "x86_64", "--print");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /^Usage: /);
});

test("the checksum uses sha256sum or shasum, whichever the host has, and needs one", (t) => {
  const which = (name) =>
    spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
  const bash = which("bash");
  // A PATH holding only what the script runs besides the checksum tool, plus `tools`.
  const runWith = (f, tools, ...args) => {
    const bin = fs.mkdtempSync(path.join(f.dir, "bin-"));
    for (const name of ["dirname", "cp", "mktemp", "mkdir", "install", "mv", "rm", ...tools]) {
      fs.symlinkSync(which(name), path.join(bin, name));
    }
    return spawnSync(bash, [script, ...args], { cwd: f.dir, encoding: "utf8", env: { PATH: bin } });
  };
  for (const tool of ["sha256sum", "shasum"].filter(which)) {
    const f = fixture(t);
    const file = path.join(f.dir, "tool-linux");
    fs.writeFileSync(file, binary);
    const pin = f.pin({ asset: "tool-linux", sha256: f.sha256(file) });
    assertInstalled(f, runWith(f, [tool], pin, f.dest, "--from", file));
    fs.rmSync(path.dirname(f.dest), { recursive: true });
    const wrong = f.pin({ asset: "tool-linux", sha256: "0".repeat(64) });
    const run = runWith(f, [tool], wrong, f.dest, "--from", file);
    assert.equal(run.status, 1, tool);
    assert.match(run.stderr, /SHA-256 mismatch/, tool);
  }
  const f = fixture(t);
  const file = path.join(f.dir, "tool-linux");
  fs.writeFileSync(file, binary);
  const run = runWith(
    f,
    [],
    f.pin({ asset: "tool-linux", sha256: f.sha256(file) }),
    f.dest,
    "--from",
    file,
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /neither sha256sum nor shasum is installed/);
  assert.equal(fs.existsSync(f.dest), false);
});
