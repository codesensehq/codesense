// SPDX-License-Identifier: MIT
// node --test scripts/flaky-tests.node-test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  LABEL,
  flakyTests,
  marker,
  readReports,
  summaryMarkdown,
  issueBody,
  trackFlaky,
} from "./flaky-tests.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(root, "scripts/flaky-tests.mjs");

// The shapes nextest writes: a pass, a pass on retry (flakyFailure/flakyError), and a failure on
// every attempt (failure plus rerunFailure). Escaped output must not read as an element.
const junit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="nextest-run" tests="5" failures="1" errors="0">
  <testsuite name="demo-proto" tests="4" disabled="0" errors="0" failures="1">
    <testcase name="frame::tests::steady" classname="demo-proto" time="0.010"/>
    <testcase name="frame::tests::races" classname="demo-proto" time="0.200">
      <flakyFailure message="assertion failed" type="test failure">
        <system-err>&lt;failure&gt; is only text here</system-err>
      </flakyFailure>
    </testcase>
    <testcase name="frame::tests::broken" classname="demo-proto" time="0.300">
      <failure message="assertion failed" type="test failure"/>
      <rerunFailure message="assertion failed" type="test failure"/>
    </testcase>
    <testcase name="frame::tests::quiet" classname="demo-proto" time="0.001">
      <system-out>&lt;flakyFailure&gt; in output is not a rerun</system-out>
    </testcase>
  </testsuite>
  <testsuite name="demo-fs::watch" tests="1" disabled="0" errors="0" failures="0">
    <testcase name="watch_survives_rename" classname="demo-fs::watch" time="1.5">
      <flakyError message="timed out" type="test timeout"/>
    </testcase>
  </testsuite>
