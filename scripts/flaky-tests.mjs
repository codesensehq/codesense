// SPDX-License-Identifier: MIT
// Flaky Rust tests (passed on nextest's one CI retry), read from the nextest JUnit report.
//   node scripts/flaky-tests.mjs summary <junit.xml>
//     Lists them in the job summary ($GITHUB_STEP_SUMMARY, else stdout) with a warning each.
//   node scripts/flaky-tests.mjs track <report-dir> --run-url <url> [--date YYYY-MM-DD]
//     Opens or updates one public issue per flaky test with gh (GH_TOKEN and GH_REPO set).
// No dependencies: the summary step runs before any package install.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LABEL = "flaky-test";
// Nextest binary ids and test names. Any other character is shown as _ and the test is keyed by a
// hash, so nothing unexpected reaches an annotation, the summary or an issue.
// # joins the binary id and the test name (cargo:<binary-id>#<test>) and is never in either, so a
// library test and an integration-test target with the same path cannot share a key.
const UNSAFE = /[^\w.:/-]/g;
const shown = (text) => text.replace(UNSAFE, "_");
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const decode = (text) =>
  text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(\w+));/gi, (match, hex, dec, name) =>
    hex
      ? String.fromCodePoint(parseInt(hex, 16))
      : dec
        ? String.fromCodePoint(Number(dec))
        : (ENTITIES[name] ?? match),
  );

function attributes(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    out[m[1]] = decode(m[2] ?? m[3]);
  return out;
}

