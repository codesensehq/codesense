// SPDX-License-Identifier: MIT
// node --test scripts/ci/smoke-linux.node-test.mjs (the Linux packaging smoke's checks)
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("smoke-linux.sh", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-linux-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
let fixtures = 0;
const fixture = (lines) => {
  const file = path.join(dir, `fixture-${fixtures++}`);
  fs.writeFileSync(file, lines.map((line) => `${line}\n`).join(""));
  return file;
};
const smoke = (...args) => spawnSync("bash", [script, ...args], { encoding: "utf8" });
const passes = (result) => assert.equal(result.status, 0, result.stderr);
const fails = (result, error) => {
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, error);
};

// What `dpkg -L` prints for the deb: directories too, and the app's files under /usr/lib.
const debListing = [
  "/.",
  "/usr",
  "/usr/bin",
  "/usr/bin/codesense",
  "/usr/bin/codesense-bridge",
  "/usr/bin/codesense-emulator",
  "/usr/bin/codesense-session-server",
  "/usr/lib/CodeSense/resources/starship-compact.toml",
  "/usr/share/applications/CodeSense.desktop",
];

test("check-listing: the app binary and the three sidecars in /usr/bin pass", () => {
  passes(smoke("check-listing", fixture(debListing)));
});

test("check-listing: a missing sidecar, a wrong app binary or an extra file in /usr/bin fails", () => {
  fails(
    smoke("check-listing", fixture(debListing.filter((line) => !line.endsWith("-emulator")))),
    /codesense-emulator is not in \/usr\/bin/,
  );
  // Four files, but the app binary is not the one the product names.
  fails(
    smoke(
      "check-listing",
      fixture(debListing.map((line) => (line === "/usr/bin/codesense" ? "/usr/bin/other" : line))),
    ),
    /codesense is not in \/usr\/bin/,
  );
  fails(
    smoke("check-listing", fixture([...debListing, "/usr/bin/extra"])),
    /expected only codesense and its three sidecars/,
  );
});

test("same-resources: the deb and the rpm must ship the same starship and git-ai", () => {
  const starship = "/usr/lib/CodeSense/resources/starship";
  const gitAi = "/usr/lib/CodeSense/resources/git-ai";
  passes(smoke("same-resources", fixture(debListing), fixture(debListing)));
  // Listed in any order.
  passes(
    smoke("same-resources", fixture([...debListing, starship, gitAi]), fixture([gitAi, starship])),
  );
  fails(
    smoke("same-resources", fixture([...debListing, starship]), fixture(debListing)),
    /resources\/starship/,
  );
  fails(
    smoke("same-resources", fixture([gitAi, starship]), fixture([starship])),
    /resources\/git-ai/,
  );
});

// The app's stdout log: a coloured timestamp, level and target before each message.
const logLine = (message, target = "system") =>
  `\x1b[32m05:21:09 [INFO ]\x1b[0m \x1b[37m[${target}]\x1b[0m ${message}`;
const appLog = (caps) => [
  logLine("webview ready"),
  ...(caps === undefined ? [] : [logLine(caps)]),
  logLine("secret store: secret-service", "auth"),
];
// What `find squashfs-root` lists for the extracted AppImage.
const extracted = (...resources) => [
  "squashfs-root/AppRun",
  "squashfs-root/usr/bin/codesense",
  "squashfs-root/usr/lib/CodeSense/resources/starship-compact.toml",
  ...resources.map((name) => `squashfs-root/usr/lib/CodeSense/resources/${name}`),
];
const capsAgree = (listing, caps) => smoke("caps-agree", fixture(listing), fixture(appLog(caps)));

test("caps-agree: a capability is on exactly when its binary is bundled", () => {
  passes(capsAgree(extracted(), "caps: git-ai=off starship=off"));
  passes(capsAgree(extracted("starship", "git-ai"), "caps: git-ai=on starship=on"));
  passes(capsAgree(extracted("starship"), "caps: git-ai=off starship=on"));
  // Other capabilities on the line, such as secret-store after them, are not this check's.
  passes(capsAgree(extracted(), "caps: git-ai=off starship=off secret-store=on"));
  passes(capsAgree(extracted("starship"), "caps: git-ai=off starship=on secret-store=off"));
  passes(capsAgree(extracted(), "caps: bridge=on git-ai=off secret-store=on starship=off"));
});

test("caps-agree: a bundled binary that is off, or an absent one that is on, fails", () => {
  fails(
    capsAgree(extracted("starship"), "caps: git-ai=off starship=off"),
    /starship=off.*resources\/starship is bundled/,
  );
  fails(
    capsAgree(extracted(), "caps: git-ai=on starship=off"),
    /git-ai=on.*resources\/git-ai is not bundled/,
  );
});

test("caps-agree: a missing caps: line, a second one or a missing key fails", () => {
  fails(capsAgree(extracted(), undefined), /expected one caps: line, found 0/);
  fails(
    smoke(
      "caps-agree",
      fixture(extracted()),
      fixture([
        ...appLog("caps: git-ai=off starship=off"),
        logLine("caps: git-ai=off starship=off"),
      ]),
    ),
    /expected one caps: line, found 2/,
  );
  fails(capsAgree(extracted(), "caps: git-ai=off"), /starship=<none>/);
});

// A home where the app installed a git-ai that prints `version`, checked as a Linux x86_64 host
// against the repository's own pin, so `pinned` must be that pin's version.
const pinned = fs
  .readFileSync(
    fileURLToPath(new URL("../../src-tauri/pins/git-ai-linux-x86_64.pin", import.meta.url)),
    "utf8",
  )
  .match(/^version=(.+)$/m)[1];
const uname = path.join(dir, "uname-bin");
fs.mkdirSync(uname);
fs.writeFileSync(
  path.join(uname, "uname"),
  '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n',
  { mode: 0o755 },
);
const installedGitAi = (listing, version) => {
  const home = fs.mkdtempSync(path.join(dir, "home-"));
  if (version !== undefined) {
    const bin = path.join(home, ".codesense/bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "git-ai"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  }
  return spawnSync("bash", [script, "installed-git-ai", fixture(listing), home], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${uname}:${process.env.PATH}` },
  });
};

test("installed-git-ai: a bundled git-ai is installed at the pinned version", () => {
  passes(installedGitAi(extracted("starship", "git-ai"), pinned));
  // Without the bundled binary the app installs none.
  passes(installedGitAi(extracted("starship"), undefined));
});

test("installed-git-ai: a missing install, another version or an unbundled install fails", () => {
  fails(installedGitAi(extracted("git-ai"), undefined), /did not install git-ai/);
  fails(
    installedGitAi(extracted("git-ai"), "0.0.1"),
    new RegExp(`prints 0\\.0\\.1, not ${pinned.replaceAll(".", "\\.")} as pinned`),
  );
  fails(installedGitAi(extracted(), pinned), /resources\/git-ai is not bundled/);
});
