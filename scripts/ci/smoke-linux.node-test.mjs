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
const appindicator = "squashfs-root/usr/lib/libayatana-appindicator3.so.1";
const extracted = (...resources) => [
  "squashfs-root/AppRun",
  "squashfs-root/usr/bin/codesense",
  "squashfs-root/usr/lib/CodeSense/resources/starship-compact.toml",
  appindicator,
  ...resources.map((name) => `squashfs-root/usr/lib/CodeSense/resources/${name}`),
];
const withoutAppindicator = (listing) => listing.filter((line) => line !== appindicator);
const capsAgree = (listing, caps) => smoke("caps-agree", fixture(listing), fixture(appLog(caps)));

const TRAY = "terminal-server-tray=on";

test("caps-agree: a capability is on exactly when its binary is bundled", () => {
  passes(capsAgree(extracted(), `caps: git-ai=off starship=off ${TRAY}`));
  passes(capsAgree(extracted("starship", "git-ai"), `caps: git-ai=on starship=on ${TRAY}`));
  passes(capsAgree(extracted("starship"), `caps: git-ai=off starship=on ${TRAY}`));
  // Other capabilities on the line, such as secret-store after them, are not this check's.
  passes(capsAgree(extracted(), `caps: git-ai=off starship=off secret-store=on ${TRAY}`));
  passes(capsAgree(extracted("starship"), `caps: git-ai=off starship=on ${TRAY} secret-store=off`));
  passes(capsAgree(extracted(), `caps: bridge=on git-ai=off secret-store=on starship=off ${TRAY}`));
});

test("caps-agree: the tray icon is on exactly when an AppIndicator library is bundled", () => {
  passes(
    capsAgree(
      withoutAppindicator(extracted()),
      "caps: git-ai=off starship=off terminal-server-tray=off",
    ),
  );
  for (const library of [
    "squashfs-root/usr/lib/libayatana-appindicator3.so",
    "squashfs-root/usr/lib/libappindicator3.so.1",
    "squashfs-root/usr/lib/libappindicator3.so",
  ]) {
    passes(
      capsAgree(
        [...withoutAppindicator(extracted()), library],
        `caps: git-ai=off starship=off ${TRAY}`,
      ),
    );
  }
  fails(
    capsAgree(extracted(), "caps: git-ai=off starship=off terminal-server-tray=off"),
    /terminal-server-tray=off.*the AppIndicator library is bundled/,
  );
  fails(
    capsAgree(withoutAppindicator(extracted()), `caps: git-ai=off starship=off ${TRAY}`),
    /terminal-server-tray=on.*no AppIndicator library is bundled/,
  );
  fails(capsAgree(extracted(), "caps: git-ai=off starship=off"), /terminal-server-tray=<none>/);
});

test("caps-agree: a bundled binary that is off, or an absent one that is on, fails", () => {
  fails(
    capsAgree(extracted("starship"), `caps: git-ai=off starship=off ${TRAY}`),
    /starship=off.*resources\/starship is bundled/,
  );
  fails(
    capsAgree(extracted(), `caps: git-ai=on starship=off ${TRAY}`),
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
        ...appLog(`caps: git-ai=off starship=off ${TRAY}`),
        logLine(`caps: git-ai=off starship=off ${TRAY}`),
      ]),
    ),
    /expected one caps: line, found 2/,
  );
  fails(capsAgree(extracted(), `caps: git-ai=off ${TRAY}`), /starship=<none>/);
});

test("appindicator-bundled: the AppImage must hold an AppIndicator library", () => {
  passes(smoke("appindicator-bundled", fixture(extracted())));
  passes(
    smoke(
      "appindicator-bundled",
      fixture([...withoutAppindicator(extracted()), "squashfs-root/usr/lib/libappindicator3.so"]),
    ),
  );
  fails(
    smoke("appindicator-bundled", fixture(withoutAppindicator(extracted()))),
    /holds no AppIndicator library/,
  );
  // A name that only starts like one, or another library, is not it.
  fails(
    smoke(
      "appindicator-bundled",
      fixture([
        ...withoutAppindicator(extracted()),
        "squashfs-root/usr/lib/libayatana-appindicator3.so.1.0.0.bak",
        "squashfs-root/usr/lib/libayatana-indicator3.so.7",
      ]),
    ),
    /holds no AppIndicator library/,
  );
});

