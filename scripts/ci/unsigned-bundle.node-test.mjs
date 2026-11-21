// SPDX-License-Identifier: MIT
// node --test scripts/ci/unsigned-bundle.node-test.mjs (the Linux bundle's channel input)
//
// Runs unsigned-bundle.sh linux in a fixture tree with pnpm and the build scripts stubbed, and checks
// the tauri commands it runs: unchanged with no channel, the channel's configs, feature and
// CODESENSE_CHANNEL with CODESENSE_BUNDLE_CHANNEL, and a refusal before any build when a channel
// bundle lacks what it needs.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("unsigned-bundle.sh", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unsigned-bundle-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (file, text, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
};

// pnpm exec tauri build|bundle ...: logs its arguments and CODESENSE_CHANNEL, one line per call, and
// makes the files that call bundles.
const bin = path.join(dir, "bin");
write(
  path.join(bin, "pnpm"),
  `#!/usr/bin/env bash
[[ "$1 $2" == "exec tauri" ]] || exit 2
shift 2
printf '%s|%s\\n' "\${CODESENSE_CHANNEL:-}" "$*" >>"$STUB_LOG"
b=target/release/bundle
case "$1" in
  build) mkdir -p "$b/deb" "$b/rpm"; : >"$b/deb/CodeSense_1_amd64.deb"; : >"$b/rpm/CodeSense-1.x86_64.rpm" ;;
  bundle) mkdir -p "$b/appimage"; : >"$b/appimage/CodeSense_1_amd64.AppImage" ;;
esac
`,
  0o755,
);

let trees = 0;
/** A fixture tree holding the script, stub build scripts and the configs; `confs` the channel ones. */
function tree(confs = ["tauri.beta-prod.conf.json", "tauri.beta-staging.conf.json"]) {
  const root = path.join(dir, `tree-${trees++}`);
  write(path.join(root, "scripts/ci/unsigned-bundle.sh"), fs.readFileSync(script, "utf8"), 0o755);
  for (const stub of [
    "scripts/fetch-bundled.sh",
    "scripts/build-bridge.sh",
    "scripts/build-session-server.sh",
    "scripts/ci/repair-appimage.sh",
  ])
    write(path.join(root, stub), "exit 0\n", 0o755);
  write(
    path.join(root, "src-tauri/tauri.linux.conf.json"),
    JSON.stringify({
      bundle: {
        externalBin: [
          "binaries/codesense-bridge",
          "binaries/codesense-session-server",
          "binaries/codesense-emulator",
        ],
      },
    }),
  );
  for (const conf of ["tauri.unsigned.conf.json", "tauri.beta.conf.json", ...confs])
    write(path.join(root, "src-tauri", conf), "{}\n");
  return root;
}

const CHANNEL_ENV = {
  CODESENSE_DASH_HOST: "https://share.example.invalid",
  CODESENSE_RELEASED_AT: "1760000000",
};

function bundle(root, env = {}, platform = "linux") {
  const log = path.join(root, "calls.log");
  const base = { ...process.env };
  for (const k of Object.keys(base))
    if (k.startsWith("CODESENSE_") || k === "RUNNER_TEMP") delete base[k];
  const result = spawnSync("bash", [path.join(root, "scripts/ci/unsigned-bundle.sh"), platform], {
    encoding: "utf8",
    env: {
      ...base,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_LOG: log,
      RUNNER_TEMP: root,
      ...env,
    },
  });
  const calls = fs.existsSync(log)
    ? fs
        .readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const [channel, args] = line.split("|");
          return { channel, args };
        })
    : [];
  return { ...result, calls };
}

const APPIMAGE_CONFIG = JSON.stringify({
  bundle: { externalBin: ["binaries/codesense-bridge", "binaries/codesense-session-server"] },
});

test("with no channel the test build is unchanged", () => {
  const r = bundle(tree());
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, [
    {
      channel: "",
      args: "build --config src-tauri/tauri.unsigned.conf.json --verbose --bundles deb,rpm",
    },
    {
      channel: "",
      args: `bundle --verbose --bundles appimage --config src-tauri/tauri.unsigned.conf.json --config ${APPIMAGE_CONFIG}`,
    },
  ]);
});

for (const [channel, conf] of [
  ["beta-staging", "src-tauri/tauri.beta-staging.conf.json"],
  ["beta", "src-tauri/tauri.beta-prod.conf.json"],
]) {
  test(`CODESENSE_BUNDLE_CHANNEL=${channel} builds and bundles with that channel's configs`, () => {
    const r = bundle(tree(), { ...CHANNEL_ENV, CODESENSE_BUNDLE_CHANNEL: channel });
    assert.equal(r.status, 0, r.stderr);
    const configs = `--config src-tauri/tauri.unsigned.conf.json --config src-tauri/tauri.beta.conf.json --config ${conf}`;
    assert.deepEqual(r.calls, [
      {
        channel,
        args: `build ${configs} --features dashboard-publish --verbose --bundles deb,rpm`,
      },
      {
        channel,
        args: `bundle --verbose --bundles appimage ${configs} --config ${APPIMAGE_CONFIG}`,
      },
    ]);
  });
}

for (const [name, env, error, root] of [
  [
    "without CODESENSE_RELEASED_AT",
    { CODESENSE_DASH_HOST: CHANNEL_ENV.CODESENSE_DASH_HOST },
    /needs CODESENSE_RELEASED_AT/,
  ],
  [
    "with a CODESENSE_RELEASED_AT that is not unix seconds",
    { ...CHANNEL_ENV, CODESENSE_RELEASED_AT: "soon" },
    /needs CODESENSE_RELEASED_AT/,
  ],
  [
    "without CODESENSE_DASH_HOST",
    { CODESENSE_RELEASED_AT: CHANNEL_ENV.CODESENSE_RELEASED_AT },
    /needs CODESENSE_DASH_HOST/,
  ],
  [
    "without the channel's config",
    CHANNEL_ENV,
    /tauri\.beta-staging\.conf\.json is missing/,
    () => tree(["tauri.beta-prod.conf.json"]),
  ],
]) {
  test(`a channel bundle ${name} is refused before any build`, () => {
    const r = bundle((root ?? tree)(), { ...env, CODESENSE_BUNDLE_CHANNEL: "beta-staging" });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, error);
    assert.deepEqual(r.calls, []);
  });
}

test("an unknown channel, or a channel on macOS, is refused before any build", () => {
  let r = bundle(tree(), { ...CHANNEL_ENV, CODESENSE_BUNDLE_CHANNEL: "internal" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be beta or beta-staging/);
  assert.deepEqual(r.calls, []);
  r = bundle(tree(), { ...CHANNEL_ENV, CODESENSE_BUNDLE_CHANNEL: "beta" }, "macos");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is for a Linux bundle/);
  assert.deepEqual(r.calls, []);
});
