// SPDX-License-Identifier: MIT
// Security specs must fail, never skip, when their fixture is missing.
import console from "node:console";
import { existsSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import process from "node:process";
import {
  loadEntries,
  quarantineApplies,
  quarantineId,
  validEntries,
  quarantineReason,
} from "../../../scripts/lib/quarantine.mjs";

export const BUILD_HINT =
  "Build it with `cargo test --manifest-path src-tauri/Cargo.toml --lib --no-run`, " +
  "or point CODESENSE_FRAME_TEST_BINARY at the compiled codesense_lib test binary.";

// Returns { path } for the Rust viewer test binary, or { error } saying why it is missing.
export function resolveFrameFixtureBinary({ env = process.env } = {}) {
  const deps = resolve(env.CARGO_TARGET_DIR ?? "target", "debug/deps");
  const override = env.CODESENSE_FRAME_TEST_BINARY;
  if (override) {
    const path = resolve(deps, override);
    if (existsSync(path)) return { path };
    return {
      error: `Frame fixture binary not found: CODESENSE_FRAME_TEST_BINARY=${path}. ${BUILD_HINT}`,
    };
  }
  let names = [];
  try {
    names = readdirSync(deps);
  } catch {
    /* A missing deps directory is the same as a missing binary. */
  }
  const name = names.find((n) => /^codesense_lib-[a-f0-9]+$/.test(n));
  if (name) return { path: resolve(deps, name) };
  return { error: `Frame fixture binary not found in ${deps}. ${BUILD_HINT}` };
}

const quarantines = loadEntries();

// Playwright's Linux WebKit build doesn't have Safari's media codecs (Playwright's browser docs
// send media playback to WebKit on macOS); on ubuntu-24.04 its native audio and video loads end
// with status 0. These four hostile specs skip there under this exact reason, and nightly.yml's
// "Frame media specs (WebKit)" job runs them on macOS WebKit every night. Hostile specs can't be
// quarantined; this is the one skip the guard lets through.
export const LINUX_WEBKIT_MEDIA_SKIP =
  "Linux WebKit lacks Safari's media codecs; nightly.yml runs these on macOS WebKit";
const LINUX_WEBKIT_MEDIA_FILE = "tests/frame-security/hostile.spec.ts";
const LINUX_WEBKIT_MEDIA_TITLE =
  /^native (audio|video) loads (default-open live|baseline) media without shim credentials$/;

function linuxWebkitMediaSkip(t, platform) {
  const [, project, , ...titles] = t.titlePath();
  return (
    platform === "linux" &&
    project === "webkit" &&
    relative(process.cwd(), t.location.file).replaceAll("\\", "/") === LINUX_WEBKIT_MEDIA_FILE &&
    titles.length === 1 &&
    LINUX_WEBKIT_MEDIA_TITLE.test(titles[0]) &&
    t.annotations?.some((a) => a.type === "skip" && a.description === LINUX_WEBKIT_MEDIA_SKIP)
  );
}

// Only an explicit fixme from the quarantine adapter, or the Linux WebKit media skip above, may
// bypass the skip guard.
// Setup failures and missing fixtures never acquire that annotation.
export function unexecutedTests(
  tests,
  entries = quarantines,
  now = Date.now(),
  platform = process.platform,
) {
  const valid = validEntries(entries, now);
  return tests.filter((t) => {
    if (t.outcome() !== "skipped") return false;
    if (!t.location?.file) return true;
    if (linuxWebkitMediaSkip(t, platform)) return false;
    const id = quarantineId("playwright", t.location.file, t.titlePath().slice(3));
    const project = t.titlePath()[1];
    const entry = valid.find((entry) => entry.id === id && quarantineApplies(entry, project));
    if (!entry) return true;
    const reason = quarantineReason(entry);
    return !t.annotations?.some((a) => a.type === "fixme" && a.description === reason);
  });
}

// Playwright reporter: unlisted skips still fail a security run.
export default class RequireEveryTestRan {
  onBegin(_config, suite) {
    this.suite = suite;
  }
  // Only a run that would otherwise pass is turned red; interrupted and timedout keep their status.
  onEnd(result) {
    if (result.status !== "passed") return;
    const missed = unexecutedTests(this.suite?.allTests() ?? []);
    if (missed.length === 0) return;
    console.error(`\n${missed.length} frame-security test(s) did not run; failing the run:`);
    for (const t of missed) console.error(`  - ${t.titlePath().filter(Boolean).join(" › ")}`);
    return { status: "failed" };
  }
  printsToStdio() {
    return false;
  }
}
