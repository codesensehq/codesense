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
  const gitAi = fs.readFileSync(path.join(root, "src-tauri/pins/git-ai-macos-arm64.pin"), "utf8");
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

test("every supported platform is accepted", (t) => {
  for (const platform of [
    "macos-arm64",
    "linux-x86_64",
    "linux-aarch64",
    "windows-x86_64",
    "windows-arm64",
  ]) {
    const f = fixture(t);
    const file = path.join(f.dir, "tool");
    fs.writeFileSync(file, binary);
    const pin = f.pin({ asset: "tool", platform, sha256: f.sha256(file) });
    assertInstalled(f, f.run(pin, f.dest, "--from", file));
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
  const pins = fs
    .readdirSync(path.join(root, "src-tauri/pins"))
    .map((name) => `src-tauri/pins/${name}`);
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
  const host = (os, arch, ...flags) => {
    fs.writeFileSync(
      path.join(bin, "uname"),
      `#!/bin/sh\ncase "$1" in -s) echo ${os} ;; -m) echo ${arch} ;; esac\n`,
      { mode: 0o755 },
    );
    return spawnSync(
      "bash",
      [path.join(root, "scripts/fetch-git-ai.sh"), ...(flags.length ? flags : ["--dry-run"])],
      {
        cwd: f.dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
  };
  const release = "https://github.com/starship/starship/releases/download/v1.24.2";
  // A git-ai URL from its pin, so the test names the git-ai repository nowhere but the pin.
  const gitAi = (platform, asset) => {
    const pin = fs.readFileSync(path.join(root, `src-tauri/pins/git-ai-${platform}.pin`), "utf8");
    const field = (key) => pin.match(new RegExp(`^${key}=(.*)$`, "m"))[1];
    assert.equal(field("asset"), asset);
    return `https://github.com/${field("repo")}/releases/download/${field("tag")}/${asset}`;
  };
  const macGitAi = gitAi("macos-arm64", "git-ai-macos-arm64");
  assert.match(macGitAi, /\/v1\.7\.5-cs\.4\//);
  // Each host prints exactly one URL per pinned binary, in order, so an extra pin fails here:
  // macOS bundles git-ai; Linux bundles git-ai and starship.
  for (const [os, arch, urls] of [
    ["Darwin", "arm64", [macGitAi]],
    ["Darwin", "x86_64", [macGitAi]],
    [
      "Linux",
      "x86_64",
      [
        gitAi("linux-x86_64", "git-ai-linux-x86_64"),
        `${release}/starship-x86_64-unknown-linux-musl.tar.gz`,
      ],
    ],
    [
      "Linux",
      "aarch64",
      [
        gitAi("linux-aarch64", "git-ai-linux-arm64"),
        `${release}/starship-aarch64-unknown-linux-musl.tar.gz`,
      ],
    ],
  ]) {
    const run = host(os, arch);
    assert.equal(run.status, 0, `${os} ${arch}: ${run.stderr}`);
    assert.equal(run.stdout, urls.map((url) => `${url}\n`).join(""));
  }
  // The pin and destination other scripts read from here, by binary, so the mapping lives in
  // one place and a host with several pins is never ambiguous.
  for (const [os, arch, name, unknowns, pin, dest] of [
    [
      "Darwin",
      "arm64",
      "git-ai",
      ["starship"],
      "src-tauri/pins/git-ai-macos-arm64.pin",
      "src-tauri/resources/git-ai",
    ],
    ...["x86_64", "aarch64"].flatMap((arch) => [
      [
        "Linux",
        arch,
        "git-ai",
        [],
        `src-tauri/pins/git-ai-linux-${arch}.pin`,
        "src-tauri/resources/git-ai",
      ],
      [
        "Linux",
        arch,
        "starship",
        [],
        `src-tauri/pins/starship-linux-${arch}.pin`,
        "src-tauri/resources/fetched/starship",
      ],
    ]),
  ]) {
    for (const [flag, expected] of [
      ["--print-pin", pin],
      ["--print-dest", dest],
    ]) {
      const run = host(os, arch, flag, name);
      assert.equal(run.status, 0, `${os} ${arch} ${flag} ${name}: ${run.stderr}`);
      assert.equal(run.stdout, `${expected}\n`);
      // A binary this host does not bundle is refused, not answered with another's pin.
      for (const unknown of [...unknowns, "no-such-tool"]) {
        const refused = host(os, arch, flag, unknown);
        assert.equal(refused.status, 1, `${os} ${arch} ${flag} ${unknown}`);
        assert.equal(refused.stdout, "");
        assert.equal(refused.stderr, `This host does not bundle ${unknown}: ${os} ${arch}\n`);
      }
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
    assert.equal(host(os, arch, "--print-pin", "starship").status, 1);
  }
  // A print flag needs exactly one name.
  for (const flags of [["--print"], ["--print-pin"], ["--print-dest", "starship", "git-ai"]]) {
    const bad = host("Linux", "x86_64", ...flags);
    assert.equal(bad.status, 2, flags.join(" "));
    assert.match(bad.stderr, /^Usage: /);
  }
});

test("fetch-bundled names its binaries and checks their versions from the pins alone", (t) => {
  const f = fixture(t);
  // A copy of the script in a tree of its own pins, on a PATH whose uname says the host and whose
  // curl fails, so a mode that reached the network would fail here.
  const tree = path.join(f.dir, "tree");
  const bin = path.join(f.dir, "bin");
  for (const dir of ["scripts", "src-tauri/pins"])
    fs.mkdirSync(path.join(tree, dir), { recursive: true });
  fs.mkdirSync(bin);
  fs.copyFileSync(
    path.join(root, "scripts/fetch-bundled.sh"),
    path.join(tree, "scripts/fetch-bundled.sh"),
  );
  fs.writeFileSync(path.join(bin, "curl"), "#!/bin/sh\necho curl was run >&2\nexit 1\n", {
    mode: 0o755,
  });
  const write = (name, text) => {
    fs.writeFileSync(name, text, { mode: 0o755 });
    return name;
  };
  const host = (scriptRoot, os, arch, ...flags) => {
    write(
      path.join(bin, "uname"),
      `#!/bin/sh\ncase "$1" in -s) echo ${os} ;; -m) echo ${arch} ;; esac\n`,
    );
    return spawnSync("bash", [path.join(scriptRoot, "scripts/fetch-bundled.sh"), ...flags], {
      cwd: f.dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  };
  // The repository's own table: each host's names in order, and each pin's version.
  for (const [os, arch, names] of [
    ["Darwin", "arm64", ["git-ai"]],
    ["Linux", "x86_64", ["git-ai", "starship"]],
    ["Linux", "aarch64", ["git-ai", "starship"]],
  ]) {
    const run = host(root, os, arch, "--print-names");
    assert.equal(run.status, 0, `${os} ${arch}: ${run.stderr}`);
    assert.equal(run.stdout, names.map((name) => `${name}\n`).join(""));
    for (const name of names) {
      const pin = host(root, os, arch, "--print-pin", name).stdout.trim();
      const version = fs.readFileSync(path.join(root, pin), "utf8").match(/^version=(.+)$/m)[1];
      const printed = host(root, os, arch, "--print-version", name);
      assert.equal(printed.status, 0, printed.stderr);
      assert.equal(printed.stdout, `${version}\n`);
    }
  }
  // The fetch loop reads the same entries: with a stub fetch-pinned.sh that prints its argument
  // count and arguments, each call is exactly the pin and destination the print modes give, in
  // --print-names order, and --dry-run is passed through.
  write(path.join(tree, "scripts/fetch-pinned.sh"), '#!/bin/sh\necho "$# $*"\n');
  for (const [os, arch] of [
    ["Darwin", "arm64"],
    ["Linux", "x86_64"],
    ["Linux", "aarch64"],
  ]) {
    const print = (...flags) => {
      const run = host(tree, os, arch, ...flags);
      assert.equal(run.status, 0, `${os} ${arch} ${flags.join(" ")}: ${run.stderr}`);
      return run.stdout;
    };
    const calls = print("--print-names")
      .trim()
      .split("\n")
      .map((name) => `${print("--print-pin", name).trim()} ${print("--print-dest", name).trim()}`);
    assert.equal(print(), calls.map((call) => `2 ${call}\n`).join(""));
    assert.equal(print("--dry-run"), calls.map((call) => `3 ${call} --dry-run\n`).join(""));
  }
  // An entry with a field too many, or without a pin and destination, is refused by every mode,
  // also one that asks only for another entry.
  const script = fs.readFileSync(path.join(root, "scripts/fetch-bundled.sh"), "utf8");
  for (const [label, badName, from, to] of [
    [
      "a fifth field",
      "git-ai",
      '"git-ai $pins/git-ai-linux-$arch.pin $resources/git-ai"',
      '"git-ai $pins/git-ai-linux-$arch.pin $resources/git-ai git-ai extra"',
    ],
    [
      "no destination",
      "git-ai",
      '"git-ai $pins/git-ai-linux-$arch.pin $resources/git-ai"',
      '"git-ai src-tauri/pins/git-ai-linux-$arch.pin"',
    ],
    [
      "a bad starship",
      "starship",
      '$resources/fetched/starship starship"',
      '$resources/fetched/starship starship extra"',
    ],
  ]) {
    const bad = path.join(f.dir, `bad-${label.replaceAll(" ", "-")}`);
    fs.mkdirSync(path.join(bad, "scripts"), { recursive: true });
    assert.ok(script.includes(from), label);
    write(path.join(bad, "scripts/fetch-bundled.sh"), script.replace(from, to));
    write(path.join(bad, "scripts/fetch-pinned.sh"), '#!/bin/sh\necho "$# $*"\n');
    for (const flags of [
      [],
      ["--print-names"],
      ["--print-pin", "git-ai"],
      ["--print-dest", "git-ai"],
      ["--print-version", "git-ai"],
      ["--print-dest", "starship"],
      ["--check-version", "git-ai", path.join(bad, "no-such-binary")],
    ]) {
      const run = host(bad, "Linux", "x86_64", ...flags);
      assert.equal(run.status, 1, `${label} ${flags.join(" ")}`);
      assert.equal(run.stdout, "", `${label} ${flags.join(" ")}`);
      assert.ok(
        run.stderr.startsWith(`bad bundled entry: ${badName} `),
        `${label} ${flags.join(" ")}: ${run.stderr}`,
      );
    }
  }
  // The fixture tree: git-ai prints its bare version, starship its name first; only the first
  // line counts.
  const pins = path.join(tree, "src-tauri/pins");
  fs.writeFileSync(path.join(pins, "git-ai-linux-x86_64.pin"), "version=1.7.5-cs.5\n");
  fs.writeFileSync(path.join(pins, "starship-linux-x86_64.pin"), "version=1.24.2\n");
  const tool = (name, out, status = 0) =>
    write(path.join(f.dir, name), `#!/bin/sh\nprintf '${out}'\nexit ${status}\n`);
  const check = (name, binary) => host(tree, "Linux", "x86_64", "--check-version", name, binary);
  const gitAi = tool("git-ai", "1.7.5-cs.5\\nmore\\n");
  const starship = tool("starship", "starship 1.24.2\\nbranch main\\n");
  for (const [name, binary, line] of [
    ["git-ai", gitAi, "1.7.5-cs.5"],
    ["starship", starship, "starship 1.24.2"],
  ]) {
    const run = check(name, binary);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, `${binary}: ${line}\n`);
  }
  for (const [name, binary, error] of [
    // Another version, the other binary's form, a failing binary and an unbundled name.
    [
      "git-ai",
      tool("old", "1.7.5-cs.4\\n"),
      /prints 1\.7\.5-cs\.4, not 1\.7\.5-cs\.5 as pinned in src-tauri\/pins\/git-ai-linux-x86_64\.pin/,
    ],
    ["starship", tool("bare", "1.24.2\\n"), /prints 1\.24\.2, not starship 1\.24\.2/],
    ["git-ai", tool("broken", "", 3), /broken failed to run \(exit 3\)/],
    ["no-such-tool", gitAi, /^This host does not bundle no-such-tool: Linux x86_64$/m],
  ]) {
    const run = check(name, binary);
    assert.equal(run.status, 1, `${name} ${binary}`);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, error);
  }
  // A pin without a version fails both modes.
  fs.writeFileSync(path.join(pins, "git-ai-linux-x86_64.pin"), "asset=git-ai-linux-x86_64\n");
  for (const flags of [
    ["--print-version", "git-ai"],
    ["--check-version", "git-ai", gitAi],
  ]) {
    const run = host(tree, "Linux", "x86_64", ...flags);
    assert.equal(run.status, 1, flags.join(" "));
    assert.equal(run.stderr, "src-tauri/pins/git-ai-linux-x86_64.pin has no version\n");
  }
  // --print-names takes nothing; --check-version needs a name and a binary.
  for (const flags of [
    ["--print-names", "git-ai"],
    ["--print-version"],
    ["--check-version", "git-ai"],
  ]) {
    const bad = host(tree, "Linux", "x86_64", ...flags);
    assert.equal(bad.status, 2, flags.join(" "));
    assert.match(bad.stderr, /^Usage: /);
  }
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