</testsuites>
`;

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flaky-tests-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("flakyTests keeps only passes on retry, keyed by binary id and test name", () => {
  assert.deepEqual(flakyTests(junit), [
    {
      key: "cargo:demo-proto#frame::tests::races",
      binary: "demo-proto",
      name: "frame::tests::races",
      hashed: false,
    },
    {
      key: "cargo:demo-fs::watch#watch_survives_rename",
      binary: "demo-fs::watch",
      name: "watch_survives_rename",
      hashed: false,
    },
  ]);
  assert.deepEqual(flakyTests(junit.replace(/<flaky(Failure|Error)\b/g, "<rerun$1")), []);
});

test("a library test and an integration-test target with the same path get distinct keys", () => {
  const flaky = (classname, name) =>
    `<testcase classname="${classname}" name="${name}"><flakyFailure/></testcase>`;
  const keys = flakyTests(
    flaky("pkg", "foo::bar") + flaky("pkg::foo", "bar") + flaky("pkg::bin/foo", "bar"),
  ).map((t) => t.key);
  assert.deepEqual(keys, ["cargo:pkg#foo::bar", "cargo:pkg::foo#bar", "cargo:pkg::bin/foo#bar"]);
  // # is never in a binary id or test name: it would be shown as _ and hashed.
  assert.equal(flakyTests(flaky("pkg", "a#b"))[0].hashed, true);
});

// Entities decode before the name check; a name outside [\w.:/-] is shown with _ and keyed by a hash.
const unsafe = `<testcase classname='a&amp;b' name="t&#x3c;1&#62; -->"><flakyFailure/></testcase>`;
test("flakyTests keys an unexpected name by hash and shows it sanitized", () => {
  const [found] = flakyTests(unsafe);
  assert.deepEqual(found, {
    key: "cargo:sha256-" + createHash("sha256").update("a&b#t<1> -->").digest("hex").slice(0, 16),
    binary: "a_b",
    name: "t_1__--_",
    hashed: true,
  });
  assert.match(found.key, /^cargo:sha256-[0-9a-f]{16}$/);
});

test("summaryMarkdown lists every flaky test, an unexpected name sanitized", () => {
  assert.equal(summaryMarkdown([]), "");
  const markdown = summaryMarkdown([
    ...flakyTests(junit),
    ...flakyTests('<testcase classname="x" name="`bad` &lt;img&gt;"><flakyFailure/></testcase>'),
  ]);
  assert.match(markdown, /^### Flaky tests \(passed on retry\)/);
  assert.match(markdown, /- `demo-proto` `frame::tests::races`/);
  assert.match(markdown, /- `demo-fs::watch` `watch_survives_rename`/);
  assert.match(markdown, /- `x` `_bad___img_`/);
  assert.doesNotMatch(markdown, /<|`bad`/);
});

test("summary appends to the job summary with a warning each, and tolerates no report", (t) => {
  const dir = tmp(t);
  const report = path.join(dir, "junit.xml");
  const summary = path.join(dir, "summary.md");
  fs.writeFileSync(report, junit.replace("</testsuites>", `${unsafe}</testsuites>`));
  fs.writeFileSync(summary, "earlier step\n");
  const run = (file) =>
    spawnSync(process.execPath, [script, "summary", file], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
  let result = run(report);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /::warning title=Flaky test::cargo:demo-proto#frame::tests::races passed only on retry/,
  );
  assert.match(
    result.stdout,
    /^::warning title=Flaky test::cargo:sha256-[0-9a-f]{16} \(a_b#t_1__--_\) passed only on retry; see the JUnit report for its exact name$/m,
  );
  assert.doesNotMatch(result.stdout, /-->|</);
  const written = fs.readFileSync(summary, "utf8");
  assert.ok(written.startsWith("earlier step\n### Flaky tests"));
  fs.writeFileSync(summary, "");
  fs.writeFileSync(report, junit.replace(/<flaky(Failure|Error)\b/g, "<rerun$1"));
  result = run(report);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(summary, "utf8"), "");
  result = run(path.join(dir, "missing.xml"));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no JUnit report/);
});

test("readReports merges one test flaky on several platforms", (t) => {
  const dir = tmp(t);
  for (const artifact of ["rust-macos-junit-7-1", "rust-linux-junit-7-1"]) {
    fs.mkdirSync(path.join(dir, artifact));
    fs.writeFileSync(path.join(dir, artifact, "junit.xml"), junit);
  }
  const tests = readReports(dir);
  assert.deepEqual(
    tests.map((t) => [t.key, t.platforms]),
    [
      ["cargo:demo-proto#frame::tests::races", ["rust-linux", "rust-macos"]],
      ["cargo:demo-fs::watch#watch_survives_rename", ["rust-linux", "rust-macos"]],
    ],
  );
  assert.deepEqual(readReports(path.join(dir, "absent")), []);
});

// A gh stub over an in-memory issue list; every call is recorded.
function stubGh(issues) {
  const calls = [];
  let next = 100;
  const gh = (args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify(issues);
    if (args[0] === "issue" && args[1] === "create")
      return `https://github.com/example/project/issues/${next++}\n`;
    return "";
  };
  return { gh, calls };
}
const races = {
  key: "cargo:demo-proto#frame::tests::races",
  binary: "demo-proto",
  name: "frame::tests::races",
  platforms: ["rust-macos"],
};
const options = (gh) => ({
  gh,
  runUrl: "https://github.com/example/project/actions/runs/7",
  date: "2026-11-08",
});
const writes = (calls) => calls.filter((args) => !(args[0] === "issue" && args[1] === "list"));