test("seed-tray: the app state under the data home turns the tray icon setting on", () => {
  const home = fs.mkdtempSync(path.join(dir, "data-"));
  passes(smoke("seed-tray", home));
  const config = JSON.parse(
    fs.readFileSync(path.join(home, "ai.codesense", "app-state.json"), "utf8"),
  );
  assert.deepEqual(config, { viewer: { settings: { terminalServerMenuBar: true } } });
  // The directory is the app's: its identifier names it.
  const tauri = JSON.parse(
    fs.readFileSync(
      fileURLToPath(new URL("../../src-tauri/tauri.conf.json", import.meta.url)),
      "utf8",
    ),
  );
  assert.equal(tauri.identifier, "ai.codesense");
});

// The subcommand run with a fake ldconfig on PATH that prints `lines`.
const withLdconfig = (command, lines) => {
  const bin = fs.mkdtempSync(path.join(dir, "bin-"));
  fs.writeFileSync(
    path.join(bin, "ldconfig"),
    `#!/bin/sh\ncat <<'EOF'\n${lines.join("\n")}\nEOF\n`,
    { mode: 0o755 },
  );
  return spawnSync("bash", [script, command], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
};

test("no-installed-appindicator: the tray launch needs a runner without the library", () => {
  const header = "1234 libs found in cache `/etc/ld.so.cache'";
  const libc = "\tlibc.so.6 (libc6,x86-64) => /lib/x86_64-linux-gnu/libc.so.6";
  const check = (lines) => withLdconfig("no-installed-appindicator", lines);
  passes(check([header, libc]));
  passes(
    check([
      header,
      "\tlibayatana-indicator3.so.7 (libc6,x86-64) => /lib/libayatana-indicator3.so.7",
    ]),
  );
  fails(
    check([
      header,
      "\tlibayatana-appindicator3.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libayatana-appindicator3.so.1",
    ]),
    /already finds an AppIndicator library on this machine: libayatana-appindicator3.so.1/,
  );
  fails(
    check([header, "\tlibappindicator3.so (libc6,x86-64) => /lib/libappindicator3.so"]),
    /already finds/,
  );
});

test("installed-appindicator: ldconfig must find an AppIndicator library", () => {
  const ldconfig = (lines) => withLdconfig("installed-appindicator", lines);
  const header = "1234 libs found in cache `/etc/ld.so.cache'";
  const libc = "\tlibc.so.6 (libc6,x86-64) => /lib/x86_64-linux-gnu/libc.so.6";
  passes(
    ldconfig([
      header,
      "\tlibayatana-appindicator3.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libayatana-appindicator3.so.1",
      libc,
    ]),
  );
  passes(
    ldconfig([header, "\tlibappindicator3.so.1 (libc6,AArch64) => /lib64/libappindicator3.so.1"]),
  );
  fails(ldconfig([header, libc]), /ldconfig finds no AppIndicator library/);
  fails(
    ldconfig([
      header,
      "\tlibayatana-indicator3.so.7 (libc6,x86-64) => /lib/libayatana-indicator3.so.7",
    ]),
    /ldconfig finds no AppIndicator library/,
  );
});

test("tray-launch: the caps: line has the tray icon on and the item turned on", () => {
  const caps = `caps: git-ai=on starship=on secret-store=on ${TRAY}`;
  const on = logLine("menu-bar item on", "terminal_server_tray");
  const trayLaunch = (lines) => smoke("tray-launch", fixture(lines));
  passes(trayLaunch([...appLog(caps), on]));
  fails(
    trayLaunch([...appLog("caps: git-ai=on starship=on terminal-server-tray=off"), on]),
    /does not have terminal-server-tray=on/,
  );
  fails(trayLaunch(appLog(caps)), /tray item turned on/);
  fails(
    trayLaunch([...appLog(caps), logLine("menu-bar item on", "system")]),
    /tray item turned on/,
  );
});

// A home where the app installed a git-ai that prints `version`, and a pin naming `pinned`.
const installedGitAi = (listing, version, pinned = "1.7.5-cs.5") => {
  const home = fs.mkdtempSync(path.join(dir, "home-"));
  if (version !== undefined) {
    const bin = path.join(home, ".codesense/bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "git-ai"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  }
  const pin = fixture([`version=${pinned}`, "asset=git-ai-linux-x86_64"]);
  return smoke("installed-git-ai", fixture(listing), home, pin);
};

test("installed-git-ai: a bundled git-ai is installed at the pinned version", () => {
  passes(installedGitAi(extracted("starship", "git-ai"), "1.7.5-cs.5"));
  // Without the bundled binary the app installs none.
  passes(installedGitAi(extracted("starship"), undefined));
});

test("installed-git-ai: a missing install, another version or an unbundled install fails", () => {
  fails(installedGitAi(extracted("git-ai"), undefined), /did not install git-ai/);
  fails(
    installedGitAi(extracted("git-ai"), "1.7.5-cs.4"),
    /prints 1\.7\.5-cs\.4, not the pinned 1\.7\.5-cs\.5/,
  );
  fails(installedGitAi(extracted(), "1.7.5-cs.5"), /resources\/git-ai is not bundled/);
  fails(installedGitAi(extracted("git-ai"), "1.7.5-cs.5", ""), /has no version/);
});

test("apt-mirror: the archive and security sources of 22.04 and 24.04 move to the mirror", () => {
  const mirror = "http://azure.archive.ubuntu.com/ubuntu/";
  const list = fixture([
    "deb http://archive.ubuntu.com/ubuntu/ jammy main restricted",
    "deb http://security.ubuntu.com/ubuntu/ jammy-security main restricted",
  ]);
  const sources = fixture([
    "Types: deb",
    "URIs: http://archive.ubuntu.com/ubuntu",
    "Suites: noble noble-updates",
    "",
    "Types: deb",
    "URIs: http://security.ubuntu.com/ubuntu/",
    "Suites: noble-security",
  ]);
  passes(smoke("apt-mirror", mirror, list, path.join(dir, "absent"), sources));
  assert.equal(
    fs.readFileSync(list, "utf8"),
    `deb ${mirror} jammy main restricted\ndeb ${mirror} jammy-security main restricted\n`,
  );
  assert.deepEqual(
    fs
      .readFileSync(sources, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("URIs:")),
    [`URIs: ${mirror}`, `URIs: ${mirror}`],
  );
});

test("apt-mirror: ports.ubuntu.com, which arm64 uses, is left as it is", () => {
  const ports = ["URIs: http://ports.ubuntu.com/ubuntu-ports/", "Suites: noble"];
  const sources = fixture(ports);
  passes(smoke("apt-mirror", "http://azure.archive.ubuntu.com/ubuntu/", sources));
  assert.equal(fs.readFileSync(sources, "utf8"), ports.map((line) => `${line}\n`).join(""));
});

// cache-key reads the deb with dpkg-deb; a stand-in on PATH answers from FAKE_ARCH and
// FAKE_DEPENDS.
const fakeBin = path.join(dir, "bin");
fs.mkdirSync(fakeBin);
fs.writeFileSync(
  path.join(fakeBin, "dpkg-deb"),
  '#!/bin/bash\ncase "$3" in Architecture) echo "$FAKE_ARCH" ;; Depends) echo "$FAKE_DEPENDS" ;; esac\n',
  { mode: 0o755 },
);
const packages = path.join(dir, "packages");
fs.mkdirSync(packages);
fs.writeFileSync(path.join(packages, "CodeSense_0.1.0_amd64.deb"), "");
const cacheKey = (image, week, depends, arch = "amd64") => {
  const result = spawnSync("bash", [script, "cache-key", image, packages, week], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_ARCH: arch,
      FAKE_DEPENDS: depends,
    },
  });
  const lines = result.stdout.trim().split("\n");
  return { result, lines: Object.fromEntries(lines.map((line) => line.split("="))) };
};
// The first 16 hex digits of ubuntu:22.04's pinned digest in smoke-images.txt.
const jammy = "9abcaffc92a5279f";

test("cache-key: the key holds the arch, the image digest, the Depends and the week", () => {
  const { result, lines } = cacheKey("ubuntu:22.04", "2026-W47", "libwebkit2gtk-4.1-0, libgtk-3-0");
  passes(result);
  assert.match(
    lines.key,
    new RegExp(`^smoke-apt-amd64-ubuntu-22\\.04-${jammy}-[0-9a-f]{16}-2026-W47$`),
  );
  assert.equal(lines.restore, `smoke-apt-amd64-ubuntu-22.04-${jammy}-`);
  assert.ok(lines.key.startsWith(lines.restore));
});

test("cache-key: other Depends or another week change the key, not the restore prefix", () => {
  const base = cacheKey("ubuntu:22.04", "2026-W47", "libgtk-3-0").lines;
  assert.deepEqual(cacheKey("ubuntu:22.04", "2026-W47", "libgtk-3-0").lines, base);
  for (const other of [
    cacheKey("ubuntu:22.04", "2026-W47", "libgtk-3-0, libsoup-3.0-0").lines,
    cacheKey("ubuntu:22.04", "2026-W48", "libgtk-3-0").lines,
  ]) {
    assert.notEqual(other.key, base.key);
    assert.equal(other.restore, base.restore);
  }
  // Another arch or image restores nothing of this one's.
  assert.notEqual(
    cacheKey("ubuntu:22.04", "2026-W47", "libgtk-3-0", "arm64").lines.restore,
    base.restore,
  );
  assert.notEqual(cacheKey("ubuntu:24.04", "2026-W47", "libgtk-3-0").lines.restore, base.restore);
});

test("cache-key: an image not pinned in smoke-images.txt or a malformed week fails", () => {
  fails(cacheKey("ubuntu:20.04", "2026-W47", "libgtk-3-0").result, /ubuntu:20\.04 is not pinned/);
  fails(cacheKey("ubuntu:22.04", "2026-47", "libgtk-3-0").result, /not a week as YYYY-Www/);
});

test("apt-keep: docker-clean goes and apt keeps the packages it downloads", () => {
  const conf = path.join(dir, "apt.conf.d");
  fs.mkdirSync(conf);
  fs.writeFileSync(
    path.join(conf, "docker-clean"),
    'DPkg::Post-Invoke { "rm -f /var/cache/apt/archives/*.deb || true"; };\n',
  );
  fs.writeFileSync(path.join(conf, "80smoke-retries"), 'Acquire::Retries "3";\n');
  passes(smoke("apt-keep", conf));
  assert.deepEqual(fs.readdirSync(conf).sort(), ["80smoke-keep", "80smoke-retries"]);
  assert.equal(
    fs.readFileSync(path.join(conf, "80smoke-keep"), "utf8"),
    'APT::Keep-Downloaded-Packages "true";\nBinary::apt::APT::Keep-Downloaded-Packages "true";\n',
  );
});

// install runs the container with docker; a stand-in on PATH records its arguments in
// DOCKER_ARGS, one a line, and writes the listing the container would to the /out mount.
fs.writeFileSync(
  path.join(fakeBin, "docker"),
  [
    "#!/bin/bash",
    'printf "%s\\n" "$@" >"$DOCKER_ARGS"',
    'for arg in "$@"; do if [[ "$arg" == *:/out ]]; then out="${arg%:/out}"; fi; done',
    'cp "$FAKE_LISTING" "$out/$(basename "${!#}")"',
    "",
  ].join("\n"),
  { mode: 0o755 },
);
fs.writeFileSync(path.join(packages, "CodeSense-0.1.0-1.x86_64.rpm"), "");
const install = (type, image, cache) => {
  const args = path.join(dir, `docker-args-${fixtures++}`);
  const result = spawnSync(
    "bash",
    [script, "install", type, image, packages, path.join(dir, `out-${fixtures++}`)],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        DOCKER_ARGS: args,
        FAKE_LISTING: fixture(debListing),
        SMOKE_APT_CACHE: cache,
      },
    },
  );
  passes(result);
  return fs.readFileSync(args, "utf8").split("\n").slice(0, -1);
};
// The arguments that follow <flag> in <argv>.
const flagged = (argv, flag) => argv.flatMap((arg, i) => (argv[i - 1] === flag ? [arg] : []));