// A flaky test has flakyFailure/flakyError reruns and no final failure or error; a test that
// failed every attempt has <failure> plus rerunFailure elements and is a plain failure.
// Attributes are read quote-aware, so a > or /> inside a quoted value cannot end the tag.
const TESTCASE =
  /<testcase\b((?:[^>"'/]|\/(?!>)|"[^"]*"|'[^']*')*)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
export function flakyTests(xml) {
  const tests = [];
  for (const m of xml.matchAll(TESTCASE)) {
    const body = m[2] ?? "";
    if (!/<flaky(?:Failure|Error)\b/.test(body) || /<(?:failure|error)\b/.test(body)) continue;
    const { name, classname } = attributes(m[1]);
    if (!name || !classname) continue;
    const id = `${classname}#${name}`;
    const safe = shown(classname) === classname && shown(name) === name;
    const key = safe
      ? `cargo:${id}`
      : `cargo:sha256-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
    tests.push({ key, binary: shown(classname), name: shown(name), hashed: !safe });
  }
  return tests;
}

export const marker = (key) => `<!-- flaky:${key} -->`;

export function summaryMarkdown(tests) {
  if (!tests.length) return "";
  return [
    "### Flaky tests (passed on retry)",
    "",
    ...tests.map((t) => `- \`${t.binary}\` \`${t.name}\``),
    "",
    "Each gets a tracked public issue when this runs on main; see tests/quarantine.md.",
    "",
  ].join("\n");
}

// Every *.xml under dir; the first path segment is the artifact name (rust-<os>-junit-<run>-<n>).
export function readReports(dir) {
  const byKey = new Map();
  if (!fs.existsSync(dir)) return [];
  for (const file of fs.readdirSync(dir, { recursive: true }).map(String).sort()) {
    if (!file.endsWith(".xml")) continue;
    const platform = file.split(path.sep)[0].replace(/-junit-.*$/, "");
    for (const test of flakyTests(fs.readFileSync(path.join(dir, file), "utf8"))) {
      const seen = byKey.get(test.key) ?? { ...test, platforms: [] };
      if (!seen.platforms.includes(platform)) seen.platforms.push(platform);
      byKey.set(test.key, seen);
    }
  }
  return [...byKey.values()];
}

export function issueBody(test, seen) {
  return [
    marker(test.key),
    "The CI nextest profile retries every failed test once. This issue tracks " +
      `\`${test.name}\` in \`${test.binary}\`, which failed and then passed on that retry ` +
      `(first seen ${seen}).`,
    "",
    "Fix it deterministically within 30 days of this issue opening (a reopen does not restart " +
      "that window), or quarantine it with this issue (tests/quarantine.md). Each new flake on " +
      "main adds a comment here; keep the label and the marker line so it is found.",
    "",
  ].join("\n");
}

// One issue per test, found by the exact body marker among labelled issues (open first, else the
// newest closed one, reopened), so a repeat flake comments instead of opening a duplicate.
// A gh failure for one test is recorded and the rest still run.
export function trackFlaky(tests, { gh, runUrl, date }) {
  const issues = JSON.parse(
    gh([
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
    ]),
  );
  let labelReady = false;
  const results = [];
  for (const test of tests) {
    const seen = `${date} on ${test.platforms.join(", ")}: ${runUrl}`;
    try {
      const matches = issues
        .filter((issue) => issue.body?.includes(marker(test.key)))
        .sort((a, b) => b.number - a.number);
      const existing = matches.find((issue) => issue.state === "OPEN") ?? matches[0];
      if (existing) {
        const number = String(existing.number);
        const action = existing.state === "OPEN" ? "commented" : "reopened";
        if (action === "reopened") {
          gh(["issue", "reopen", number]);
          existing.state = "OPEN";
        }
        gh(["issue", "comment", number, "--body", `Flaky again ${seen}`]);
        results.push({ key: test.key, action, number: existing.number });
        continue;
      }
      if (!labelReady) {
        gh([
          "label",
          "create",
          LABEL,
          "--force",
          "--color",
          "d93f0b",
          "--description",
          "Passed only on CI retry",
        ]);
        labelReady = true;
      }
      const body = issueBody(test, seen);
      const url = gh([
        "issue",
        "create",
        "--title",
        `Flaky test: ${test.binary} ${test.name}`,
        "--label",
        LABEL,
        "--body",
        body,
      ]).trim();
      issues.push({ number: Number(url.split("/").pop()), state: "OPEN", body });
      results.push({ key: test.key, action: "created", url });
    } catch (error) {
      // First line only: a gh error can carry its argv, including an issue body.
      results.push({ key: test.key, action: "failed", error: error.message.split("\n")[0] });
    }
  }
  return results;
}

function main(argv) {
  const [command, target, ...rest] = argv;
  const option = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (command === "summary" && target) {
    if (!fs.existsSync(target)) return console.log(`flaky-tests: no JUnit report at ${target}`);
    const tests = flakyTests(fs.readFileSync(target, "utf8"));
    for (const t of tests)
      console.log(
        t.hashed
          ? `::warning title=Flaky test::${t.key} (${t.binary}#${t.name}) passed only on retry; see the JUnit report for its exact name`
          : `::warning title=Flaky test::${t.key} passed only on retry`,
      );
    const markdown = summaryMarkdown(tests);
    if (markdown && process.env.GITHUB_STEP_SUMMARY)
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    else if (markdown) process.stdout.write(markdown);
    return;
  }
  if (command === "track" && target && option("--run-url")) {
    const tests = readReports(target);
    if (!tests.length) return console.log("flaky-tests: no flaky tests");
    // gh prints its own error to stderr; the thrown message names the command, not its arguments.
    const gh = (args) => {
      try {
        return execFileSync("gh", args, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
        });
      } catch (error) {
        throw new Error(`gh ${args.slice(0, 2).join(" ")} failed (exit ${error.status ?? "?"})`);
      }
    };
    const date = option("--date") ?? new Date().toISOString().slice(0, 10);
    const results = trackFlaky(tests, { gh, runUrl: option("--run-url"), date });
    for (const r of results)
      console.log(
        `flaky-tests: ${r.key} ${r.action} ${r.url ?? r.number ?? r.error ?? ""}`.trimEnd(),
      );
    const failed = results.filter((r) => r.action === "failed").length;
    if (failed) throw new Error(`flaky-tests: ${failed} of ${results.length} tests not tracked`);
    return;
  }
  throw new Error(
    "usage: node scripts/flaky-tests.mjs summary <junit.xml> | track <dir> --run-url <url> [--date YYYY-MM-DD]",
  );
}

// A realpath guard keeps imports inert, including when /tmp is a symlink on macOS.
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