test("trackFlaky opens one labelled issue with the marker when none exists", () => {
  const { gh, calls } = stubGh([
    // A longer name that starts with the same key must not match.
    { number: 5, state: "OPEN", body: `${marker(`${races.key}_more`)}\nother` },
  ]);
  const results = trackFlaky([races], options(gh));
  assert.deepEqual(calls[0], [
    "issue",
    "list",
    "--label",
    LABEL,
    "--state",
    "all",
    "--limit",
    "1000",
    "--json",
    "number,state,body",
  ]);
  const [label, create] = writes(calls);
  assert.deepEqual(label.slice(0, 4), ["label", "create", LABEL, "--force"]);
  assert.deepEqual(create.slice(0, 6), [
    "issue",
    "create",
    "--title",
    "Flaky test: demo-proto frame::tests::races",
    "--label",
    LABEL,
  ]);
  const body = create[create.indexOf("--body") + 1];
  assert.ok(body.startsWith(`<!-- flaky:${races.key} -->\n`));
  assert.match(
    body,
    /first seen 2026-11-08 on rust-macos: https:\/\/github\.com\/example\/project\/actions\/runs\/7/,
  );
  assert.equal(
    body,
    issueBody(races, "2026-11-08 on rust-macos: https://github.com/example/project/actions/runs/7"),
  );
  assert.match(
    body,
    /CI nextest profile retries every failed test once\. This issue tracks `frame::tests::races` in `demo-proto`/,
  );
  assert.match(
    body,
    /within 30 days of this issue opening \(a reopen does not restart that window\)/,
  );
  assert.equal(writes(calls).length, 2);
  assert.deepEqual(results, [
    { key: races.key, action: "created", url: "https://github.com/example/project/issues/100" },
  ]);
});

test("trackFlaky comments on the open issue instead of opening another", () => {
  const { gh, calls } = stubGh([
    { number: 3, state: "CLOSED", body: `${marker(races.key)}\nold` },
    { number: 4, state: "OPEN", body: `${marker(races.key)}\ncurrent` },
  ]);
  trackFlaky([{ ...races, platforms: ["rust-linux", "rust-macos"] }], options(gh));
  assert.deepEqual(writes(calls), [
    [
      "issue",
      "comment",
      "4",
      "--body",
      "Flaky again 2026-11-08 on rust-linux, rust-macos: https://github.com/example/project/actions/runs/7",
    ],
  ]);
});

test("trackFlaky reopens the newest closed issue rather than opening a duplicate", () => {
  const { gh, calls } = stubGh([
    { number: 3, state: "CLOSED", body: `${marker(races.key)}\nold` },
    { number: 9, state: "CLOSED", body: `${marker(races.key)}\nnewer` },
  ]);
  const results = trackFlaky([races], options(gh));
  assert.deepEqual(
    writes(calls).map((args) => args.slice(0, 3)),
    [
      ["issue", "reopen", "9"],
      ["issue", "comment", "9"],
    ],
  );
  assert.equal(results[0].action, "reopened");
});

test("trackFlaky de-duplicates within a run and tracks an unexpected name by its hash", () => {
  const [odd] = flakyTests(unsafe);
  const { gh, calls } = stubGh([]);
  const results = trackFlaky(
    [races, races, { ...odd, platforms: ["rust-linux"] }, { ...odd, platforms: ["rust-macos"] }],
    options(gh),
  );
  assert.deepEqual(
    writes(calls).map((args) => args.slice(0, 4)),
    [
      ["label", "create", LABEL, "--force"],
      ["issue", "create", "--title", "Flaky test: demo-proto frame::tests::races"],
      ["issue", "comment", "100", "--body"],
      ["issue", "create", "--title", "Flaky test: a_b t_1__--_"],
      ["issue", "comment", "101", "--body"],
    ],
  );
  const body = calls.at(-2).at(-1);
  assert.ok(body.startsWith(`${marker(odd.key)}\n`));
  assert.doesNotMatch(body.split("\n").slice(1).join("\n"), /-->|</);
  assert.deepEqual(
    results.map((r) => r.action),
    ["created", "commented", "created", "commented"],
  );
});