test("install: a deb container mounts SMOKE_APT_CACHE as its apt archives and keeps them", () => {
  const cache = path.join(dir, "apt-archives");
  const argv = install("deb", "ubuntu:22.04", cache);
  assert.ok(fs.statSync(cache).isDirectory());
  assert.ok(flagged(argv, "-v").includes(`${cache}:/var/cache/apt/archives`));
  assert.ok(flagged(argv, "-e").includes("SMOKE_KEEP_ARCHIVES=1"));
  assert.ok(argv.some((arg) => arg.startsWith(`ubuntu:22.04@sha256:${jammy}`)));
});

test("install: an rpm container, or a deb one without SMOKE_APT_CACHE, gets no archive mount", () => {
  for (const argv of [
    install("rpm", "fedora:44", path.join(dir, "rpm-archives")),
    install("deb", "ubuntu:24.04", ""),
  ]) {
    assert.ok(!flagged(argv, "-v").some((mount) => mount.endsWith(":/var/cache/apt/archives")));
    assert.ok(!flagged(argv, "-e").includes("SMOKE_KEEP_ARCHIVES=1"));
    assert.deepEqual(flagged(argv, "-e"), ["SMOKE_APT_MIRROR"]);
  }
  assert.ok(!fs.existsSync(path.join(dir, "rpm-archives")));
});