test("trackFlaky keeps going after a gh failure and reports it", () => {
  const { gh: inner, calls } = stubGh([
    { number: 4, state: "OPEN", body: `${marker(races.key)}\ncurrent` },
  ]);
  const gh = (args) => {
    if (args[1] === "comment") {
      calls.push(args);
      throw new Error(`HTTP 502\n${args.join(" ")}`);
    }
    return inner(args);
  };
  const watch = { ...races, key: "cargo:demo-fs::watch#w", binary: "demo-fs::watch", name: "w" };
  const results = trackFlaky([races, watch], options(gh));
  assert.deepEqual(results, [
    { key: races.key, action: "failed", error: "HTTP 502" },
    { key: watch.key, action: "created", url: "https://github.com/example/project/issues/100" },
  ]);
  // A failed label create is retried for the next new issue.
  let labels = 0;
  const flakyLabel = (args) => {
    if (args[0] === "label" && labels++ === 0) throw new Error("HTTP 500");
    return inner(args);
  };
  const other = { ...watch, key: "cargo:demo-fs::watch#v", name: "v" };
  assert.deepEqual(
    trackFlaky([watch, other], options(flakyLabel)).map((r) => r.action),
    ["failed", "created"],
  );
  assert.equal(labels, 2);
});

test("track drives gh from PATH and makes no calls without flaky tests", (t) => {
  const dir = tmp(t);
  const bin = path.join(dir, "bin");
  const reports = path.join(dir, "junit");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(reports, "rust-linux-junit-7-1"), { recursive: true });
  // Fake gh: records each argv as JSON; lists no issues; create prints an issue URL.
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env node
require("fs").appendFileSync(${JSON.stringify(path.join(dir, "gh.calls"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[3] === "list") console.log("[]");
if (process.argv[3] === "create" && process.argv.includes("Flaky test: demo-fs::watch watch_survives_rename")) {
  console.error("HTTP 502");
  process.exit(1);
}
if (process.argv[3] === "create") console.log("https://github.com/example/project/issues/42");
`,
    { mode: 0o755 },
  );
  const run = () =>
    spawnSync(
      process.execPath,
      [script, "track", reports, "--run-url", "https://example.test/run/7", "--date", "2026-11-08"],
      { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no flaky tests/);
  assert.equal(fs.existsSync(path.join(dir, "gh.calls")), false);

  fs.writeFileSync(path.join(reports, "rust-linux-junit-7-1", "junit.xml"), junit);
  // The second create fails: the first issue is still made, and the run exits non-zero.
  result = run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /1 of 2 tests not tracked/);
  // The log names the failed command, never its arguments or the issue body.
  assert.match(
    result.stdout,
    /^flaky-tests: cargo:demo-fs::watch#watch_survives_rename failed gh issue create failed \(exit 1\)$/m,
  );
  assert.doesNotMatch(result.stdout, /--body|--title|marker|30 days/);
  const calls = fs
    .readFileSync(path.join(dir, "gh.calls"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [
      ["issue", "list"],
      ["label", "create"],
      ["issue", "create"],
      ["issue", "create"],
    ],
  );
  assert.match(result.stdout, /races created https:\/\/github\.com\/example\/project\/issues\/42/);
  assert.equal(spawnSync(process.execPath, [script, "track", reports]).status, 1);
});

test("only the ci nextest profile retries, once, and local runs pass --retries 0", () => {
  const config = fs.readFileSync(path.join(root, ".config/nextest.toml"), "utf8");
  const sections = Object.fromEntries(
    config.split(/^(?=\[)/m).map((section) => [/^\[([^\]]+)\]/.exec(section)?.[1] ?? "", section]),
  );
  assert.match(sections["profile.ci"], /^retries = 1$/m);
  for (const [name, section] of Object.entries(sections))
    if (name !== "profile.ci") assert.doesNotMatch(section, /^\s*retries\s*=/m, name);
  assert.match(
    fs.readFileSync(path.join(root, "scripts/test-rust.sh"), "utf8"),
    /cargo nextest run --profile ci --retries 0 /,
  );
});
