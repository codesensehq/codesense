// SPDX-License-Identifier: MIT
// node --test scripts/workflow-policy.node-test.mjs (the repository's public workflows)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  MAIN_WRITERS,
  smokeImagesPolicy,
  topLevelConjuncts,
  workflowPolicy,
} from "./workflow-policy.mjs";

// The workflow set under test: .github/workflows, or CODESENSE_WORKFLOWS_DIR (from the repo root).
const directory = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  process.env.CODESENSE_WORKFLOWS_DIR || ".github/workflows",
);
if (!fs.existsSync(path.join(directory, "../allowed-actions.json")))
  throw new Error(
    `${directory} has no ../allowed-actions.json; set CODESENSE_WORKFLOWS_DIR to the workflow set`,
  );
const files = fs.readdirSync(directory).filter((f) => /\.ya?ml$/.test(f));
assert.ok(files.length, "public workflows must exist");
for (const file of files) {
  test(`public workflow policy: ${file}`, () => {
    assert.deepEqual(workflowPolicy(fs.readFileSync(path.join(directory, file), "utf8"), file), []);
  });
}

// GitHub-owned actions are covered by github_owned_allowed; third parties must
// match the exported list exactly so workflow PRs cannot outrun repository policy.
const patterns = JSON.parse(
  fs.readFileSync(path.join(directory, "../allowed-actions.json"), "utf8"),
);
function actionPatterns(source) {
  const found = new Set();
  function walk(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.uses === "string" && !value.uses.startsWith("./")) {
      const match = /^([^/]+\/[^/@]+)(?:\/[^@]+)?@.+$/.exec(value.uses);
      assert.ok(match, `unrecognized uses: ${value.uses}`);
      const repo = match[1].toLowerCase();
      if (!/^(actions|github)\//.test(repo)) found.add(`${repo}@*`);
    }
    Object.values(value).forEach(walk);
  }
  walk(parse(source));
  return [...found];
}
function missingActions(source) {
  const allowed = patterns.map((pattern) => pattern.toLowerCase());
  return actionPatterns(source).filter((pattern) => !allowed.includes(pattern));
}
test("action allowlist has unique explicit repository patterns", () => {
  assert.ok(Array.isArray(patterns));
  for (const pattern of patterns) assert.match(pattern, /^[\w.-]+\/[\w.-]+@\*$/);
  assert.equal(new Set(patterns.map((pattern) => pattern.toLowerCase())).size, patterns.length);
});
test("action allowlist matches every workflow's third-party uses exactly", () => {
  const used = new Set();
  for (const file of files) {
    const source = fs.readFileSync(path.join(directory, file), "utf8");
    assert.deepEqual(missingActions(source), [], `${file}: update .github/allowed-actions.json`);
    actionPatterns(source).forEach((pattern) => used.add(pattern));
  }
  assert.deepEqual(patterns.map((pattern) => pattern.toLowerCase()).sort(), [...used].sort());
});
test("action allowlist rejects a new unlisted action, including reusable workflows", () => {
  assert.deepEqual(missingActions("jobs: {test: {uses: unlisted-org/action/workflow@v1}}"), [
    "unlisted-org/action@*",
  ]);
  assert.deepEqual(missingActions('jobs: {test: {steps: [{uses: "unlisted-org/action@v1"}]}}'), [
    "unlisted-org/action@*",
  ]);
  assert.deepEqual(
    missingActions(
      'jobs: {test: {steps: [{uses: "actions/cache/restore@v4"}, {uses: "github/codeql-action/upload-sarif@v4"}, {uses: "./local/action"}]}}',
    ),
    [],
  );
});

const good = `# SPDX-License-Identifier: MIT
on: [pull_request, workflow_dispatch]
permissions: {}
concurrency:
  group: ci-test
  cancel-in-progress: true
jobs:
  static:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
        with:
          persist-credentials: false
`;

// Three planted bad workflows exercise each of the original policy failure classes.
const badFixtures = [
  ["unpinned action", good.replace(/@[0-9a-f]{40}/, "@v4"), /40-hex/],
  ["privileged trigger", good.replace("pull_request,", "pull_request_target,"), /triggers/],
  ["secret reference", good + '      - run: echo "${{ secrets.TOKEN }}"\n', /secrets/],
];
for (const [name, fixture, error] of badFixtures) {
  test(`reject planted workflow: ${name}`, () => {
    assert.match(workflowPolicy(fixture).join("\n"), error);
  });
}

test("accept the valid fixture", () => assert.deepEqual(workflowPolicy(good), []));

const queued = (filter = "") =>
  good.replace(
    "on: [pull_request, workflow_dispatch]",
    `on:\n  pull_request:\n  merge_group:${filter}`,
  );
test("merge_group is allowed bare or for checks_requested only", () => {
  assert.deepEqual(workflowPolicy(queued()), []);
  assert.deepEqual(workflowPolicy(good.replace("pull_request,", "pull_request, merge_group,")), []);
  assert.deepEqual(workflowPolicy(queued("\n    types: [checks_requested]")), []);
  for (const filter of ["\n    types: [destroyed]", "\n    branches: [main]", " {}"])
    assert.match(workflowPolicy(queued(filter)).join("\n"), /merge_group takes no filter/, filter);
});

// The merge queue waits for every required check, so each one must also run on merge_group, and
// a concurrency group keyed on the pull request alone would make queued runs cancel each other.
test("every pull request workflow also runs on merge groups, each in its own concurrency group", () => {
  for (const file of files) {
    const workflow = parse(fs.readFileSync(path.join(directory, file), "utf8"));
    if (!Object.hasOwn(workflow.on ?? {}, "pull_request")) continue;
    assert.ok(Object.hasOwn(workflow.on, "merge_group"), `${file} must run on merge_group`);
    const group = workflow.concurrency.group;
    if (group.includes("github.event.pull_request.number"))
      assert.match(group, /pull_request\.number \|\| github\.(ref|sha|run_id) \}\}/, file);
  }
});

// A push run and a scheduled or dispatched run on the same commit must not share a cancelling
// group, or the later one cancels the other; keying the group on the event keeps them apart.
test("a workflow on push and another non-PR event keys its cancelling group on the event", () => {
  const shared = files.filter((file) => {
    const workflow = parse(fs.readFileSync(path.join(directory, file), "utf8"));
    if (!Object.hasOwn(workflow.on ?? {}, "push")) return false;
    const others = Object.keys(workflow.on).filter(
      (event) => !["push", "pull_request", "merge_group"].includes(event),
    );
    if (others.length === 0 || workflow.concurrency?.["cancel-in-progress"] === false) return false;
    return !/\$\{\{\s*github\.event_name\s*\}\}/.test(workflow.concurrency.group);
  });
  assert.deepEqual(shared, []);
});

// No cache is saved on a merge group: each caching step is checked on a merge_group workflow.
const cacheStep = (step) =>
  queued() +
  "      - name: Cache\n" +
  step
    .split("\n")
    .map((line) => `        ${line}`)
    .join("\n") +
  "\n";
const pin = "@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1";
const gatedNode = "cache: ${{ github.event_name != 'merge_group' && 'pnpm' || '' }}";
test("a merge_group workflow saves no cache on merge groups", () => {
  for (const step of [
    `uses: actions/setup-node${pin}\nwith:\n  ${gatedNode}`,
    `uses: actions/setup-node${pin}\nwith:\n  node-version: "24"`,
    `uses: actions/cache/restore${pin}\nwith:\n  path: x\n  key: k`,
    `if: github.event_name == 'push' && github.ref == 'refs/heads/main'\nuses: actions/cache/save${pin}\nwith:\n  path: x\n  key: k`,
    `if: github.event_name == 'schedule' && github.ref == 'refs/heads/main' && steps.c.outputs.cache-hit != 'true'\nuses: actions/cache/save${pin}\nwith:\n  path: x\n  key: k`,
    `uses: Swatinem/rust-cache${pin}\nwith:\n  save-if: \${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}`,
    `uses: Swatinem/rust-cache${pin}\nwith:\n  save-if: \${{ github.event_name == 'schedule' && github.ref == 'refs/heads/main' }}`,
  ])
    assert.deepEqual(workflowPolicy(cacheStep(step)), [], step);
  for (const [step, error] of [
    [`uses: actions/setup-node${pin}\nwith:\n  cache: pnpm`, /cache must be/],
    [`uses: actions/setup-node${pin}\nwith:\n  cache: \${{ 'pnpm' }}`, /cache must be/],
    [`uses: actions/cache${pin}\nwith:\n  path: x\n  key: k`, /saves on merge groups/],
    [`uses: actions/cache/save${pin}\nwith:\n  path: x\n  key: k`, /if must require/],
    [
      `if: github.event_name != 'merge_group'\nuses: actions/cache/save${pin}\nwith:\n  path: x\n  key: k`,
      /if must require/,
    ],
    [
      `if: github.event_name == 'push' || true\nuses: actions/cache/save${pin}\nwith:\n  path: x\n  key: k`,
      /if must require/,
    ],
    [`uses: Swatinem/rust-cache${pin}\nwith:\n  shared-key: x`, /save-if must require/],
    [
      `if: github.event_name == 'schedule'\nuses: actions/cache/save${pin}\nwith:\n  path: x\n  key: k`,
      /if must require/,
    ],
    [
      `if: github.event_name == 'merge_group' && github.ref == 'refs/heads/main'\nuses: actions/cache/save${pin}\nwith:\n  path: x\n  key: k`,
      /if must require/,
    ],
    [
      `uses: Swatinem/rust-cache${pin}\nwith:\n  save-if: \${{ github.event_name == 'schedule' || github.ref == 'refs/heads/main' }}`,
      /save-if must require/,
    ],
    [
      `uses: Swatinem/rust-cache${pin}\nwith:\n  save-if: \${{ github.event_name == 'push' }}`,
      /save-if must require/,
    ],
    [`uses: Swatinem/rust-cache${pin}`, /save-if must require/],
  ])
    assert.match(workflowPolicy(cacheStep(step)).join("\n"), error, step);
  // Without merge_group the rule does not apply.
  const plain = cacheStep(`uses: actions/setup-node${pin}\nwith:\n  cache: pnpm`).replace(
    "  merge_group:\n",
    "",
  );
  assert.deepEqual(workflowPolicy(plain), []);
});

// Merge groups, main and the nightly runs must run every job, so a job may only be skipped on
// pull requests.
const macosOptIn =
  "github.event_name != 'pull_request' || (github.event.pull_request.user.login != 'dependabot[bot]' && contains(github.event.pull_request.labels.*.name, 'ci:macos') && (github.event.action != 'labeled' || github.event.label.name == 'ci:macos'))";
const pathFilter = "!cancelled() && needs.changes.outputs.rust != 'false'";
// The macOS result job leads with always() instead, so a cancelled run reports red.
const resultFilter = "always() && needs.changes.outputs.rust != 'false'";
// The macOS jobs also skip a change only Windows or Linux compiles, right after the path filter.
const macosOnly = "needs.changes.outputs.macos != 'false'";
const macosFilter = {
  "rust-macos-build": `${pathFilter} && ${macosOnly}`,
  "rust-macos": `${resultFilter} && ${macosOnly}`,
};
const offMergeGroups = "github.event_name != 'merge_group'";
// Each macOS build step after the check of main's head skips when main has moved on.
const notSuperseded = "steps.superseded.outputs.superseded != 'true'";
const shardsNotSuperseded = "needs.rust-macos-build.outputs.superseded != 'true'";
const conditional = (workflow, condition) =>
  workflow.replace(/^ {2}([a-z-]+):\n {4}runs-on/m, `  $1:\n    if: ${condition}\n    runs-on`);
test("a job is skipped only on pull requests when its workflow runs on merge_group, push or schedule", () => {
  const scheduled = good
    .replace("on: [pull_request, workflow_dispatch]", "on: [schedule]")
    .replace("  static:", "  commit-emails:");
  for (const [trigger, workflow, file] of [
    ["merge_group", queued(), ""],
    [
      "push",
      good.replace(
        "on: [pull_request, workflow_dispatch]",
        "on:\n  pull_request:\n  push:\n    branches: [main]",
      ),
      "",
    ],
    ["schedule", scheduled, "commit-emails.yml"],
  ]) {
    for (const condition of [
      macosOptIn,
      "${{ github.event_name != 'pull_request' || !github.event.pull_request.draft }}",
    ])
      assert.deepEqual(
        workflowPolicy(conditional(workflow, condition), file),
        [],
        `${trigger}: ${condition}`,
      );
    for (const condition of [
      "github.event.pull_request.draft == false",
      "contains(github.event.pull_request.labels.*.name, 'ci:macos')",
      "github.event_name == 'merge_group' || contains(github.event.pull_request.labels.*.name, 'ci:macos')",
      "github.event_name != 'pull_request' && contains(github.event.pull_request.labels.*.name, 'ci:macos')",
      `github.event_name != '${trigger}' || contains(github.event.pull_request.labels.*.name, 'ci:macos')`,
      "github.event_name == 'pull_request' || github.event_name != 'pull_request'",
      "(github.event_name != 'pull_request' || true) && false",
      "${{ !github.event.pull_request.draft || github.event_name != 'pull_request' }}",
      "false && github.event_name != 'pull_request' || true",
    ])
      assert.match(
        workflowPolicy(conditional(workflow, condition), file).join("\n"),
        /if must begin with/,
        `${trigger}: ${condition}`,
      );
  }
  // A workflow that runs on none of them may skip a job anywhere.
  assert.deepEqual(
    workflowPolicy(conditional(good, "github.event.pull_request.draft == false")),
    [],
  );
});

// rust.yml runs on pull requests, merge groups, pushes to main, a nightly schedule and by hand.
// macOS skips merge groups and runs on push and nightly instead; only the nightly run on main
// saves its caches and tracks flaky tests.
test("rust.yml runs on push to main and nightly, and only the nightly run saves or tracks", () => {
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  assert.deepEqual(Object.keys(workflow.on), [
    "pull_request",
    "merge_group",
    "push",
    "schedule",
    "workflow_dispatch",
  ]);
  assert.deepEqual(workflow.on.push, { branches: ["main"] });
  assert.deepEqual(workflow.on.schedule, [{ cron: "17 6 * * *" }]);
  for (const [name, filter] of Object.entries(macosFilter))
    assert.ok(
      workflow.jobs[name].if.startsWith(
        `\${{ ${filter} && ${offMergeGroups} && (github.event_name != 'pull_request' ||`,
      ),
      name,
    );
  const nightly = "github.event_name == 'schedule' && github.ref == 'refs/heads/main'";
  for (const [name, count] of [
    ["rust-macos-build", 2],
    ["rust-linux", 1],
  ]) {
    const steps = workflow.jobs[name].steps;
    const saves = steps.filter((step) => step.uses?.startsWith("actions/cache/save@"));
    assert.equal(saves.length, count, name);
    for (const step of saves) assert.ok(step.if.startsWith(`${nightly} &&`), name);
    const rustCache = steps.filter((step) => step.uses?.startsWith("Swatinem/rust-cache@"));
    assert.equal(rustCache.length, 1, name);
    assert.equal(rustCache[0].with["save-if"], `\${{ ${nightly} }}`, name);
  }
  assert.equal(
    workflow.jobs["flaky-issues"].if,
    `\${{ !cancelled() && ${nightly} && !github.event.repository.fork }}`,
  );
});

test("flaky-issues may run on a nightly schedule on main, never on merge groups", () => {
  const nightly = flakyIssues.replace(
    "github.event_name == 'push'",
    "github.event_name == 'schedule'",
  );
  assert.deepEqual(workflowPolicy(nightly, "rust.yml"), []);
  for (const event of ["merge_group", "workflow_dispatch", "pull_request"])
    assert.match(
      workflowPolicy(
        flakyIssues.replace("github.event_name == 'push'", `github.event_name == '${event}'`),
        "rust.yml",
      ).join("\n"),
      /if must require github\.event_name == 'push' or github\.event_name == 'schedule'/,
      event,
    );
});

test("rust.yml runs macOS on a pull request only with ci:macos, and Linux always", () => {
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  assert.deepEqual(workflow.on.pull_request.types, [
    "opened",
    "synchronize",
    "reopened",
    "labeled",
  ]);
  for (const trigger of ["merge_group", "schedule", "workflow_dispatch"])
    assert.ok(Object.hasOwn(workflow.on, trigger), trigger);
  for (const [name, filter] of Object.entries(macosFilter))
    assert.equal(
      workflow.jobs[name].if,
      `\${{ ${filter} && ${offMergeGroups} && (${macosOptIn}) }}`,
      name,
    );
  // The shards follow the build: they run only when it succeeds and main had not moved on.
  assert.equal(workflow.jobs["rust-macos-test"].needs, "rust-macos-build");
  assert.equal(workflow.jobs["rust-macos-test"].if, shardsNotSuperseded);
  // One commit's push, schedule and workflow_dispatch runs each get their own group, so none
  // cancels another. Every pull_request event for one PR shares a group (ci:macos labeled
  // included), so a newer push still supersedes; another label's run, ci:windows included, has a
  // group of its own, so it cannot cancel the pull request's run or a ci:macos run.
  assert.equal(
    workflow.concurrency.group,
    "${{ github.workflow }}-${{ github.event.pull_request.number || github.sha }}-${{ github.event_name }}${{ github.event.action == 'labeled' && github.event.label.name != 'ci:macos' && format('-{0}', github.run_id) || '' }}",
  );
  assert.equal(workflow.jobs["rust-linux"].if, `\${{ ${pathFilter} }}`);
});

const windowsOptIn = macosOptIn.replaceAll("ci:macos", "ci:windows");
test("rust.yml runs the Windows check on a pull request only with ci:windows, never in a merge group", () => {
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  const job = workflow.jobs["rust-check-windows"];
  assert.equal(job.name, "Rust check (Windows)");
  assert.equal(job.needs, "changes");
  assert.equal(job.if, `\${{ ${pathFilter} && ${offMergeGroups} && (${windowsOptIn}) }}`);
  // The literal runner, not an expression, so the policy's hosted-runner allowlist applies.
  assert.equal(job["runs-on"], "windows-2025");
  // Line endings are set before checkout, and the nightly alone saves the Windows cache.
  const steps = job.steps;
  const autocrlf = steps.findIndex((s) => s.run === "git config --global core.autocrlf false");
  const checkout = steps.findIndex((s) => s.uses?.startsWith("actions/checkout@"));
  assert.ok(autocrlf >= 0 && autocrlf < checkout);
  const cache = steps.find((s) => s.uses?.startsWith("Swatinem/rust-cache@"));
  assert.equal(cache.with["shared-key"], "rust-windows");
  assert.equal(
    cache.with["save-if"],
    "${{ github.event_name == 'schedule' && github.ref == 'refs/heads/main' }}",
  );
  assert.deepEqual(
    steps.filter((s) => /\bcargo\b/.test(s.run ?? "")).map((s) => s.run),
    [
      "cargo check --locked -p codesense-platform -p codesense-host-proto -p codesense-fs-core -p codesense-pty-core -p codesense-session-server --all-targets",
      "cargo test --locked -p codesense-platform --features pdf",
      "cargo test --locked -p codesense-host-proto --lib hook::",
      'cargo test --locked -p codesense-session-server --lib portable 2>&1 | tee "$RUNNER_TEMP/portable-tests.log"\n' +
        "grep -Eq '^test result: ok\\. [1-9][0-9]* passed' \"$RUNNER_TEMP/portable-tests.log\"\n",
      'cargo test --locked -p codesense-pty-core --lib runner::cursor_reply:: 2>&1 | tee "$RUNNER_TEMP/cursor-reply-tests.log"\n' +
        "grep -Eq '^test result: ok\\. [1-9][0-9]* passed' \"$RUNNER_TEMP/cursor-reply-tests.log\"\n",
      'cargo test --locked -p codesense-pty-core --lib spawn::tests::os_rules:: 2>&1 | tee "$RUNNER_TEMP/spawn-os-rules-tests.log"\n' +
        "grep -Eq '^test result: ok\\. [1-9][0-9]* passed' \"$RUNNER_TEMP/spawn-os-rules-tests.log\"\n",
      "cargo test --locked --no-fail-fast -p codesense-pty-core --test pty_contract --test process_tree --test headless_session",
    ],
  );
  // The pty tests run the Windows worker, built after Rust (the script asks rustc for the triple)
  // from the installed packages, and named to them.
  const names = steps.map((s) => s.name);
  const worker = names.indexOf("Build the emulator worker");
  const install = names.indexOf("Install dependencies");
  const rust = names.indexOf("Set up Rust");
  const pty = steps.findIndex((s) => s.run?.includes("--test pty_contract"));
  for (const index of [worker, install, rust, pty]) assert.ok(index >= 0);
  assert.equal(steps[worker].run, "pnpm run build:emulator");
  assert.ok(install < worker && rust < worker && worker < pty);
  assert.equal(
    steps[pty].env.CODESENSE_EMULATOR_WORKER,
    "${{ github.workspace }}/src-tauri/binaries/codesense-emulator-x86_64-pc-windows-msvc.exe",
  );
  // A filter that matches no test passes in libtest, so each filtered step fails unless one ran.
  for (const filter of [
    "--lib portable",
    "--lib runner::cursor_reply::",
    "--lib spawn::tests::os_rules::",
  ]) {
    const { run } = steps.find((s) => s.run?.includes(filter));
    const ran = new RegExp(/^grep -Eq '(.+)' /m.exec(run)[1], "m");
    assert.match("test result: ok. 1 passed; 0 failed; 0 ignored", ran, filter);
    assert.doesNotMatch("test result: ok. 0 passed; 0 failed; 0 ignored", ran, filter);
  }
  // The ci:windows label's run gets a group of its own, so it never cancels a ci:macos run.
  assert.doesNotMatch(workflow.concurrency.group, /ci:windows/);
  // The platform crate is tested on Linux and macOS too.
  for (const name of ["rust-linux", "rust-macos-build"])
    assert.match(workflow.jobs[name].env.RUST_PACKAGES, /-p codesense-platform\b/, name);
});

test("the policy accepts the Windows check's runner literal and rejects expressions", () => {
  const windows = (runner) => workflowPolicy(good.replace("ubuntu-24.04", runner)).join("\n");
  assert.equal(windows("windows-2025"), "");
  assert.match(windows("${{ matrix.os }}"), /GitHub-hosted/);
  assert.match(windows("windows-2019"), /GitHub-hosted/);
});

// A Rust-free change skips the Rust jobs. Scheduled and manual runs always test, and the jobs
// run unless the changes job says rust=false, so its failure runs them too.
test("rust.yml skips its test jobs only when the changes job finds nothing Rust-relevant", () => {
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  const changes = workflow.jobs.changes;
  assert.equal(changes.if, undefined);
  assert.equal(changes.needs, undefined);
  assert.equal(changes.outputs.rust, "${{ steps.filter.outputs.rust }}");
  assert.equal(changes.outputs.macos, "${{ steps.filter.outputs.macos }}");
  const filter = changes.steps.find((step) => step.id === "filter");
  assert.match(
    filter.run,
    /^\s*\*\) printf 'rust=true\\nmacos=true\\n' >> "\$GITHUB_OUTPUT"; exit 0 ;;$/m,
  );
  assert.match(filter.run, /node scripts\/rust-changes\.mjs "\$range" >> "\$GITHUB_OUTPUT"/);
  for (const name of [
    "rust-macos-build",
    "rust-linux",
    "rust-check-linux",
    "rust-linux-app",
    "windows-e2e-linux",
  ])
    assert.equal(workflow.jobs[name].needs, "changes", name);
  assert.deepEqual(workflow.jobs["rust-macos"].needs, [
    "changes",
    "rust-macos-build",
    "rust-macos-test",
  ]);
  assert.equal(workflow.jobs["rust-check-linux"].if, `\${{ ${pathFilter} }}`);
});

// The Linux app job is not a required check: it carries the path filter and nothing else, so it
// runs on pull requests, merge groups, main and the nightly run, and its tests (ignored
// everywhere else) run in one place, under a private session bus with the keyring unlocked.
test("rust.yml's Linux app job runs the shared suites and the Secret Service tests", () => {
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  const job = workflow.jobs["rust-linux-app"];
  assert.equal(job.name, "Rust (Linux app)");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  // Not a required check: it skips merge groups like the other non-required jobs.
  assert.equal(job.if, `\${{ ${pathFilter} && ${offMergeGroups} }}`);
  assert.deepEqual(job.permissions, { contents: "read" });
  const libs = job.steps.find((step) => step.name === "Install system libraries");
  assert.match(
    libs.run,
    /^bash scripts\/install-linux-app-libs\.sh dbus gnome-keyring libsecret-tools zsh xvfb xauth language-pack-gnome-de-base language-pack-de poppler-utils$/,
  );
  // The zsh and Codex launch tests need a zsh that reaches its prompt and user namespaces, set up
  // before any test runs.
  const compile = job.steps.findIndex((step) => step.name === "Compile the tests");
  for (const [name, run] of [
    ["Make zsh's completion directories private", /compaudit.*\n.*xargs sudo chmod g-w,o-w/],
    [
      "Allow unprivileged user namespaces",
      /^sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0$/,
    ],
  ]) {
    const at = job.steps.findIndex((step) => step.name === name);
    assert.ok(at >= 0 && at < compile, name);
    assert.match(job.steps[at].run, run, name);
  }
  // One apt list for every Linux job that builds the app.
  assert.equal(
    workflow.jobs["rust-check-linux"].steps.find((step) => step.name === "Install system libraries")
      .run,
    "bash scripts/install-linux-app-libs.sh",
  );
  const test = job.steps.find((step) => step.name.startsWith("Test the credential store"));
  assert.equal(test.run, "dbus-run-session -- bash scripts/run-secret-service-tests.sh");
  const script = fs.readFileSync(new URL("run-secret-service-tests.sh", import.meta.url), "utf8");
  assert.match(script, /gnome-keyring-daemon --unlock/);
  // The keyring is checked before any test runs, so a failed unlock names itself.
  assert.ok(script.indexOf("secret-tool lookup") < script.indexOf("nextest[@]"));
  // Two runs, each of which must match a test (nextest fails when none does), so a renamed
  // module fails here rather than going green with half the tests.
  const runs = script.replace(/\\\n\s*/g, " ").match(/^"\$\{nextest\[@\]\}".*$/gm);
  assert.equal(runs.length, 2);
  assert.match(script, /^nextest=\(cargo nextest run .*-p codesense --lib --retries 0\)$/m);
  assert.match(runs[0], /--run-ignored only/);
  assert.match(runs[0], /test\(~credential_store::secret_service_tests::\)/);
  // The helper tests the others start as child processes pass alone, so they are left out.
  assert.match(runs[0], /- test\(~::reader_process\) - test\(~::no_bus_child\)/);
  assert.match(runs[1], /test\(~credential_store::tests::linux_\)/);
  // The whole of pty-core, session-server and the app's unit tests run here, unfiltered, after
  // the sidecar build makes the emulator worker the pty tests run, each run's JUnit report kept.
  const names = job.steps.map((step) => step.name);
  const sidecars = names.indexOf("Build sidecars");
  const suites = names.indexOf("Test pty-core, session-server and the app");
  assert.equal(job.steps[sidecars].run, "bash scripts/build-session-server.sh");
  assert.ok(sidecars >= 0 && suites >= 0 && sidecars < suites);
  const sidecarScript = fs.readFileSync(
    new URL("build-session-server.sh", import.meta.url),
    "utf8",
  );
  assert.match(sidecarScript, /^bash "\$SCRIPT_DIR\/build-emulator\.sh"/m);
  // The compile builds each suite with the arguments its run takes, from the one list.
  const compileStep = job.steps.find((step) => step.name === "Compile the tests");
  const suitesStep = job.steps[suites];
  assert.equal(
    compileStep.env.SUITES,
    "pty-core -p codesense-pty-core\n" +
      "session-server -p codesense-session-server\n" +
      "app -p codesense --lib",
  );
  // Three suites and no blank line: `<<<` adds a newline, and a blank line would be a fourth
  // pass over the whole workspace.
  const suiteLines = compileStep.env.SUITES.split("\n");
  assert.equal(suiteLines.length, 3);
  assert.ok(suiteLines.every((line) => line.trim()));
  assert.equal(suitesStep.env.SUITES, compileStep.env.SUITES);
  const eachSuite =
    /while read -r \w+ packages; do\n\s+\[\[ -n \$packages \]\] \|\| continue\n\s+read -r -a args <<< "\$packages"\n/;
  assert.match(compileStep.run, eachSuite);
  assert.match(suitesStep.run, eachSuite);
  assert.ok(
    compileStep.run.includes('cargo nextest run --profile ci --locked "${args[@]}" --no-run'),
  );
  assert.ok(compileStep.run.trimEnd().endsWith('done <<< "$SUITES"'));
  assert.ok(
    suitesStep.run.includes('cargo nextest run --profile ci --locked "${args[@]}" || status=1'),
  );
  assert.ok(suitesStep.run.includes('done <<< "$SUITES"'));
  // A report left before the loop is never kept as a suite's.
  assert.ok(
    suitesStep.run.indexOf("rm -f target/nextest/ci/junit.xml") <
      suitesStep.run.indexOf("while read"),
  );
  assert.ok(
    suitesStep.run.includes('mv target/nextest/ci/junit.xml "$RUNNER_TEMP/junit/$part.xml"'),
  );
  // The tests that compile only on a beta channel run on a build of their own: the updater's
  // module and the three outside it, by exact name.
  const beta = job.steps.find((step) => step.name === "Test the updater on the beta channel");
  assert.ok(names.indexOf(beta.name) > suites);
  assert.equal(beta.env.CODESENSE_CHANNEL, "beta");
  assert.equal(
    beta.env.BETA_TESTS,
    "test(/^license::/)" +
      " | test(=commands::dashboard_launch::tests::license_headless_runs_count_a_starting_run_until_it_is_released)" +
      " | test(=mcp::feedback_tool::tests::in_the_beta_the_tool_refuses_and_says_why)" +
      " | test(=dashboard_publish::client::tests::a_beta_channel_uses_only_its_share_host)",
  );
  assert.equal(beta.env.CODESENSE_DASH_HOST, "https://share.codesense.ai");
  assert.match(beta.run, /CODESENSE_RELEASED_AT=/);
  assert.ok(
    beta.run.includes(
      "cargo nextest run --profile ci --locked -p codesense --lib --features dashboard-publish \\\n" +
        '  -E "$BETA_TESTS"',
    ),
  );
  assert.ok(beta.run.includes('mv target/nextest/ci/junit.xml "$RUNNER_TEMP/junit/license.xml"'));
  // A hang outside nextest's per-test timer fails the step, not the job's 60-minute limit.
  assert.equal(beta["timeout-minutes"], 15);
  // Only the beta step and PDF export's display-only renderer step filter the app's tests.
  const pdf = job.steps.find(
    (step) => step.name === "Test PDF export's renderer on a virtual display",
  );
  assert.ok(
    job.steps.every((step) => !/ -E /.test(step.run ?? "") || step === beta || step === pdf),
  );
  assert.equal(job["timeout-minutes"], 60);
  assert.ok(workflow.jobs["flaky-issues"].needs.includes("rust-linux-app"));
});

// The two-window e2e job drives the real webdriver app under xvfb. Not a required check: it carries
// the Linux app job's filter, so a window-path change runs it and a merge group skips it. Its
// cache is its own (the webdriver feature changes what compiles), saved only by the nightly run.
// The command ACL's tests run here with the feature; the Linux app job runs them without it.
test("rust.yml's two-window e2e job tests, builds and drives the webdriver app", () => {
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  const job = workflow.jobs["windows-e2e-linux"];
  const app = workflow.jobs["rust-linux-app"];
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job.if, `\${{ ${pathFilter} && ${offMergeGroups} }}`);
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.equal(job["timeout-minutes"], 45);
  assert.deepEqual(job.env, app.env);
  const step = (name) => {
    const index = job.steps.findIndex((s) => s.name === name);
    assert.ok(index >= 0, name);
    return [index, job.steps[index]];
  };
  // The Linux app job's setup, before any cargo command.
  const [, libs] = step("Install system libraries");
  assert.equal(libs.run, "bash scripts/install-linux-app-libs.sh xvfb xauth");
  for (const name of ["Set up pnpm", "Set up Node", "Install dependencies", "Set up Rust"])
    assert.deepEqual(
      step(name)[1],
      app.steps.find((s) => s.name === name),
      name,
    );
  const [cacheAt, cache] = step("Cache Rust dependencies");
  assert.deepEqual(cache.with, {
    "shared-key": "rust-linux-e2e",
    "save-if": "${{ github.event_name == 'schedule' && github.ref == 'refs/heads/main' }}",
    "cache-on-failure": true,
  });
  const [fetchAt, fetch] = step("Fetch bundled binaries");
  assert.equal(fetch.run, "bash scripts/fetch-bundled.sh");
  // The sidecars are built once, before the tests, and the app build does not build them again.
  const [sidecarsAt, sidecars] = step("Build sidecars");
  assert.equal(
    sidecars.run,
    "bash scripts/build-bridge.sh && bash scripts/build-session-server.sh",
  );
  const [testAt, test] = step(
    "Test the driver's commands, the command ACL and the pending timeout",
  );
  assert.equal(
    test.run,
    "cargo test --locked -p codesense --lib --features e2e-webdriver -- windows::e2e windows::command_acl windows::pending_timeout",
  );
  const [clippyAt, clippy] = step("Lint with the webdriver feature");
  assert.equal(
    clippy.run,
    [
      'cargo clippy --locked -p codesense --features e2e-webdriver --message-format=json > "$RUNNER_TEMP/clippy.json" || true',
      'node scripts/clippy-webdriver-module.mjs "$RUNNER_TEMP/clippy.json"',
      "",
    ].join("\n"),
  );
  const [pluginAt, plugin] = step("Check the WebDriver plugin is absent from a release build");
  assert.equal(plugin.run, "bash scripts/verify-wdio-plugin-release-absence.sh");
  const [buildAt, build] = step("Build the webdriver app");
  assert.equal(build.run, "pnpm build:e2e:windows:app");
  const scripts = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).scripts;
  assert.doesNotMatch(scripts["build:e2e:windows:app"], /build-(bridge|session-server)/);
  assert.equal(
    job.steps.filter((s) => /build-(bridge|session-server)\.sh/.test(s.run ?? "")).length,
    1,
    "the job builds the sidecars in one step",
  );
  const [runAt, run] = step("Drive two windows");
  assert.equal(run.run, "xvfb-run -a pnpm test:e2e:windows");
  // Five launches of the first-paint spec alone, so each has a cold first window.
  const [paintAt, paint] = step("Time first paints over five launches");
  assert.equal(paint.if, "(success() || failure()) && steps.build.outcome == 'success'");
  assert.deepEqual(paint.env, { CODESENSE_WINDOWS_E2E_FIRST_PAINT: "1" });
  assert.equal(
    paint.run,
    "for launch in 1 2 3 4 5; do\n" +
      '  FIRST_PAINT_LAUNCH="$launch" xvfb-run -a pnpm test:e2e:windows\n' +
      "done\n",
  );
  const [presentAt, present] = step("Check the absence check sees the webdriver bundle");
  assert.equal(present.if, "(success() || failure()) && steps.build.outcome == 'success'");
  assert.equal(
    present.run,
    "pnpm exec tsx scripts/verify-webdriver-absence.ts --expect-present dist",
  );
  assert.equal(build.id, "build");
  for (const [before, after] of [
    [cacheAt, fetchAt],
    [fetchAt, sidecarsAt],
    [sidecarsAt, testAt],
    [testAt, clippyAt],
    [clippyAt, pluginAt],
    [pluginAt, buildAt],
    [buildAt, runAt],
    [runAt, paintAt],
    [paintAt, presentAt],
  ])
    assert.ok(before < after, `${job.steps[before].name} before ${job.steps[after].name}`);
  const uploads = job.steps.filter((s) => s.uses?.startsWith("actions/upload-artifact@"));
  assert.deepEqual(
    uploads.map((s) => [s.if, s.with.name, s.with.path]),
    [
      [
        "failure()",
        "windows-e2e-logs-${{ github.run_id }}-${{ github.run_attempt }}",
        "tests/windows/logs/",
      ],
      [
        "always()",
        "windows-e2e-artifacts-${{ github.run_id }}-${{ github.run_attempt }}",
        "tests/windows/artifacts/",
      ],
    ],
  );
});

// PDF export's renderer tests are ignored without a display: this job runs them, and only them,
// on a virtual display with a German locale generated for the translation test. They live in the
// platform crate behind its pdf feature, which this step builds itself.
test("rust.yml's Linux app job runs PDF export's renderer tests under xvfb", () => {
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  const job = workflow.jobs["rust-linux-app"];
  const pdf = job.steps.find(
    (step) => step.name === "Test PDF export's renderer on a virtual display",
  );
  assert.ok(pdf, "the PDF renderer step");
  assert.deepEqual(pdf.env, { WEBKIT_DISABLE_DMABUF_RENDERER: "1" });
  assert.equal(
    pdf.run,
    "sudo locale-gen de_DE.UTF-8\n" +
      'mkdir -p "$RUNNER_TEMP/junit"\n' +
      "rm -f target/nextest/ci/junit.xml\n" +
      "status=0\n" +
      "xvfb-run -a cargo nextest run --profile ci --locked -p codesense-platform --features pdf --lib \\\n" +
      "  --retries 0 --run-ignored all -E 'test(/^pdf::/)' || status=1\n" +
      'if [[ -f target/nextest/ci/junit.xml ]]; then mv target/nextest/ci/junit.xml "$RUNNER_TEMP/junit/pdf.xml"; fi\n' +
      'exit "$status"\n',
  );
  // A report left by the Secret Service runs is never kept as pdf.xml.
  assert.ok(pdf.run.indexOf("rm -f target/nextest/ci/junit.xml") < pdf.run.indexOf("xvfb-run"));
  // The report sits where the uploaded folder holds it, out of reach of the next step's rm -f.
  const upload = job.steps.find((step) => step.name === "Upload JUnit report");
  assert.equal(upload.if, "always()");
  assert.equal(upload.with.path, "${{ runner.temp }}/junit/");
});

// The Linux compile check also builds the platform crate's PDF renderers and their tests, which
// only the app enables, so a change to them fails before the merge.
test("rust.yml's Linux check compiles the platform crate with pdf", () => {
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  const steps = workflow.jobs["rust-check-linux"].steps;
  const pdf = steps.find((step) => step.name === "Check the platform crate's PDF renderers");
  assert.ok(pdf, "the PDF renderers' check step");
  assert.equal(pdf.run, "cargo check --locked -p codesense-platform --features pdf --lib --tests");
  const libraries = steps.findIndex((step) => step.name === "Install system libraries");
  assert.ok(libraries >= 0, "the system libraries step");
  assert.ok(steps.indexOf(pdf) > libraries);
});

// A push diffs before..after; a new branch tip (before all zeros) tests everything.
test("rust.yml's changes job tests a push with no before, and diffs one that has it", (t) => {
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  const filter = workflow.jobs.changes.steps.find((step) => step.id === "filter");
  assert.equal(filter.env.PUSH_BEFORE, "${{ github.event.before }}");
  assert.equal(filter.env.PUSH_AFTER, "${{ github.event.after }}");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rust-changes-push-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, "output");
  const run = (before) => {
    fs.writeFileSync(output, "");
    // Outside a repository git diff fails, so a run that diffs exits non-zero.
    const result = spawnSync("bash", ["-e", "-c", filter.run], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        EVENT: "push",
        PUSH_BEFORE: before,
        PUSH_AFTER: "b".repeat(40),
        GITHUB_OUTPUT: output,
        GIT_CEILING_DIRECTORIES: dir,
      },
    });
    return { status: result.status, output: fs.readFileSync(output, "utf8") };
  };
  assert.deepEqual(run("0".repeat(40)), { status: 0, output: "rust=true\nmacos=true\n" });
  // The failed diff fails the changes job, and the Rust jobs then run.
  assert.notEqual(run("a".repeat(40)).status, 0);
});

test("only rust.yml's test jobs may skip a merge group on the changes job's output", () => {
  // queued()'s static job, renamed and gated on a changes job of its own.
  const filtered = (condition, file = "rust.yml", job = "rust-linux", needs = "changes") =>
    workflowPolicy(
      queued().replace(
        "  static:\n",
        "  changes:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    permissions:\n      contents: read\n" +
          `    steps:\n      - run: "true"\n  ${job}:\n    needs: ${needs}\n    if: ${condition}\n`,
      ),
      file,
    ).join("\n");
  for (const condition of [`\${{ ${pathFilter} }}`, `\${{ ${pathFilter} && (${macosOptIn}) }}`])
    assert.equal(filtered(condition), "", condition);
  for (const [condition, file, job, needs] of [
    [`\${{ ${pathFilter} }}`, "ci.yml", "rust-linux", "changes"],
    [`\${{ ${pathFilter} }}`, "rust.yml", "static", "changes"],
    [`\${{ ${pathFilter} }}`, "rust.yml", "rust-linux", "[]"],
    ["${{ needs.changes.outputs.rust != 'false' }}", "rust.yml", "rust-linux", "changes"],
    [
      "${{ !cancelled() && needs.changes.outputs.rust == 'true' }}",
      "rust.yml",
      "rust-linux",
      "changes",
    ],
    [
      `\${{ ${pathFilter} && github.event.pull_request.draft == false }}`,
      "rust.yml",
      "rust-linux",
      "changes",
    ],
    [`\${{ ${pathFilter} && (${macosOptIn}) && true }}`, "rust.yml", "rust-linux", "changes"],
    [`\${{ ${pathFilter} || true }}`, "rust.yml", "rust-linux", "changes"],
  ])
    assert.match(
      filtered(condition, file, job, needs),
      /if must begin with/,
      `${file} ${job}: ${condition}`,
    );
});

// Only rust.yml's non-required jobs (the macOS build and result, the Windows check and the Linux
// app job) may skip merge groups, with exactly this term after the path filter.
test("only rust.yml's non-required jobs may skip merge groups, and still run on push and schedule", () => {
  const filtered = (condition, file = "rust.yml", job = "rust-macos") =>
    workflowPolicy(
      queued().replace(
        "  static:\n",
        "  changes:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    permissions:\n      contents: read\n" +
          `    steps:\n      - run: "true"\n  ${job}:\n    needs: changes\n    if: ${condition}\n`,
      ),
      file,
    ).join("\n");
  for (const job of [
    "rust-macos-build",
    "rust-macos",
    "rust-check-windows",
    "rust-linux-app",
    "windows-e2e-linux",
  ])
    for (const condition of [
      `\${{ ${pathFilter} && ${offMergeGroups} && (${macosOptIn}) }}`,
      `\${{ ${pathFilter} && ${offMergeGroups} && (${windowsOptIn}) }}`,
      `\${{ ${pathFilter} && ${offMergeGroups} }}`,
    ])
      assert.equal(filtered(condition, "rust.yml", job), "", `${job}: ${condition}`);
  for (const [condition, file, job] of [
    [`\${{ ${pathFilter} && ${offMergeGroups} && (${macosOptIn}) }}`, "rust.yml", "rust-linux"],
    [
      `\${{ ${pathFilter} && ${offMergeGroups} && (${macosOptIn}) }}`,
      "rust.yml",
      "rust-macos-test",
    ],
    [`\${{ ${pathFilter} && ${offMergeGroups} && (${macosOptIn}) }}`, "ci.yml", "rust-macos"],
    [
      `\${{ ${pathFilter} && ${offMergeGroups} && (${windowsOptIn}) }}`,
      "ci.yml",
      "rust-check-windows",
    ],
    [
      `\${{ ${pathFilter} && github.event_name == 'pull_request' && (${windowsOptIn}) }}`,
      "rust.yml",
      "rust-check-windows",
    ],
    [`\${{ ${pathFilter} && ${offMergeGroups} && ${offMergeGroups} }}`, "rust.yml", "rust-macos"],
    [`\${{ ${pathFilter} && (${macosOptIn}) && ${offMergeGroups} }}`, "rust.yml", "rust-macos"],
    [`\${{ ${offMergeGroups} && ${pathFilter} && (${macosOptIn}) }}`, "rust.yml", "rust-macos"],
    ...["push", "schedule"].map((event) => [
      `\${{ ${pathFilter} && github.event_name != '${event}' && (${macosOptIn}) }}`,
      "rust.yml",
      "rust-macos",
    ]),
    [
      `\${{ ${pathFilter} && github.event_name == 'pull_request' && (${macosOptIn}) }}`,
      "rust.yml",
      "rust-macos",
    ],
  ])
    assert.match(
      filtered(condition, file, job),
      /if must begin with/,
      `${file} ${job}: ${condition}`,
    );
});

// Only rust.yml's macOS result job may lead with always(), so a cancelled run reports red; a job
// that builds or tests must not run after a cancel.
test("only rust.yml's macOS result job may run on a cancelled run", () => {
  const filtered = (condition, file = "rust.yml", job = "rust-macos") =>
    workflowPolicy(
      queued().replace(
        "  static:\n",
        "  changes:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    permissions:\n      contents: read\n" +
          `    steps:\n      - run: "true"\n  ${job}:\n    needs: changes\n    if: ${condition}\n`,
      ),
      file,
    ).join("\n");
  for (const condition of [
    `\${{ ${resultFilter} && ${offMergeGroups} && (${macosOptIn}) }}`,
    `\${{ ${resultFilter} }}`,
  ])
    assert.equal(filtered(condition), "", condition);
  for (const [condition, file, job] of [
    [
      `\${{ ${resultFilter} && ${offMergeGroups} && (${macosOptIn}) }}`,
      "rust.yml",
      "rust-macos-build",
    ],
    [`\${{ ${resultFilter} }}`, "rust.yml", "rust-linux"],
    [`\${{ ${resultFilter} && ${offMergeGroups} && (${macosOptIn}) }}`, "ci.yml", "rust-macos"],
    [`\${{ always() && ${pathFilter} && ${offMergeGroups} }}`, "rust.yml", "rust-macos"],
    [`\${{ always() && needs.changes.outputs.rust == 'true' }}`, "rust.yml", "rust-macos"],
  ])
    assert.match(
      filtered(condition, file, job),
      /if must begin with/,
      `${file} ${job}: ${condition}`,
    );
});

// The macOS filter's term may only follow the path filter's, in the macOS build and result jobs.
test("only rust.yml's macOS jobs may skip a change only Windows or Linux compiles", () => {
  const filtered = (condition, job = "rust-macos-build", file = "rust.yml") =>
    workflowPolicy(
      queued().replace(
        "  static:\n",
        "  changes:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    permissions:\n      contents: read\n" +
          `    steps:\n      - run: "true"\n  ${job}:\n    needs: changes\n    if: ${condition}\n`,
      ),
      file,
    ).join("\n");
  for (const [job, filter] of [
    ["rust-macos-build", pathFilter],
    ["rust-macos", resultFilter],
  ])
    for (const condition of [
      `\${{ ${filter} && ${macosOnly} && ${offMergeGroups} && (${macosOptIn}) }}`,
      `\${{ ${filter} && ${macosOnly} }}`,
    ])
      assert.equal(filtered(condition, job), "", `${job}: ${condition}`);
  for (const job of ["rust-linux", "rust-check-linux", "rust-guards", "rust-macos-test"])
    assert.match(filtered(`\${{ ${pathFilter} && ${macosOnly} }}`, job), /if must begin with/, job);
  for (const condition of [
    `\${{ ${pathFilter} && ${offMergeGroups} && ${macosOnly} && (${macosOptIn}) }}`,
    `\${{ ${pathFilter} && ${offMergeGroups} && (${macosOptIn}) && ${macosOnly} }}`,
    `\${{ ${macosOnly} && ${pathFilter} && ${offMergeGroups} && (${macosOptIn}) }}`,
    `\${{ !cancelled() && ${macosOnly} && needs.changes.outputs.rust != 'false' }}`,
    `\${{ ${pathFilter} && ${macosOnly} && ${macosOnly} }}`,
    `\${{ ${pathFilter} && needs.changes.outputs.macos == 'true' }}`,
  ])
    assert.match(filtered(condition), /if must begin with/, condition);
  assert.match(
    filtered(`\${{ ${pathFilter} && ${macosOnly} }}`, "rust-macos-build", "ci.yml"),
    /if must begin with/,
  );
});

// The shards may skip a superseded build, with exactly that condition and nothing else.
test("only rust.yml's macOS shards may skip a build that main moved past", () => {
  const filtered = (
    condition,
    job = "rust-macos-test",
    needs = "rust-macos-build",
    file = "rust.yml",
  ) =>
    workflowPolicy(
      queued().replace(
        "  static:\n",
        "  rust-macos-build:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    permissions:\n      contents: read\n" +
          `    steps:\n      - run: "true"\n  ${job}:\n    needs: ${needs}\n    if: ${condition}\n`,
      ),
      file,
    ).join("\n");
  assert.equal(filtered(shardsNotSuperseded), "");
  assert.equal(filtered(`\${{ ${shardsNotSuperseded} }}`), "");
  for (const [condition, job, needs, file] of [
    [shardsNotSuperseded, "rust-macos", "rust-macos-build", "rust.yml"],
    [shardsNotSuperseded, "rust-linux", "rust-macos-build", "rust.yml"],
    [shardsNotSuperseded, "rust-macos-test", "[]", "rust.yml"],
    [shardsNotSuperseded, "rust-macos-test", "rust-macos-build", "ci.yml"],
    [`${shardsNotSuperseded} && true`, "rust-macos-test", "rust-macos-build", "rust.yml"],
    [`${shardsNotSuperseded} || true`, "rust-macos-test", "rust-macos-build", "rust.yml"],
    [
      "needs.rust-macos-build.outputs.superseded == 'false'",
      "rust-macos-test",
      "rust-macos-build",
      "rust.yml",
    ],
  ])
    assert.match(
      filtered(condition, job, needs, file),
      /if must begin with/,
      `${file} ${job}: ${condition}`,
    );
});

// The merge queue runs the required Rust checks and nothing else.
test("a merge group runs only rust.yml's required jobs", () => {
  const jobs = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8")).jobs;
  const runs = (name) => {
    const terms = topLevelConjuncts(String(jobs[name].if ?? ""));
    if (
      terms.some((t) => t === offMergeGroups || /^github\.event_name == '(?!merge_group')/.test(t))
    )
      return false;
    return [jobs[name].needs ?? []].flat().every(runs);
  };
  assert.deepEqual(Object.keys(jobs).filter(runs).sort(), [
    "changes",
    "rust-check-linux",
    "rust-guards",
    "rust-linux",
  ]);
});

// rust-macos reports a push run whose macOS jobs were cancelled as superseded only when main's
// head has really moved on; a timeout or cancel at the head, a re-run, a failed lookup or a
// real failure stays red.
test("rust.yml's macOS result tells a replaced main run from a failed one", (t) => {
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  const script = workflow.jobs["rust-macos"].steps.at(-1).run;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rust-macos-result-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "step.sh"), script);
  // A fake git whose ls-remote prints main's head, or fails when HEAD_OF_MAIN is unset.
  fs.writeFileSync(
    path.join(dir, "git"),
    '#!/bin/sh\n[ -n "$HEAD_OF_MAIN" ] || exit 2\nprintf "%s\\trefs/heads/main\\n" "$HEAD_OF_MAIN"\n',
    { mode: 0o755 },
  );
  const run = (env) =>
    spawnSync("bash", ["-e", path.join(dir, "step.sh")], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_STEP_SUMMARY: path.join(dir, "summary.md"),
        EVENT: "push",
        ATTEMPT: "1",
        SHA: "aaa",
        REPO_URL: "https://example.invalid/repo",
        BUILD: "cancelled",
        TESTS: "skipped",
        SUPERSEDED: "",
        ...env,
      },
    }).status;
  assert.equal(run({ HEAD_OF_MAIN: "bbb" }), 0, "a newer push replaced it");
  assert.equal(run({ HEAD_OF_MAIN: "bbb", BUILD: "success", TESTS: "cancelled" }), 0);
  assert.notEqual(run({ HEAD_OF_MAIN: "aaa" }), 0, "cancelled or timed out at main's head");
  assert.notEqual(run({ HEAD_OF_MAIN: "" }), 0, "main's head unknown");
  assert.notEqual(run({ HEAD_OF_MAIN: "bbb", ATTEMPT: "2" }), 0, "a re-run");
  assert.notEqual(run({ HEAD_OF_MAIN: "bbb", EVENT: "schedule" }), 0, "the nightly");
  assert.notEqual(run({ HEAD_OF_MAIN: "bbb", BUILD: "success", TESTS: "failure" }), 0);
  assert.equal(run({ HEAD_OF_MAIN: "aaa", BUILD: "success", TESTS: "success" }), 0);
  assert.equal(run({ HEAD_OF_MAIN: "bbb", BUILD: "success", SUPERSEDED: "true" }), 0);
});

// A push to main that is no longer main's head when a macOS build part starts gives its runner
// back: every later step skips, the shards skip, and rust-macos reports it as superseded.
test("rust.yml's macOS build skips a push that main has moved past", (t) => {
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  const build = workflow.jobs["rust-macos-build"];
  // A push to main also shares one group per part or shard with cancel-in-progress, so a newer
  // push replaces a queued or running main macOS run; every other event gets a group per run.
  for (const [job, key] of [
    ["rust-macos-build", "part"],
    ["rust-macos-test", "shard"],
  ]) {
    const kind = job.replace("rust-macos-", "");
    assert.deepEqual(workflow.jobs[job].concurrency, {
      group: `\${{ github.event_name == 'push' && github.run_attempt == 1 && format('rust-macos-main-${kind}-{0}', matrix.${key}) || format('rust-macos-${kind}-{0}-{1}', github.run_id, matrix.${key}) }}`,
      "cancel-in-progress": "${{ github.event_name == 'push' && github.run_attempt == 1 }}",
    });
  }
  // The workflow-level group stays per commit, so the Linux and required jobs are never cancelled.
  assert.match(workflow.concurrency.group, /github\.event\.pull_request\.number \|\| github\.sha/);
  assert.equal(build.outputs.superseded, "${{ steps.superseded.outputs.superseded }}");
  const check = build.steps.findIndex((step) => step.id === "superseded");
  assert.ok(build.steps[check - 1].uses.startsWith("actions/checkout@"));
  // A re-run, asked for after main moved on, builds rather than report a superseded green.
  assert.equal(build.steps[check].if, "github.event_name == 'push' && github.run_attempt == 1");
  for (const step of build.steps.slice(check + 1))
    assert.ok(topLevelConjuncts(String(step.if ?? "")).includes(notSuperseded), step.name);
  assert.equal(workflow.jobs["rust-macos-test"].if, shardsNotSuperseded);

  // The check, run against a scratch origin.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rust-superseded-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...args) =>
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
      { cwd, encoding: "utf8" },
    ).trim();
  const work = path.join(dir, "work");
  git(dir, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(dir, "clone", "-q", path.join(dir, "origin.git"), "work");
  const commit = () => {
    fs.appendFileSync(path.join(work, "a"), "x\n");
    git(work, "add", ".");
    git(work, "commit", "-qm", "a");
    git(work, "push", "-q", "origin", "HEAD:main");
    return git(work, "rev-parse", "HEAD");
  };
  const output = path.join(dir, "output");
  const run = (sha) => {
    fs.writeFileSync(output, "");
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", build.steps[check].run],
      {
        cwd: work,
        encoding: "utf8",
        env: { ...process.env, SHA: sha, GITHUB_OUTPUT: output },
      },
    );
    return { status: result.status, output: fs.readFileSync(output, "utf8") };
  };
  const first = commit();
  assert.deepEqual(run(first), { status: 0, output: "" });
  commit();
  assert.deepEqual(run(first), { status: 0, output: "superseded=true\n" });
  // A failed lookup builds.
  git(work, "remote", "set-url", "origin", path.join(dir, "missing.git"));
  assert.deepEqual(run(first), { status: 0, output: "" });
});

test("rust-macos reports a superseded build as success, and anything else as before", (t) => {
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  const step = workflow.jobs["rust-macos"].steps.find(
    (s) => s.name === "Check the macOS build and tests",
  );
  assert.equal(step.env.SUPERSEDED, "${{ needs.rust-macos-build.outputs.superseded }}");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rust-macos-result-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const summary = path.join(dir, "summary");
  const run = (BUILD, TESTS, SUPERSEDED) => {
    fs.writeFileSync(summary, "");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
      encoding: "utf8",
      env: { ...process.env, BUILD, TESTS, SUPERSEDED, GITHUB_STEP_SUMMARY: summary },
    });
    return [result.status, fs.readFileSync(summary, "utf8")];
  };
  const superseded = "Superseded by a newer push to main; the nightly covers this commit.\n";
  assert.deepEqual(run("success", "skipped", "true"), [0, superseded]);
  assert.deepEqual(run("success", "success", ""), [0, ""]);
  assert.deepEqual(run("success", "failure", ""), [1, ""]);
  assert.deepEqual(run("failure", "skipped", ""), [1, ""]);
  assert.deepEqual(run("failure", "skipped", "true"), [1, ""]);
  assert.deepEqual(run("cancelled", "skipped", "true"), [1, ""]);
});

// The macOS workspace build is cached: the nightly builds cold and saves target/ with the commit
// it built; other runs restore it and date the checkout so only what changed since rebuilds.
test("rust.yml caches the macOS workspace build from the nightly, dated by commit", () => {
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  const steps = workflow.jobs["rust-macos-build"].steps;
  const index = (predicate, label) => {
    const i = steps.findIndex(predicate);
    assert.ok(i >= 0, label);
    return i;
  };
  const named = (name) => index((step) => step.name === name, name);
  const rustCache = index((step) => step.uses?.startsWith("Swatinem/rust-cache@"), "rust-cache");
  const key = index((step) => step.id === "build-cache-key", "key");
  const restore = index((step) => step.id === "build-cache", "restore");
  const dates = index((step) => step.run === "bash scripts/build-cache-dates.sh restore", "dates");
  const pin = index((step) => step.run === "bash scripts/build-cache-dates.sh pin", "pin");
  const record = index((step) => step.run === "bash scripts/build-cache-dates.sh record", "record");
  const save = index(
    (step) => step.uses?.startsWith("actions/cache/save@") && step.with.path === "target",
    "save",
  );
  const sidecar = named("Build session-server sidecar");
  const gitAi = named("Fetch git-ai");
  const docsData = named("Generate docs data");
  const compile = index((step) => step.id === "compile", "compile");
  const tracked = index((step) => step.id === "tracked", "tracked");
  // Restored before the dependency cache, which runs only on a miss, and dated before any cargo
  // command; the inputs pinned after every step that writes them; recorded right after the
  // build, and saved once the tracked files are checked.
  assert.ok(key < restore && restore < rustCache && rustCache < dates);
  assert.equal(
    steps[rustCache].if,
    `steps.build-cache.outputs.cache-matched-key == '' && ${notSuperseded}`,
  );
  assert.ok(dates < gitAi && dates < sidecar && dates < docsData);
  assert.ok(gitAi < pin && sidecar < pin && docsData < pin && pin < compile);
  assert.equal(record, compile + 1);
  assert.ok(tracked < save);
  assert.ok(
    steps.slice(0, dates).every((step) => !/(?:^|[\s;&|(])cargo(?=\s|$)/m.test(step.run ?? "")),
  );
  // Per part, per toolchain; the newest for this Cargo.lock first, then any.
  assert.match(steps[key].run, /rust-macos-build-\$PART-/);
  assert.match(steps[key].run, /rustc -vV/);
  assert.deepEqual(steps[restore].with, {
    path: "target",
    key: "${{ steps.build-cache-key.outputs.manifests }}-${{ github.run_id }}",
    "restore-keys":
      "${{ steps.build-cache-key.outputs.manifests }}-\n${{ steps.build-cache-key.outputs.toolchain }}-\n",
  });
  // The nightly builds cold; only a restored cache is dated.
  assert.equal(steps[restore].if, `github.event_name != 'schedule' && ${notSuperseded}`);
  for (const i of [dates, pin])
    assert.equal(
      steps[i].if,
      `steps.build-cache.outputs.cache-matched-key != '' && ${notSuperseded}`,
    );
  // The nightly on main records once its tests compiled, and saves, whatever the tests did, once
  // the record and the tracked files check succeeded, under a key no other run has.
  const nightly = "github.event_name == 'schedule' && github.ref == 'refs/heads/main'";
  assert.equal(steps[record].id, "record");
  assert.equal(steps[record].if, `${nightly} && ${notSuperseded}`);
  assert.equal(
    steps[save].if,
    `${nightly} && !cancelled() && steps.record.outcome == 'success' && steps.tracked.outcome == 'success' && ${notSuperseded}`,
  );
  assert.equal(
    steps[save].with.key,
    "${{ steps.build-cache-key.outputs.manifests }}-${{ github.run_id }}-${{ github.run_attempt }}",
  );
});

test("pull-requests read is limited to the DCO job and the exports guard job", () => {
  const dco = good
    .replace("  static:\n", "  dco:\n")
    .replace("      contents: read", "      contents: read\n      pull-requests: read");
  assert.deepEqual(workflowPolicy(dco, "dco.yml"), []);
  assert.match(workflowPolicy(dco, "ci.yml").join("\n"), /permissions must grant exactly/);
  assert.match(
    workflowPolicy(dco.replace("  dco:\n", "  other:\n"), "dco.yml").join("\n"),
    /permissions must grant exactly/,
  );
  assert.match(
    workflowPolicy(dco.replace("pull-requests: read", "pull-requests: write"), "dco.yml").join(
      "\n",
    ),
    /permissions must grant exactly/,
  );
  const guard = dco.replace("  dco:\n", "  guard:\n");
  assert.deepEqual(
    workflowPolicy(guard, "exports-guard.yml").filter((e) => e.includes("permissions")),
    [],
  );
  assert.match(workflowPolicy(guard, "ci.yml").join("\n"), /permissions must grant exactly/);
  assert.match(
    workflowPolicy(guard.replace("  guard:\n", "  strict-pins:\n"), "exports-guard.yml").join("\n"),
    /strict-pins: permissions must grant exactly contents: read/,
  );
});

const afterFailure = (condition, run = "cargo test --doc") => `      - id: compile
        run: cargo test --no-run
      - name: Doctests
        if: ${condition}
        run: ${run}
`;
test("accept a cargo step after a failure once an earlier step must have succeeded", () => {
  for (const gate of [
    "steps.compile.outcome == 'success'",
    "steps.compile.conclusion == 'success'",
    "steps.compile.outcome=='success'",
  ])
    assert.deepEqual(
      workflowPolicy(good + afterFailure(`(success() || failure()) && ${gate}`)),
      [],
    );
  for (const condition of [
    "${{ always() && steps.compile.outcome == 'success' }}",
    "(always() && steps.compile.outcome == 'success')",
  ])
    assert.deepEqual(workflowPolicy(good + afterFailure(condition)), []);
});
test("a step that only mentions cargo in a tool or path name is not a cargo step", () => {
  for (const run of ["cargo-nextest --version", "ls ~/.cargo/bin"])
    assert.deepEqual(workflowPolicy(good + afterFailure("always()", run)), []);
});
for (const [name, fixture, error] of [
  ["bracket secret reference", good + `      - run: echo "\${{ secrets['TOKEN'] }}"\n`, /secrets/],
  ["whole secret context", good + '      - run: echo "${{ toJSON(secrets) }}"\n', /secrets/],
  ["inherited secrets", good + "    secrets: inherit\n", /secrets/],
  ["unrecognized ubuntu label", good.replace("ubuntu-24.04", "ubuntu-build"), /GitHub-hosted/],
  ["self-hosted runner", good.replace("ubuntu-24.04", "self-hosted"), /GitHub-hosted/],
  // GitHub no longer serves macos-14; jobs on it are cancelled without a runner.
  ["retired macos-14 label", good.replace("ubuntu-24.04", "macos-14"), /GitHub-hosted/],
  [
    "self-hosted labels",
    good.replace("ubuntu-24.04", "[self-hosted, ubuntu-24.04]"),
    /GitHub-hosted/,
  ],
  ["runner expression", good.replace("ubuntu-24.04", "${{ vars.RUNNER }}"), /GitHub-hosted/],
  ...[
    ["a self-hosted matrix entry", "include:\n          - runner: self-hosted"],
    ["an unknown matrix label", "include:\n          - runner: ubuntu-build"],
    ["a matrix entry without a runner", "include:\n          - arch: arm64"],
    ["an empty matrix include", "include: []"],
    [
      "a matrix base axis",
      "runner: [self-hosted]\n        include:\n          - runner: ubuntu-24.04",
    ],
  ].map(([name, matrix]) => [
    name,
    good.replace(
      "runs-on: ubuntu-24.04",
      `runs-on: \${{ matrix.runner }}\n    strategy:\n      matrix:\n        ${matrix}`,
    ),
    /GitHub-hosted/,
  ]),
  ["unpinned container", good + "    container: ubuntu:24.04\n", /container image/],
  [
    "unpinned service",
    good + "    services:\n      db:\n        image: postgres:17\n",
    /service db image/,
  ],
  ["workflow_run", good.replace("pull_request,", "workflow_run,"), /triggers/],
  ["missing top-level permissions", good.replace("permissions: {}\n", ""), /top-level permissions/],
  ["job without timeout", good.replace("    timeout-minutes: 15\n", ""), /timeout-minutes/],
  [
    "second job without timeout",
    good + "  another:\n    runs-on: ubuntu-24.04\n    steps: []\n",
    /another: missing positive timeout/,
  ],
  ["write permissions", good.replace("contents: read", "contents: write"), /contents: read/],
  ["missing version comment", good.replace(" # v4.3.1", ""), /version|vX.Y.Z/],
  [
    "checkout credentials",
    good.replace("persist-credentials: false", "persist-credentials: true"),
    /persist-credentials/,
  ],
  [
    "no cancellation",
    good.replace("cancel-in-progress: true", "cancel-in-progress: false"),
    /concurrency/,
  ],
  // A failed setup step once let doctests compile without the sidecars, hiding the real failure.
  ["cargo after a failure", good + afterFailure("success() || failure()"), /runs cargo after/],
  ["cargo under always()", good + afterFailure("always()"), /runs cargo after/],
  [
    "cargo gated on a later step",
    good + afterFailure("always() && steps.later.outcome == 'success'") + "      - id: later\n",
    /runs cargo after/,
  ],
  [
    "cargo gated only on one side of ||",
    good + afterFailure("always() || steps.compile.outcome == 'success'"),
    /runs cargo after/,
  ],
  [
    "cargo gated under a top-level ||",
    good + afterFailure("always() || x && steps.compile.outcome == 'success'"),
    /runs cargo after/,
  ],
  [
    "cargo gated on a negated success",
    good + afterFailure("always() && !(steps.compile.outcome == 'success')"),
    /runs cargo after/,
  ],
  [
    "cargo after a shell separator",
    good + afterFailure("always()", "cd src-tauri && cargo test --doc"),
    /runs cargo after/,
  ],
]) {
  test(`reject ${name}`, () => assert.match(workflowPolicy(fixture).join("\n"), error));
}

test("hosted runner families and digest-pinned containers and services are accepted", () => {
  for (const runner of [
    "ubuntu-latest",
    "ubuntu-24.04",
    "ubuntu-22.04",
    "ubuntu-24.04-arm",
    "macos-latest",
    "macos-15",
    "macos-26",
    "windows-latest",
    "windows-2022",
    "windows-2025",
  ]) {
    const workflow =
      good.replace("ubuntu-24.04", runner) +
      `    container: ubuntu@sha256:${"a".repeat(64)}\n    services:\n      db:\n        image: postgres@sha256:${"b".repeat(64)}\n`;
    assert.deepEqual(workflowPolicy(workflow), []);
  }
});

test("CLI accepts valid workflows and returns policy errors for bad workflows", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-policy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "ci.yml");
  const run = () =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./workflow-policy.mjs", import.meta.url)), directory],
      { encoding: "utf8" },
    );
  fs.writeFileSync(file, good);
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /^workflow-policy: 1 files OK\n$/);
  for (const [, fixture, error] of badFixtures) {
    fs.writeFileSync(file, fixture);
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
  }
});

const scorecard = good
  .replace("pull_request, workflow_dispatch", "workflow_dispatch")
  .replace("  static:", "  scorecard:")
  .replace(
    "      contents: read",
    "      contents: read\n      security-events: write\n      id-token: write",
  );
test("Scorecard grants are confined to the exact file and job", () => {
  assert.deepEqual(workflowPolicy(scorecard, "scorecard.yml"), []);
  for (const file of ["ci.yml", "other.yml", "scorecard.yaml", "nested/scorecard.yml", ""]) {
    assert.match(workflowPolicy(scorecard, file).join("\n"), /permissions/);
  }
  assert.match(
    workflowPolicy(scorecard.replace("  scorecard:", "  other:"), "scorecard.yml").join("\n"),
    /permissions/,
  );
  for (const grant of ["security-events: write", "id-token: write"]) {
    assert.match(
      workflowPolicy(
        scorecard.replace(grant, grant.replace("write", "read")),
        "scorecard.yml",
      ).join("\n"),
      /permissions/,
    );
  }
  assert.match(
    workflowPolicy(
      scorecard.replace("id-token: write", "id-token: write\n      actions: read"),
      "scorecard.yml",
    ).join("\n"),
    /permissions/,
  );
  assert.match(
    workflowPolicy(scorecard.replace("contents: read", "contents: write"), "scorecard.yml").join(
      "\n",
    ),
    /permissions/,
  );
  assert.match(
    workflowPolicy(scorecard + "    secrets: inherit\n", "scorecard.yml").join("\n"),
    /secrets/,
  );
});
for (const trigger of ["schedule", "branch_protection_rule"]) {
  test(`${trigger} is confined to scorecard.yml${trigger === "schedule" ? ", rust.yml and nightly.yml" : ""}`, () => {
    const fixture = scorecard.replace("workflow_dispatch", trigger);
    assert.deepEqual(workflowPolicy(fixture, "scorecard.yml"), []);
    assert.match(workflowPolicy(fixture, "ci.yml").join("\n"), /triggers/);
    for (const file of ["rust.yml", "nightly.yml"])
      assert.equal(
        /triggers/.test(workflowPolicy(fixture, file).join("\n")),
        trigger !== "schedule",
        file,
      );
  });
}

const commitEmails = good
  .replace("on: [pull_request, workflow_dispatch]", "on: [schedule, workflow_dispatch]")
  .replace("  static:", "  commit-emails:");
test("commit-emails.yml permits schedule without extending the generic allowlist", () => {
  assert.deepEqual(workflowPolicy(commitEmails, "commit-emails.yml"), []);
  for (const file of ["ci.yml", "commit-emails.yaml", ""])
    assert.match(workflowPolicy(commitEmails, file).join("\n"), /triggers/);
});
for (const trigger of [
  "pull_request",
  "merge_group",
  "pull_request_target",
  "branch_protection_rule",
]) {
  test(`commit emails rejects ${trigger}`, () => {
    assert.match(
      workflowPolicy(commitEmails.replace("schedule", trigger), "commit-emails.yml").join("\n"),
      /triggers/,
    );
  });
}
test("commit emails grants contents: read to its single job only", () => {
  for (const extra of ["issues: write", "issues: read", "actions: read"])
    assert.match(
      workflowPolicy(
        commitEmails.replace("contents: read", `contents: read\n      ${extra}`),
        "commit-emails.yml",
      ).join("\n"),
      /permissions must grant exactly contents: read$/m,
    );
  assert.match(
    workflowPolicy(
      commitEmails.replace("contents: read", "contents: write"),
      "commit-emails.yml",
    ).join("\n"),
    /permissions/,
  );
  assert.match(
    workflowPolicy(commitEmails.replace("  commit-emails:", "  other:"), "commit-emails.yml").join(
      "\n",
    ),
    /only job must be commit-emails/,
  );
  const second =
    commitEmails +
    commitEmails
      .slice(commitEmails.indexOf("  commit-emails:"))
      .replace("  commit-emails:", "  second:");
  assert.match(
    workflowPolicy(second, "commit-emails.yml").join("\n"),
    /only job must be commit-emails/,
  );
});

for (const trigger of [
  "pull_request",
  "merge_group",
  "pull_request_target",
  "pull_request_review",
  "pull_request_review_comment",
]) {
  test(`Scorecard rejects ${trigger}`, () => {
    assert.match(
      workflowPolicy(scorecard.replace("workflow_dispatch", trigger), "scorecard.yml").join("\n"),
      /triggers/,
    );
  });
}
for (const [name, fixture, error] of [
  ["run step", scorecard + "      - run: echo unsafe\n", /approved uses/],
  [
    "unapproved action",
    scorecard.replace("actions/checkout@", "actions/setup-node@"),
    /approved uses/,
  ],
  ["checkout ref", scorecard + "          ref: another-branch\n", /checkout ref/],
  ["checkout repository", scorecard + "          repository: another/repository\n", /checkout ref/],
  [
    "persist credentials",
    scorecard.replace("persist-credentials: false", "persist-credentials: true"),
    /persist-credentials/,
  ],
  ["workflow env", scorecard + "env: {}\n", /workflow env/],
  ["workflow defaults", scorecard + "defaults: {}\n", /workflow env/],
  ["job env", scorecard + "    env: {}\n", /job env/],
  ["job defaults", scorecard + "    defaults: {}\n", /job defaults/],
  ["step env", scorecard + "        env: {}\n", /step env/],
  ["container", scorecard + `    container: ubuntu@sha256:${"a".repeat(64)}\n`, /job container/],
  ["services", scorecard + "    services: {}\n", /job services/],
]) {
  test(`Scorecard rejects ${name}`, () =>
    assert.match(workflowPolicy(fixture, "scorecard.yml").join("\n"), error));
}
test("exception grants do not cross between Scorecard and quarantine jobs", () => {
  const quarantine = good
    .replace("  static:", "  quarantine-issues:")
    .replace("contents: read", "contents: read\n      issues: read");
  assert.match(workflowPolicy(quarantine, "scorecard.yml").join("\n"), /permissions/);
  assert.match(
    workflowPolicy(
      quarantine.replace("  quarantine-issues:", "  scorecard:"),
      "scorecard.yml",
    ).join("\n"),
    /permissions/,
  );
  assert.match(workflowPolicy(scorecard, "quarantine.yml").join("\n"), /permissions/);
  assert.match(
    workflowPolicy(scorecard.replace("  scorecard:", "  quarantine-issues:"), "scorecard.yml").join(
      "\n",
    ),
    /permissions/,
  );
});
for (const on of [
  "push",
  "{push: {branches: [other]}}",
  "{push: {branches: [main], tags: ['*']}}",
]) {
  test(`Scorecard push must target main: ${on}`, () => {
    assert.match(
      workflowPolicy(scorecard.replace("[workflow_dispatch]", on), "scorecard.yml").join("\n"),
      /push must target/,
    );
  });
}
test("PR-only cancellation is allowed so push history scans remain uninterrupted", () => {
  const conditional = good.replace(
    "cancel-in-progress: true",
    "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
  );
  assert.deepEqual(workflowPolicy(conditional), []);
  assert.match(
    workflowPolicy(conditional.replace("== 'pull_request'", "== 'push'")).join("\n"),
    /concurrency/,
  );
});

test("issues read is limited to the exact quarantine workflow and job", () => {
  const quarantine = good
    .replace("  static:", "  quarantine-issues:")
    .replace("      contents: read", "      contents: read\n      issues: read");
  assert.deepEqual(workflowPolicy(quarantine, "quarantine.yml"), []);
  assert.deepEqual(
    workflowPolicy(
      quarantine.replace(
        "cancel-in-progress: true",
        "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
      ),
      "quarantine.yml",
    ),
    [],
  );
  for (const file of [
    "ci.yml",
    "quarantine.yaml",
    "other-quarantine.yml",
    "nested/quarantine.yml",
    "",
  ]) {
    assert.match(workflowPolicy(quarantine, file).join("\n"), /permissions must grant exactly/);
  }
  assert.match(
    workflowPolicy(quarantine.replace("  quarantine-issues:", "  other:"), "quarantine.yml").join(
      "\n",
    ),
    /permissions must grant exactly/,
  );
  assert.match(
    workflowPolicy(quarantine.replace("issues: read", "issues: write"), "quarantine.yml").join(
      "\n",
    ),
    /permissions must grant exactly/,
  );
  assert.match(
    workflowPolicy(quarantine.replace("      contents: read\n", ""), "quarantine.yml").join("\n"),
    /permissions must grant exactly/,
  );
  assert.match(
    workflowPolicy(quarantine.replace("      issues: read\n", ""), "quarantine.yml").join("\n"),
    /permissions must grant exactly/,
  );
  assert.match(
    workflowPolicy(
      scorecard.replace("  scorecard:", "  quarantine-issues:"),
      "quarantine.yml",
    ).join("\n"),
    /permissions must grant exactly/,
  );
});

test("Rust jobs preserve package coverage for nextest and doctests and always upload JUnit", () => {
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  const packages = (command) => [...command.matchAll(/-p ([a-z-]+)/g)].map((m) => m[1]).sort();
  // Linux runs only the crates that pass there today; the rest join once fixed.
  const portable = ["codesense-platform", "codesense-host-proto", "codesense-fs-core"];
  // Doctests run after a failed step, but only once the test build ran and succeeded.
  const afterCompile = "(success() || failure()) && steps.compile.outcome == 'success'";
  const doctests = (steps, condition = afterCompile) => {
    const docs = steps.find((step) => step.run?.includes("cargo test --doc"));
    assert.match(docs.run, /\$RUST_PACKAGES/);
    assert.deepEqual(packages(docs.run), []);
    assert.equal(docs["timeout-minutes"], 15);
    assert.equal(docs.if, condition);
  };
  const junitUpload = (steps, path = "target/nextest/ci/junit.xml") => {
    const junit = steps.find((step) => step.with?.path === path);
    assert.equal(junit.if, "always()");
    assert.equal(junit.uses, "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9");
  };

  const linux = workflow.jobs["rust-linux"];
  assert.deepEqual(packages(linux.env.RUST_PACKAGES), [...portable, "codesense-bridge"].sort());
  const runs = linux.steps.filter((step) => step.run?.includes("cargo nextest run"));
  assert.equal(runs.length, 2, "compile and run both use nextest");
  for (const step of runs) {
    assert.match(step.run, /--profile ci/);
    assert.match(step.run, /\$RUST_PACKAGES/);
    assert.deepEqual(packages(step.run), []);
  }
  assert.ok(runs.some((step) => step.id === "compile" && step.run.includes("--no-run")));
  assert.ok(runs.some((step) => !step.run.includes("--no-run")));
  doctests(linux.steps);
  assert.ok(linux.steps.some((step) => step.run?.includes("--tool cargo-nextest")));
  junitUpload(linux.steps);
  // The agent spawn's OS rules run on Linux too. A filter that matches no test passes in
  // libtest, so the step fails unless one ran.
  const spawnRules = linux.steps.find((step) =>
    step.run?.startsWith(
      "cargo test --locked -p codesense-pty-core --lib spawn::tests::os_rules:: ",
    ),
  );
  const rulesRan = new RegExp(/^grep -Eq '(.+)' /m.exec(spawnRules.run)[1], "m");
  assert.match("test result: ok. 4 passed; 0 failed; 0 ignored", rulesRan);
  assert.doesNotMatch("test result: ok. 0 passed; 0 failed; 0 ignored", rulesRan);

  // macOS compiles once, in two parts on two runners, into two nextest archives; the shards run
  // both and compile nothing.
  const build = workflow.jobs["rust-macos-build"];
  const parts = build.strategy.matrix.part;
  assert.deepEqual(parts, ["lib", "rest"]);
  assert.equal(build.name, "Rust (macOS arm64) build ${{ matrix.part }}");
  assert.equal(build.env.PART, "${{ matrix.part }}");
  assert.deepEqual(
    packages(build.env.RUST_PACKAGES),
    [
      ...portable,
      "codesense-pty-core",
      "codesense-session-server",
      "codesense-guards",
      "codesense",
    ].sort(),
  );
  const compile = build.steps.find((step) => step.id === "compile");
  assert.match(
    compile.run,
    /cargo nextest archive "\$\{packages\[@\]\}" "\$\{targets\[@\]\}" \\\n\s*--archive-file "\$RUNNER_TEMP\/nextest-archive-\$PART\.tar\.zst"/,
  );
  // Together the parts build what cargo test builds: libs' unit tests, then bins, examples and
  // every integration test cargo test would build (named, so those with required features are
  // left out as cargo test leaves them out).
  assert.match(compile.run, /targets=\(--lib\)/);
  assert.match(compile.run, /targets=\(--bins --examples\)/);
  assert.match(
    compile.run,
    /\.kind == \["test"\] and \(\(\.\["required-features"\] \/\/ \[\]\) \| length == 0\)/,
  );
  assert.match(compile.run, /targets\+=\(--test "\$name"\)/);
  assert.match(compile.run, /\$RUST_PACKAGES/);
  assert.deepEqual(packages(compile.run), []);
  assert.ok(build.steps.every((step) => !step.run?.includes("cargo nextest run")));
  // The docs data the build script writes exists before its first run, or it reruns.
  const docsData = build.steps.findIndex((step) => step.name === "Generate docs data");
  assert.ok(docsData >= 0 && docsData < build.steps.indexOf(compile));
  // The rest part builds the libraries the doctests link.
  doctests(build.steps, `${afterCompile} && matrix.part == 'rest' && ${notSuperseded}`);
  assert.ok(build.steps.some((step) => step.run?.includes("--tool cargo-nextest")));

  const shards = workflow.jobs["rust-macos-test"];
  const count = shards.strategy.matrix.shard.length;
  assert.deepEqual(
    shards.strategy.matrix.shard,
    Array.from({ length: count }, (_, i) => i + 1),
  );
  assert.equal(shards.name, `Rust (macOS arm64) tests \${{ matrix.shard }}/${count}`);
  assert.equal(shards.strategy["fail-fast"], false);
  assert.ok(
    shards.steps.every((step) => !/\bcargo (?:build|test|nextest archive)\b/.test(step.run ?? "")),
  );
  const test = shards.steps.find((step) => step.id === "test");
  assert.ok(test.run.includes(`for part in ${parts.join(" ")}; do`), test.run);
  assert.match(
    test.run,
    /cargo nextest run --profile ci --archive-file "\$RUNNER_TEMP\/rust-macos-tests\/nextest-archive-\$part\.tar\.zst"/,
  );
  assert.ok(test.run.includes(`--partition "slice:\${{ matrix.shard }}/${count}"`), test.run);
  assert.ok(shards.steps.some((step) => step.run?.includes("--tool cargo-nextest")));
  junitUpload(shards.steps, "${{ runner.temp }}/junit/");
  // One archive name per part for the whole run: a re-run of only the failed shards is a new
  // attempt and still finds both, and a re-run part replaces its own.
  const upload = build.steps.find((step) => step.name === "Upload test archive");
  assert.equal(upload.with.name, "rust-macos-tests-${{ matrix.part }}-${{ github.run_id }}");
  assert.equal(upload.with.overwrite, true);
  const download = shards.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(download.with.pattern, "rust-macos-tests-*-${{ github.run_id }}");
  assert.equal(download.with["merge-multiple"], true);
  // The shards build the emulator worker once before the tests, which rebuild it per process.
  const emulator = shards.steps.findIndex((step) => step.run === "pnpm run build:emulator");
  assert.ok(emulator >= 0 && emulator < shards.steps.indexOf(test));
});

// The build script's generators that write into directories it watches run before cargo; the
// step finds them in build.rs, so a new one is picked up and none is missed. nightly.yml's load
// lane copies rust-macos-build's prep, this step with it.
for (const [file, job] of [
  ["rust.yml", "rust-macos-build"],
  ["nightly.yml", "load"],
])
  test(`${file} generates every docs file build.rs writes before the first cargo command`, (t) => {
    const workflow = parse(fs.readFileSync(path.join(directory, file), "utf8"));
    const steps = workflow.jobs[job].steps;
    const index = steps.findIndex((s) => s.name === "Generate docs data");
    const step = steps[index];
    assert.ok(step, `${job} has no Generate docs data step`);
    const firstCargo = steps.findIndex((s) => /\bcargo /.test(s.run ?? ""));
    assert.ok(
      firstCargo < 0 || index < firstCargo,
      "the docs step runs before the first cargo command",
    );
    const root = path.join(directory, "..", "..");
    const buildRs = fs.readFileSync(path.join(root, "src-tauri/build.rs"), "utf8");
    const calls = [
      ...buildRs.matchAll(/^\s*run_docs_generator\("\.\.\/(scripts\/[^"]+\.mjs)"\);$/gm),
    ].map((m) => m[1]);
    assert.ok(calls.length > 0);
    // Every single-script call in build.rs has that exact shape (the _with_args calls write
    // archives dated to their inputs, so they need no head start).
    assert.equal(buildRs.match(/^\s*run_docs_generator\(/gm).length, calls.length);
    // Run the step with node replaced by a recorder, so it lists what it would run.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-data-step-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "node"), '#!/bin/sh\necho "$1" >> "$RAN"\n', { mode: 0o755 });
    const ran = path.join(dir, "ran");
    const result = spawnSync("bash", ["-e", "-c", step.run], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RAN: ran },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(ran, "utf8").trim().split("\n"), calls);
  });

// The nightly deletes its older macOS build caches: only that job may write actions, and only on
// the nightly on main in the base repository.
const cachePrune = good
  .replace("on: [pull_request, workflow_dispatch]", "on: [pull_request, merge_group, schedule]")
  .replace(
    "  static:\n",
    "  rust-macos-cache-prune:\n    if: ${{ !cancelled() && github.event_name == 'schedule' && github.ref == 'refs/heads/main' && !github.event.repository.fork }}\n",
  )
  .replace("      contents: read", "      actions: write");
test("actions write is limited to rust.yml's nightly cache prune", () => {
  assert.deepEqual(workflowPolicy(cachePrune, "rust.yml"), []);
  for (const file of ["ci.yml", "test-build.yml", ""])
    assert.match(workflowPolicy(cachePrune, file).join("\n"), /permissions must grant exactly/);
  for (const [from, to, error] of [
    ["  rust-macos-cache-prune:", "  rust-macos-build:", /permissions must grant exactly/],
    [
      "      actions: write",
      "      actions: write\n      contents: read",
      /permissions must grant exactly/,
    ],
    ["github.event_name == 'schedule' && ", "", /if must require/],
    ["github.ref == 'refs/heads/main' && ", "", /if must require github\.ref/],
    [" && !github.event.repository.fork", "", /if must require !github\.event\.repository\.fork/],
  ])
    assert.match(
      workflowPolicy(cachePrune.replace(from, to), "rust.yml").join("\n"),
      error,
      `${from} -> ${to}`,
    );
  // The macOS build itself keeps contents: read.
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  assert.deepEqual(workflow.jobs["rust-macos-build"].permissions, { contents: "read" });
  const prune = workflow.jobs["rust-macos-cache-prune"];
  assert.deepEqual(prune.permissions, { actions: "write" });
  assert.equal(prune.needs, "rust-macos-build");
  assert.equal(
    prune.if,
    "${{ !cancelled() && github.event_name == 'schedule' && github.ref == 'refs/heads/main' && !github.event.repository.fork }}",
  );
});

// The prune step, run with a stand-in gh: the newest cache per part stays, every older one goes.
test("the cache prune deletes all but the newest macOS build cache per part", (t) => {
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  const step = workflow.jobs["rust-macos-cache-prune"].steps[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rust-cache-prune-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const listing = [
    [11, "rust-macos-build-lib-macOS-ARM64-aaaa-1111-100-1", "2026-11-17T06:40:00Z"],
    [12, "rust-macos-build-rest-macOS-ARM64-aaaa-1111-100-1", "2026-11-17T06:50:00Z"],
    [21, "rust-macos-build-lib-macOS-ARM64-aaaa-2222-200-1", "2026-11-18T06:40:00Z"],
    [22, "rust-macos-build-rest-macOS-ARM64-aaaa-2222-200-1", "2026-11-18T06:50:00Z"],
    [31, "rust-macos-build-lib-macOS-ARM64-bbbb-2222-300-1", "2026-11-19T06:40:00Z"],
  ]
    .map((row) => row.join("\t"))
    .join("\n");
  fs.writeFileSync(path.join(dir, "listing"), `${listing}\n`);
  // The listing comes back already through --jq; a delete is logged, and the one named by FAIL_ID
  // fails with FAIL_STATUS.
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/bash\nif [[ "$*" == *DELETE* ]]; then echo "\${@: -1}" >> "${dir}/deleted"; if [[ -n "$FAIL_ID" && "$*" == */$FAIL_ID ]]; then echo "gh: HTTP $FAIL_STATUS" >&2; exit 1; fi; else cat "${dir}/listing"; fi\n`,
    { mode: 0o755 },
  );
  const prune = (failure = {}) => {
    fs.rmSync(path.join(dir, "deleted"), { force: true });
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_REPO: "o/r", ...failure },
    });
    const deleted = fs.readFileSync(path.join(dir, "deleted"), "utf8").trim().split("\n").sort();
    return { status: result.status, stdout: result.stdout, deleted };
  };
  const stale = ["11", "12", "21"].map((id) => `repos/o/r/actions/caches/${id}`);
  const clean = prune();
  assert.equal(clean.status, 0);
  assert.deepEqual(clean.deleted, stale);
  // A cache evicted between the listing and its delete is already gone: the prune goes on.
  const evicted = prune({ FAIL_ID: "12", FAIL_STATUS: "404" });
  assert.equal(evicted.status, 0);
  assert.match(evicted.stdout, /::notice::cache 12 already gone/);
  assert.deepEqual(evicted.deleted, stale);
  // Any other failure, a lost permission or a server error, fails the step.
  for (const status of ["403", "500"]) {
    const failed = prune({ FAIL_ID: "12", FAIL_STATUS: status });
    assert.notEqual(failed.status, 0, status);
    assert.doesNotMatch(failed.stdout, /already gone/, status);
  }
});

const flakyIssues = good
  .replace(
    "on: [pull_request, workflow_dispatch]",
    "on:\n  pull_request:\n  push:\n    branches: [main]",
  )
  .replace(
    "  static:\n",
    "  flaky-issues:\n    if: ${{ !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' && !github.event.repository.fork }}\n    concurrency:\n      group: flaky-issues\n      cancel-in-progress: false\n",
  )
  .replace("      contents: read", "      contents: read\n      issues: write");
test("issues write is limited to the flaky-issues job in rust.yml", () => {
  assert.deepEqual(workflowPolicy(flakyIssues, "rust.yml"), []);
  for (const file of ["ci.yml", "quarantine.yml", "rust.yaml", "nested/rust.yml", ""])
    assert.match(workflowPolicy(flakyIssues, file).join("\n"), /permissions must grant exactly/);
  for (const [from, to] of [
    ["  flaky-issues:", "  rust-linux:"],
    // The reports come from download-artifact, which needs no token scope.
    ["      contents: read\n", "      actions: read\n      contents: read\n"],
    ["      issues: write\n", ""],
    ["issues: write", "issues: read"],
    ["      contents: read\n", "      contents: read\n      pull-requests: write\n"],
  ])
    assert.match(
      workflowPolicy(flakyIssues.replace(from, to), "rust.yml").join("\n"),
      /permissions must grant exactly/,
      `${from} -> ${to}`,
    );
});
test("flaky-issues runs only for pushes to main outside forks", () => {
  for (const [term, replacement] of [
    ["github.event_name == 'push'", "github.event_name != 'pull_request'"],
    ["github.ref == 'refs/heads/main'", "true"],
    ["!github.event.repository.fork", "true"],
  ])
    assert.match(
      workflowPolicy(flakyIssues.replace(term, replacement), "rust.yml").join("\n"),
      new RegExp(`if must require ${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  // A top-level || makes the whole expression one term, so no required term counts.
  const or = flakyIssues.replace(
    "${{ !cancelled() &&",
    "${{ github.event_name == 'pull_request' || !cancelled() &&",
  );
  assert.match(workflowPolicy(or, "rust.yml").join("\n"), /if must require/);
  assert.match(
    workflowPolicy(flakyIssues.replace(/^ {4}if: .*\n/m, ""), "rust.yml").join("\n"),
    /if must require/,
  );
});
// nightly.yml runs on a schedule or by hand only, so none of its jobs can be a required check or
// run pull request code; its issue job alone writes, on the scheduled run on main.
const nightly = good
  .replace("on: [pull_request, workflow_dispatch]", "on: [schedule, workflow_dispatch]")
  .replace(
    "  static:\n",
    "  nightly-issue:\n    if: ${{ !cancelled() && contains(needs.*.result, 'failure') && github.event_name == 'schedule' && github.ref == 'refs/heads/main' && !github.event.repository.fork }}\n    concurrency:\n      group: nightly-issue\n      cancel-in-progress: false\n",
  )
  .replace("      contents: read", "      contents: read\n      issues: write");
test("nightly.yml alone may run on schedule and workflow_dispatch", () => {
  assert.deepEqual(workflowPolicy(nightly, "nightly.yml"), []);
  const lanes = good.replace(
    "on: [pull_request, workflow_dispatch]",
    "on: [schedule, workflow_dispatch]",
  );
  assert.deepEqual(workflowPolicy(lanes, "nightly.yml"), []);
  for (const file of ["ci.yml", "tiles-release.yml", "nightly.yaml", "nested/nightly.yml", ""])
    assert.match(workflowPolicy(lanes, file).join("\n"), /triggers/, file);
});
for (const trigger of ["pull_request", "merge_group", "push", "pull_request_target"]) {
  test(`nightly.yml rejects ${trigger}`, () => {
    const fixture = nightly.replace("on: [schedule,", `on: [schedule, ${trigger},`);
    assert.match(workflowPolicy(fixture, "nightly.yml").join("\n"), /triggers/);
  });
}
test("issues write in nightly.yml is limited to the nightly-issue job", () => {
  for (const file of ["ci.yml", "rust.yml", "nightly.yaml", "tiles-release.yml", ""])
    assert.match(
      workflowPolicy(nightly, file).join("\n"),
      /permissions must grant exactly|triggers/,
      file,
    );
  assert.match(
    workflowPolicy(nightly.replace("  nightly-issue:", "  flaky-issues:"), "nightly.yml").join(
      "\n",
    ),
    /permissions must grant exactly contents: read$/m,
  );
  assert.match(
    workflowPolicy(nightly.replace("  nightly-issue:", "  load:"), "nightly.yml").join("\n"),
    /permissions must grant exactly contents: read$/m,
  );
  // And the nightly writer gets nothing in rust.yml.
  assert.match(
    workflowPolicy(
      nightly.replace("on: [schedule, workflow_dispatch]", "on: [schedule]"),
      "rust.yml",
    ).join("\n"),
    /nightly-issue: permissions must grant exactly contents: read$/m,
  );
  for (const [from, to] of [
    ["      issues: write\n", ""],
    ["issues: write", "issues: read"],
    ["      contents: read\n", "      actions: read\n      contents: read\n"],
    ["      contents: read\n", "      contents: read\n      pull-requests: write\n"],
    ["      contents: read\n", ""],
  ])
    assert.match(
      workflowPolicy(nightly.replace(from, to), "nightly.yml").join("\n"),
      /permissions must grant exactly contents: read, issues: write/,
      `${from} -> ${to}`,
    );
});
test("nightly-issue runs only for the scheduled run on main outside forks", () => {
  // nightly.yml has no push trigger, so the push-or-schedule rule leaves only the schedule.
  for (const [term, replacement, message] of [
    [
      "github.event_name == 'schedule'",
      "github.event_name != 'pull_request'",
      /or github\.event_name == 'schedule' at the top level/,
    ],
    [
      "github.ref == 'refs/heads/main'",
      "true",
      /if must require github\.ref == 'refs\/heads\/main'/,
    ],
    ["!github.event.repository.fork", "true", /if must require !github\.event\.repository\.fork/],
  ])
    assert.match(
      workflowPolicy(nightly.replace(term, replacement), "nightly.yml").join("\n"),
      message,
      term,
    );
  for (const term of [
    "github.event_name == 'schedule'",
    "github.ref == 'refs/heads/main'",
    "!github.event.repository.fork",
  ])
    assert.match(
      workflowPolicy(
        nightly.replace(`&& ${term}`, `&& (${term} || github.event_name == 'workflow_dispatch')`),
        "nightly.yml",
      ).join("\n"),
      /if must require/,
      term,
    );
  const or = nightly.replace(
    "${{ !cancelled() &&",
    "${{ github.event_name == 'workflow_dispatch' || !cancelled() &&",
  );
  assert.match(workflowPolicy(or, "nightly.yml").join("\n"), /if must require/);
  assert.match(
    workflowPolicy(nightly.replace(/^ {4}if: .*\n/m, ""), "nightly.yml").join("\n"),
    /if must require/,
  );
});
test("an issue-writing main writer holds one fixed, non-cancelling job concurrency", () => {
  for (const [fixture, file, job] of [
    [nightly, "nightly.yml", "nightly-issue"],
    [flakyIssues, "rust.yml", "flaky-issues"],
  ]) {
    const message = new RegExp(
      `${job}: concurrency must be one fixed group with cancel-in-progress: false`,
    );
    for (const [from, to] of [
      [/^ {4}concurrency:\n.*\n.*\n/m, ""],
      ["cancel-in-progress: false", "cancel-in-progress: true"],
      ["      cancel-in-progress: false\n", ""],
      [`group: ${job}`, "group: ${{ github.run_id }}"],
      [`group: ${job}`, "group: ''"],
    ])
      assert.match(
        workflowPolicy(fixture.replace(from, to), file).join("\n"),
        message,
        `${file}: ${from} -> ${to}`,
      );
  }
});
test("the main writers are exactly flaky-issues, the cache prune and nightly-issue", () => {
  assert.deepEqual(
    MAIN_WRITERS.map((writer) => `${writer.file}:${writer.job}`),
    ["rust.yml:flaky-issues", "rust.yml:rust-macos-cache-prune", "nightly.yml:nightly-issue"],
  );
});
test("Rust test jobs list flaky tests after nextest and only flaky-issues writes issues", () => {
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  for (const [name, after, run] of [
    [
      "rust-macos-test",
      "success() || failure()",
      'for report in "$RUNNER_TEMP"/junit/*.xml; do node scripts/flaky-tests.mjs summary "$report"; done',
    ],
    [
      "rust-linux",
      "(success() || failure()) && steps.compile.outcome == 'success'",
      "node scripts/flaky-tests.mjs summary target/nextest/ci/junit.xml",
    ],
    [
      "rust-linux-app",
      "(success() || failure()) && steps.compile.outcome == 'success'",
      'for report in "$RUNNER_TEMP"/junit/*.xml; do node scripts/flaky-tests.mjs summary "$report"; done',
    ],
  ]) {
    const job = workflow.jobs[name];
    assert.deepEqual(job.permissions, { contents: "read" });
    const steps = job.steps;
    const test = steps.findLastIndex(
      (step) => step.run?.includes("cargo nextest run") && !step.run.includes("--no-run"),
    );
    const flaky = steps[test + 1];
    assert.equal(flaky.run, run, name);
    assert.equal(flaky.if, after, name);
  }
  // A red macOS build or shard on main lists its failed tests and run link in the job summary,
  // read-only.
  const redOnMain = "(failure() || cancelled()) && github.ref == 'refs/heads/main'";
  for (const [name, report, condition] of [
    ["rust-macos-build", "target/nextest/ci/junit.xml", `${redOnMain} && ${notSuperseded}`],
    ["rust-macos-test", '"$RUNNER_TEMP/junit/$part.xml"', redOnMain],
  ]) {
    const red = workflow.jobs[name].steps.find(
      (step) => step.name === "Summarize a red run on main",
    );
    assert.equal(red.if, condition, name);
    assert.ok(
      red.run.includes(`node scripts/flaky-tests.mjs failed ${report} --run-url "$RUN_URL"`),
      name,
    );
  }
  const issues = workflow.jobs["flaky-issues"];
  assert.deepEqual([...issues.needs].sort(), ["rust-linux", "rust-linux-app", "rust-macos"]);
  assert.deepEqual(issues.concurrency, { group: "flaky-issues", "cancel-in-progress": false });
  assert.ok(issues.steps.every((step) => !/\bcargo\b/.test(step.run ?? "")));
  const download = issues.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  // Every JUnit upload, and nothing else uploaded, matches the download pattern (* is a glob).
  const glob = new RegExp(
    `^${download.with.pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*")}$`,
  );
  for (const [name, reports] of [
    ["rust-macos-build", 0],
    ["rust-macos-test", 1],
    ["rust-linux", 1],
    ["rust-linux-app", 1],
  ]) {
    const uploads = workflow.jobs[name].steps.filter((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    const junit = uploads.filter((step) => /junit/.test(step.with.path));
    assert.equal(junit.length, reports, name);
    for (const step of junit) assert.match(step.with.name, glob, name);
    for (const step of uploads.filter((step) => !junit.includes(step)))
      assert.doesNotMatch(step.with.name, glob, `${name}: ${step.with.name}`);
  }
  assert.equal(
    download.with.pattern,
    "rust-*-junit-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  assert.ok(issues.steps.some((step) => step.run?.includes("node scripts/flaky-tests.mjs track")));
});

test("the open-issue check covers every quarantine ledger file", (t) => {
  const workflow = parse(fs.readFileSync(path.join(directory, "quarantine.yml"), "utf8"));
  const step = workflow.jobs["quarantine-issues"].steps.find(
    (s) => s.name === "Require open quarantine issues",
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quarantine-open-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, "tests"));
  // Fake gh: issue 2 is closed, every other issue is open; each lookup is recorded.
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh\necho "$3" >> "${dir}/gh.calls"\ncase "$3" in */issues/2) echo CLOSED ;; *) echo OPEN ;; esac\n`,
    { mode: 0o755 },
  );
  // Fake jq for `jq -r '.[].issue' <file>`, so the test needs only node.
  fs.writeFileSync(
    path.join(bin, "jq"),
    `#!/bin/sh\nexec node -e 'for (const e of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))) console.log(e.issue)' "$3"\n`,
    { mode: 0o755 },
  );
  const issue = (n) => [{ issue: `https://github.com/example/project/issues/${n}` }];
  const run = () => {
    fs.rmSync(path.join(dir, "gh.calls"), { force: true });
    return spawnSync("bash", ["-c", step.run], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  };
  fs.writeFileSync(path.join(dir, "tests/quarantine.json"), JSON.stringify(issue(1)));
  fs.writeFileSync(path.join(dir, "tests/quarantine.extra.json"), JSON.stringify(issue(3)));
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(dir, "gh.calls"), "utf8").trim().split("\n").sort(), [
    "https://github.com/example/project/issues/1",
    "https://github.com/example/project/issues/3",
  ]);
  fs.writeFileSync(path.join(dir, "tests/quarantine.extra.json"), JSON.stringify(issue(2)));
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /issues\/2 \(CLOSED, tests\/quarantine\.extra\.json\)/);
});

// The test build's `platform` input picks the job: `all` runs every job, a platform only its own.
const testBuildFile = "test-build.yml";
const testBuild = () => fs.readFileSync(path.join(directory, testBuildFile), "utf8");

test("test build: the platform input and the jobs it gates", () => {
  const workflow = parse(testBuild());
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.platform, {
    description: "Which app to build",
    type: "choice",
    options: ["all", "macos", "windows", "linux"],
    default: "all",
  });
  assert.equal(
    workflow.jobs["macos-app"].if,
    "inputs.platform == 'all' || inputs.platform == 'macos'",
  );
  assert.equal(
    workflow.jobs["linux-app"].if,
    "inputs.platform == 'all' || inputs.platform == 'linux'",
  );
  const linux = workflow.jobs["linux-app"];
  assert.equal(linux["runs-on"], "${{ matrix.runner }}");
  assert.deepEqual(linux.strategy.matrix.include, [
    { arch: "x86_64", runner: "ubuntu-22.04", bundles: "deb,rpm,appimage" },
    { arch: "arm64", runner: "ubuntu-24.04-arm", bundles: "deb,rpm,appimage" },
  ]);
  assert.equal(linux.strategy["fail-fast"], false);
});

test("test build: the Linux job uploads the deb, rpm and AppImage, each one file kept 7 days", () => {
  const uploads = parse(testBuild()).jobs["linux-app"].steps.filter((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.deepEqual(
    uploads.map((step) => step.with.path),
    [
      "target/release/bundle/deb/*.deb",
      "target/release/bundle/rpm/*.rpm",
      "target/release/bundle/appimage/*.AppImage",
    ],
  );
  // Every leg builds all three formats, so no upload is conditional.
  assert.deepEqual(
    uploads.map((step) => step.if),
    [undefined, undefined, undefined],
  );
  for (const { with: inputs } of uploads) {
    assert.equal(inputs.archive, false);
    assert.equal(inputs["retention-days"], 7);
    assert.equal(inputs["if-no-files-found"], "error");
  }
});

test("test build: each package installs in its own clean container on its build's runner", () => {
  const { jobs } = parse(testBuild());
  const install = jobs["linux-install"];
  assert.equal(install.if, "inputs.platform == 'all' || inputs.platform == 'linux'");
  assert.equal(install.needs, "linux-app");
  assert.equal(install["runs-on"], "${{ matrix.runner }}");
  assert.equal(install.strategy["fail-fast"], false);
  assert.deepEqual(install.strategy.matrix.include, [
    {
      arch: "x86_64",
      runner: "ubuntu-22.04",
      type: "deb",
      image: "ubuntu:22.04",
      package: "*_amd64.deb",
    },
    {
      arch: "x86_64",
      runner: "ubuntu-22.04",
      type: "deb",
      image: "ubuntu:24.04",
      package: "*_amd64.deb",
    },
    {
      arch: "x86_64",
      runner: "ubuntu-22.04",
      type: "rpm",
      image: "fedora:44",
      package: "*.x86_64.rpm",
    },
    {
      arch: "arm64",
      runner: "ubuntu-24.04-arm",
      type: "deb",
      image: "ubuntu:24.04",
      package: "*_arm64.deb",
    },
    {
      arch: "arm64",
      runner: "ubuntu-24.04-arm",
      type: "rpm",
      image: "fedora:44",
      package: "*.aarch64.rpm",
    },
  ]);
  // Each leg runs on its arch's build runner.
  const builds = Object.fromEntries(
    jobs["linux-app"].strategy.matrix.include.map(({ arch, runner }) => [arch, runner]),
  );
  for (const { arch, runner } of install.strategy.matrix.include)
    assert.equal(runner, builds[arch]);
  // linux-app uploads each package as one unzipped file, which download-artifact reads from v8.
  const download = install.steps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  assert.equal(download.uses, "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333");
  assert.equal(download.with.pattern, "${{ matrix.package }}");
  const step = (name) => install.steps.find((s) => s.name === name);
  const run = step("Install the package in a clean container");
  assert.match(run.run, /smoke-linux\.sh install "\$TYPE" "\$IMAGE"/);
  assert.equal(run.if, undefined);
  // The step timeout is a backstop inside the job's.
  assert.equal(run["timeout-minutes"], 30);
  assert.ok(install["timeout-minutes"] > run["timeout-minutes"]);
  assert.equal(run["env"]["SMOKE_APT_CACHE"], "${{ runner.temp }}/apt-archives");
  const upload = step("Upload the listing");
  assert.equal(upload.with.path, "${{ runner.temp }}/smoke/${{ matrix.type }}.list");
  assert.equal(upload.with["if-no-files-found"], "error");
});

test("test build: a deb leg restores its apt archives, and saves them even after a failure", () => {
  const steps = parse(testBuild()).jobs["linux-install"].steps;
  const names = steps.map((step) => step.name);
  const step = (name) => steps.find((s) => s.name === name);
  const key = step("Key the apt archive cache");
  const restore = step("Restore the apt archives");
  const hand = step("Hand the apt archives to the runner");
  const save = step("Save the apt archives");
  assert.equal(key.if, "matrix.type == 'deb'");
  assert.match(
    key.run,
    /smoke-linux\.sh cache-key "\$IMAGE" "\$RUNNER_TEMP\/packages" "\$\(date -u \+%G-W%V\)"/,
  );
  assert.equal(restore.if, "matrix.type == 'deb'");
  assert.match(restore.uses, /^actions\/cache\/restore@[0-9a-f]{40}$/);
  assert.equal(restore.with.path, "${{ runner.temp }}/apt-archives");
  assert.equal(restore.with.key, "${{ steps.apt-key.outputs.key }}");
  assert.equal(restore.with["restore-keys"], "${{ steps.apt-key.outputs.restore }}");
  assert.match(save.uses, /^actions\/cache\/save@[0-9a-f]{40}$/);
  assert.equal(save.with.path, restore.with.path);
  // A failed or timed-out install saves under a key of its own, which the week's exact key never
  // hits, so the next run still restores it by prefix, finishes and saves the full set.
  assert.equal(
    save.with.key,
    "${{ steps.install.outcome == 'success' && steps.apt-key.outputs.key || format('{0}-partial-{1}-{2}', steps.apt-key.outputs.key, github.run_id, github.run_attempt) }}",
  );
  assert.equal(step("Install the package in a clean container").id, "install");
  const onMiss =
    "always() && matrix.type == 'deb' && steps.apt-key.outcome == 'success' && steps.apt-restore.outputs.cache-hit != 'true'";
  assert.equal(hand.if, onMiss);
  assert.equal(save.if, onMiss);
  // The runner owns the archives, with nothing it cannot read, before the cache saves them.
  assert.match(hand.run, /sudo chown -R/);
  assert.match(hand.run, /rm -rf "\$SMOKE_APT_CACHE\/partial" "\$SMOKE_APT_CACHE\/lock"/);
  const order = [key, restore, step("Install the package in a clean container"), hand, save].map(
    (s) => names.indexOf(s.name),
  );
  assert.deepEqual(
    order,
    order.toSorted((a, b) => a - b),
  );
});

test("test build: each arch's deb listings are compared with its rpm's after the installs", () => {
  const job = parse(testBuild()).jobs["linux-resources"];
  assert.equal(job.if, "inputs.platform == 'all' || inputs.platform == 'linux'");
  assert.equal(job.needs, "linux-install");
  const download = job.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(download.with.pattern, "linux-install-*");
  // Each listing keeps its own directory: every leg's file is deb.list or rpm.list.
  assert.equal(download.with["merge-multiple"], undefined);
  const compare = job.steps.find((step) => /same-resources/.test(step.run ?? ""));
  // Every install leg's listing, by name, and a count that catches a leg the matrix gains.
  assert.match(compare.run, /^\s*compare x86_64 ubuntu-22\.04 ubuntu-24\.04$/m);
  assert.match(compare.run, /^\s*compare arm64 ubuntu-24\.04$/m);
  assert.match(compare.run, /\[\[ \$found -eq 5 \]\]/);
  const legs = parse(testBuild()).jobs["linux-install"].strategy.matrix.include;
  assert.equal(legs.length, 5);
});

test("test build: the AppImage launches beside the installs, on the x86_64 build's runner", () => {
  const { jobs } = parse(testBuild());
  const smoke = jobs["linux-smoke"];
  assert.equal(smoke.if, "inputs.platform == 'all' || inputs.platform == 'linux'");
  assert.equal(smoke.needs, "linux-app");
  assert.equal(smoke["runs-on"], "ubuntu-22.04");
  const download = smoke.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(download.with.pattern, "*_amd64.AppImage");
  const runs = smoke.steps.filter((step) => step.run).map((step) => step.run);
  assert.ok(!runs.some((run) => /smoke-linux\.sh install/.test(run)));
  assert.deepEqual(
    runs
      .filter((run) => /smoke-linux\.sh (run|variant)/.test(run))
      .map((run) => run.match(/smoke-linux\.sh (run|variant \S+)/)[1]),
    ["run", "variant dmabuf", "variant no-dbus", "variant webgl", "variant tray"],
  );
  const check = jobs["linux-app"].steps.find((step) => step.name === "Check scripts");
  assert.match(check.run, /^shellcheck .*scripts\/ci\/smoke-linux\.sh/);
});

// The AppImage must carry the emulator the build compiled: linuxdeploy's rewrite breaks it.
test("test build: every Linux leg checks the AppImage emulator after the build", () => {
  const steps = parse(testBuild()).jobs["linux-app"].steps;
  const names = steps.map((step) => step.name);
  const check = steps.find((step) => step.name === "Check the AppImage emulator");
  assert.ok(check, "the emulator check step is missing");
  assert.ok(names.indexOf("Build app") >= 0, "the Build app step is missing");
  assert.ok(names.indexOf(check.name) > names.indexOf("Build app"));
  assert.ok(names.indexOf(check.name) < names.indexOf("Upload AppImage"));
  assert.equal(check.if, undefined);
  assert.match(check.run, /--appimage-extract/);
  assert.match(check.run, /sha256sum <"\$emulator"\) == \$\(sha256sum <"\$built"\)/);
  assert.match(check.run, /timeout 10 "\.\/\$emulator" <\/dev\/null/);
  // The step fails unless all three results and the file list hold.
  assert.match(
    check.run,
    /\[\[ \$files_ok == true && \$same == true && \$rc -eq 0 && \$stdout_bytes -eq 0 \]\]\s*$/,
  );
});

test("test build: the policy rejects a missing platform gate, input, runner or need", () => {
  const cases = [
    [testBuild().replace("inputs.platform == 'linux'", "true"), /linux-app: if must run/],
    [testBuild().replace("default: all", "default: linux"), /platform input must be a choice/],
    [testBuild().replace("          - windows\n", ""), /platform input must be a choice/],
    [
      testBuild().replace("runner: ubuntu-22.04", "runner: ubuntu-24.04"),
      /linux-app: the matrix must run on ubuntu-22.04 and ubuntu-24.04-arm/,
    ],
    [
      testBuild().replace(
        "          - arch: arm64\n            runner: ubuntu-24.04-arm\n            bundles: deb,rpm,appimage\n",
        "",
      ),
      /matrix must run on/,
    ],
    [testBuild().replace("runner: ubuntu-24.04-arm", "runner: self-hosted"), /matrix must run on/],
    [testBuild().replace("${{ matrix.runner }}", "ubuntu-22.04"), /matrix must run on/],
    [
      testBuild().replace(/(linux-install:[\s\S]*?needs: )linux-app/, "$1macos-app"),
      /linux-install: needs must be linux-app/,
    ],
    [
      testBuild().replace("needs: linux-install", "needs: linux-app"),
      /linux-resources: needs must be linux-install/,
    ],
    [
      testBuild().replace(/(linux-smoke:[\s\S]*?needs: )linux-app/, "$1linux-install"),
      /linux-smoke: needs must be linux-app/,
    ],
    // An install leg off the build runners, or no install leg on one of them.
    [
      testBuild().replace(
        /runner: ubuntu-24\.04-arm(?![\s\S]*runner: ubuntu-24\.04-arm)/,
        "runner: ubuntu-24.04",
      ),
      /linux-install: the matrix must run on/,
    ],
    [
      testBuild().replace(/linux-install:[\s\S]*/, (install) =>
        install.replaceAll("runner: ubuntu-24.04-arm", "runner: ubuntu-22.04"),
      ),
      /linux-install: the matrix must run on/,
    ],
    [
      testBuild().replace(/(linux-resources:[\s\S]*?if: )inputs\.platform == 'all' \|\| /, "$1"),
      /linux-resources: if must run/,
    ],
    [
      testBuild().replace(/(linux-smoke:[\s\S]*?if: )inputs\.platform == 'all' \|\| /, "$1"),
      /linux-smoke: if must run/,
    ],
  ];
  for (const [fixture, error] of cases)
    assert.match(workflowPolicy(fixture, testBuildFile).join("\n"), error);
});

// The export regeneration: dispatched by hand, read-only, and each `exports` option names the script
// whose own --queued-export it runs.
const regenerateExportsFile = "regenerate-exports.yml";
const regenerateExports = () =>
  fs.readFileSync(path.join(directory, regenerateExportsFile), "utf8");

test("export regeneration: each option runs its script's own queued export, read-only", () => {
  const workflow = parse(regenerateExports());
  // Nightly and by hand; a scheduled run has no inputs, so it does all, and says so in its name.
  assert.deepEqual(Object.keys(workflow.on), ["schedule", "workflow_dispatch"]);
  assert.equal(workflow["run-name"], "Regenerate exports (${{ inputs.exports || 'all' }})");
  assert.equal(
    workflow.concurrency.group,
    "${{ github.workflow }}-${{ github.ref }}-${{ github.event_name }}-${{ inputs.exports || 'all' }}",
  );
  const { exports } = workflow.on.workflow_dispatch.inputs;
  assert.equal(exports.type, "choice");
  assert.equal(exports.default, "all");
  const scripts = fileURLToPath(new URL(".", import.meta.url));
  for (const name of exports.options.filter((option) => option !== "all")) {
    const script = path.join(scripts, `generate-${name}.mjs`);
    assert.ok(fs.existsSync(script), `${name}: scripts/generate-${name}.mjs`);
    assert.ok(fs.readFileSync(script, "utf8").includes('"--queued-export"'), `${name} queued path`);
  }
  const { steps, permissions } = workflow.jobs.regenerate;
  assert.deepEqual(permissions, { contents: "read" });
  const run = steps.find((step) => step.name === "Run the exports");
  assert.deepEqual(run.env, { EXPORTS: "${{ inputs.exports || 'all' }}" });
  assert.ok(run.run.includes(`set -- ${exports.options.slice(1).join(" ")}\n`), "all runs each");
  assert.ok(run.run.includes('node "scripts/generate-$name.mjs" --queued-export'));
  assert.ok(run.run.trimEnd().endsWith("pnpm gen:docs"));
  const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(upload.if, "steps.collect.outputs.changed != '0'");
  assert.equal(upload.with.name, "generated-exports");
  assert.equal(upload.with["retention-days"], 7);
  assert.equal(upload.with["include-hidden-files"], true);
  // The manifest is uploaded after every collect, an empty list included.
  const manifest = steps.find((step) => step.with?.name === "exports-manifest");
  assert.equal(manifest.if, undefined);
  assert.equal(manifest.with.path, "${{ runner.temp }}/exports-manifest/exports-manifest.json");
  assert.equal(manifest.with["retention-days"], 7);
  const collect = steps.find((step) => step.id === "collect").run;
  assert.ok(collect.includes('"$list" "$manifest/exports-manifest.json"'), "manifest written");
  // No strict mode anywhere in the refresh run: the build script's write mode would inherit it.
  assert.ok(!regenerateExports().includes("CS_STRICT_EXPORTS"));
  // rust-cache keys on the env, so it restores the Linux app job's cache only with the same env.
  const linuxApp = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8")).jobs[
    "rust-linux-app"
  ];
  assert.deepEqual(workflow.jobs.regenerate.env, linuxApp.env);
  const cacheKey = (job) =>
    job.steps.find((step) => step.uses?.startsWith("Swatinem/rust-cache@")).with["shared-key"];
  assert.equal(cacheKey(workflow.jobs.regenerate), cacheKey(linuxApp));
});

test("export regeneration: the policy rejects another trigger, a write, a changed input or an expression in run", () => {
  const cases = [
    [
      regenerateExports().replace("on:\n", "on:\n  pull_request:\n"),
      /export regeneration allows only schedule and workflow_dispatch/,
    ],
    [
      regenerateExports().replace("on:\n", "on:\n  push:\n    branches: [main]\n"),
      /export regeneration allows only schedule and workflow_dispatch/,
    ],
    [
      regenerateExports().replace("      contents: read", "      contents: write"),
      /regenerate: permissions must grant exactly contents: read/,
    ],
    [
      regenerateExports().replace(
        "      contents: read",
        "      contents: read\n      pull-requests: write",
      ),
      /regenerate: permissions must grant exactly contents: read/,
    ],
    [
      regenerateExports().replace("          - model-schemas\n", ""),
      /the only input must be exports, a choice of/,
    ],
    [
      regenerateExports().replace("        default: all", "        default: model-schemas"),
      /the only input must be exports/,
    ],
    [
      regenerateExports().replace("        type: choice", "        type: string"),
      /the only input must be exports/,
    ],
    [
      regenerateExports().replace(
        "    inputs:\n",
        "    inputs:\n      ref:\n        type: string\n",
      ),
      /the only input must be exports/,
    ],
    [
      regenerateExports().replace(
        'if [ "$EXPORTS" = all ]',
        "if [ '${{ inputs.exports }}' = all ]",
      ),
      /regenerate: step "Run the exports" expands an expression in run; pass it through env/,
    ],
    [
      regenerateExports().replace(
        "run-name: Regenerate exports (${{ inputs.exports || 'all' }})",
        "run-name: Regenerate exports (${{ inputs.exports }})",
      ),
      /export regeneration: run-name must be Regenerate exports \(\$\{\{ inputs\.exports \|\| 'all' \}\}\)/,
    ],
    [
      regenerateExports().replace("-${{ github.event_name }}", ""),
      /export regeneration: the concurrency group must be/,
    ],
    [
      regenerateExports().replace(
        "EXPORTS: ${{ inputs.exports || 'all' }}",
        "EXPORTS: ${{ inputs.exports }}",
      ),
      /regenerate: step "Run the exports" must read the exports input as \$\{\{ inputs\.exports \|\| 'all' \}\}/,
    ],
    // The refresh run sets no strict mode: its build script's write mode would inherit it.
    [
      regenerateExports().replace(
        "      CARGO_INCREMENTAL:",
        '      CS_STRICT_EXPORTS: "1"\n      CARGO_INCREMENTAL:',
      ),
      /CS_STRICT_EXPORTS may be set only in the env of exports-guard\.yml's/,
    ],
    [
      regenerateExports().replace(
        "          EXPORTS: ${{ inputs.exports || 'all' }}",
        "          EXPORTS: ${{ inputs.exports || 'all' }}\n          CS_STRICT_EXPORTS: \"1\"",
      ),
      /CS_STRICT_EXPORTS may be set only/,
    ],
    [
      regenerateExports().replace(
        "          pnpm gen:docs\n",
        "          CS_STRICT_EXPORTS=1 pnpm gen:docs\n",
      ),
      /CS_STRICT_EXPORTS may be set only/,
    ],
  ];
  for (const [fixture, error] of cases)
    assert.match(workflowPolicy(fixture, regenerateExportsFile).join("\n"), error);
  // The rules are this file's: another dispatch-only workflow keeps the general allowlist.
  const expanded = regenerateExports()
    .replace('"$EXPORTS"', "'${{ inputs.exports }}'")
    .replace(/ {2}schedule:\n {4}- cron: .*\n/, "");
  assert.deepEqual(workflowPolicy(expanded, "other.yml"), []);
  assert.match(
    workflowPolicy(regenerateExports(), "other.yml").join("\n"),
    /triggers must match the workflow allowlist/,
  );
  assert.deepEqual(workflowPolicy(regenerateExports(), regenerateExportsFile), []);
});

// The packaging smoke's containers come from one list, each pinned by its image index digest.
const smokeImages = fileURLToPath(new URL("ci/smoke-images.txt", import.meta.url));

test("smoke images: every container is pinned by digest", () => {
  assert.deepEqual(smokeImagesPolicy(fs.readFileSync(smokeImages, "utf8")), []);
});

test("smoke images: the policy rejects a bare tag, a short digest, a duplicate or no image", () => {
  const pin = `@sha256:${"a".repeat(64)}`;
  const cases = [
    ["ubuntu:24.04\n", /ubuntu:24\.04: must be <name>:<tag>@sha256:<digest>/],
    [`ubuntu${pin}\n`, /must be <name>:<tag>@sha256/],
    ["ubuntu:24.04@sha256:abc\n", /must be <name>:<tag>@sha256/],
    [`ubuntu:24.04${pin}\nubuntu:24.04${pin}\n`, /ubuntu:24\.04: listed twice/],
    ["# a comment\n\n", /no images/],
  ];
  for (const [fixture, error] of cases) assert.match(smokeImagesPolicy(fixture).join("\n"), error);
  assert.deepEqual(smokeImagesPolicy(`# a comment\n\nubuntu:24.04${pin}\n`), []);
});

// Linux compiles the code a platform without git-ai and the agent-CLI sockets builds (the
// facades' off arms, with the gated parts left out); the Linux app job runs the git-ai facade's
// tests, with the rest of the app's.
test("rust.yml checks the app with git-ai and agent-cli-sockets off", () => {
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  const steps = workflow.jobs["rust-check-linux"].steps;
  const off = steps.filter((step) => step.env?.CODESENSE_CAPS_OFF !== undefined);
  assert.equal(off.length, 1, "one cap-off check step");
  assert.equal(off[0].name, "Check the desktop app with git-ai and agent-cli-sockets off");
  assert.equal(off[0].env.CODESENSE_CAPS_OFF, "git-ai,agent-cli-sockets");
  assert.equal(
    off[0].run,
    "cargo check --locked -p codesense --lib --tests --features dashboard-publish",
  );
});

const exportsGuardFile = "exports-guard.yml";
const exportsGuard = () => fs.readFileSync(path.join(directory, exportsGuardFile), "utf8");
const GUARD_BASE = "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}";

test("exports guard: the guard runs the base's script with the token, strict-pins runs PR code without one", () => {
  const workflow = parse(exportsGuard());
  assert.deepEqual(workflow.on.pull_request.types, [
    "opened",
    "synchronize",
    "reopened",
    "edited",
    "labeled",
    "unlabeled",
  ]);
  assert.ok(Object.hasOwn(workflow.on, "merge_group"));
  assert.deepEqual(workflow.concurrency, {
    group: "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
  });
  const { guard, "strict-pins": strict } = workflow.jobs;
  assert.deepEqual(Object.keys(workflow.jobs), ["guard", "strict-pins"]);
  assert.deepEqual(guard.permissions, { contents: "read", "pull-requests": "read" });
  assert.equal(guard.steps[0].with.ref, GUARD_BASE);
  // Plain node from the base checkout: no install, so no pull request code or package runs.
  assert.deepEqual(
    guard.steps.filter((step) => step.run).map((step) => step.run),
    ["node scripts/exports-guard.mjs"],
  );
  const check = guard.steps.find((step) => step.run);
  assert.deepEqual(check.env, { GH_TOKEN: "${{ github.token }}" });
  assert.equal(guard.outputs.refresh, `\${{ steps.${check.id}.outputs.refresh }}`);

  assert.equal(strict.needs, "guard");
  assert.equal(
    strict.if,
    "github.event_name != 'pull_request' || needs.guard.outputs.refresh == 'true'",
  );
  assert.deepEqual(strict.permissions, { contents: "read" });
  assert.ok(!JSON.stringify(strict).includes("token"), "no token in strict-pins");
  // Every step is skipped in a merge group, and the checkout is the pull request head.
  for (const step of strict.steps)
    assert.equal(step.if, "github.event_name == 'pull_request'", step.name);
  assert.equal(strict.steps[0].with.ref, "${{ github.event.pull_request.head.sha }}");
  assert.equal(strict.steps[0].with["persist-credentials"], false);
  const named = (name) => strict.steps.find((step) => step.name === name);
  assert.deepEqual(named("Strict gen:docs check").env, { CS_STRICT_EXPORTS: "1" });
  assert.equal(named("Strict gen:docs check").run, "pnpm gen:docs:check");
  assert.deepEqual(named("Strict Rust pins").env, { CS_STRICT_EXPORTS: "1" });
  assert.match(named("Strict Rust pins").run, /^cargo test /);
  assert.ok(!named("Strict Rust pins").run.includes("--queued-export"));
  assert.ok(!named("Strict Rust pins").run.includes("UPDATE_DOCS_SCHEMAS"));
  // The setup restores rust.yml's Linux app cache, as the refresh run does.
  const linuxApp = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8")).jobs[
    "rust-linux-app"
  ];
  assert.deepEqual(strict.env, linuxApp.env);
});

test("exports guard: the policy pins the base checkout, the token, the names and no expression in run", () => {
  const cases = [
    [
      exportsGuard().replace(
        `ref: ${GUARD_BASE}`,
        "ref: ${{ github.event.pull_request.head.sha }}",
      ),
      /guard: checkout must check out ref/,
    ],
    [
      exportsGuard().replace(`          ref: ${GUARD_BASE}\n`, ""),
      /guard: checkout must check out ref/,
    ],
    [
      exportsGuard().replace("      pull-requests: read", "      pull-requests: write"),
      /guard: permissions must grant exactly contents: read, pull-requests: read/,
    ],
    [
      exportsGuard().replace(
        "    permissions:\n      contents: read\n    defaults:",
        "    permissions:\n      contents: read\n      pull-requests: read\n    defaults:",
      ),
      /strict-pins: permissions must grant exactly contents: read/,
    ],
    [
      exportsGuard().replace(
        "run: node scripts/exports-guard.mjs",
        "run: node scripts/exports-guard.mjs ${{ github.head_ref }}",
      ),
      /guard: step "Check the changed files" expands an expression in run/,
    ],
    [
      exportsGuard().replace("    name: Exports guard\n", "    name: Guard\n"),
      /guard: name must be Exports guard/,
    ],
    [
      exportsGuard().replace("    name: Exports strict pins\n", "    name: Strict pins\n"),
      /strict-pins: name must be Exports strict pins/,
    ],
    [
      exportsGuard().replace(
        "    if: github.event_name != 'pull_request' || needs.guard.outputs.refresh == 'true'",
        "    if: needs.guard.outputs.refresh == 'true'",
      ),
      /strict-pins: if must begin with github.event_name != 'pull_request' \|\|/,
    ],
  ];
  for (const [fixture, error] of cases)
    assert.match(workflowPolicy(fixture, exportsGuardFile).join("\n"), error);
  assert.deepEqual(workflowPolicy(exportsGuard(), exportsGuardFile), []);
});

test("exports guard: the guard step skips only a merge group whose base lacks the script", () => {
  const exact =
    "        if: github.event_name == 'pull_request' || hashFiles('scripts/exports-guard.mjs') != ''\n";
  assert.ok(exportsGuard().includes(exact));
  assert.deepEqual(workflowPolicy(exportsGuard(), exportsGuardFile), []);
  const step = parse(exportsGuard()).jobs.guard.steps.find(
    (s) => s.name === "Check the changed files",
  );
  assert.equal(step.run, "node scripts/exports-guard.mjs");
  for (const [name, condition] of [
    ["no pull_request clause", "hashFiles('scripts/exports-guard.mjs') != ''"],
    ["no hashFiles clause", "github.event_name == 'pull_request'"],
    [
      "all merge groups",
      "github.event_name == 'pull_request' || github.event_name == 'merge_group'",
    ],
    [
      "another condition",
      "github.event_name == 'pull_request' || hashFiles('scripts/exports-guard.mjs') != '' || always()",
    ],
    [
      "another condition, and-ed",
      "(github.event_name == 'pull_request' || hashFiles('scripts/exports-guard.mjs') != '') && github.actor != 'x'",
    ],
    ["another file", "github.event_name == 'pull_request' || hashFiles('scripts/other.mjs') != ''"],
    [
      "wrapped",
      "${{ github.event_name == 'pull_request' || hashFiles('scripts/exports-guard.mjs') != '' }}",
    ],
  ])
    assert.match(
      workflowPolicy(
        exportsGuard().replace(exact, `        if: "${condition}"\n`),
        exportsGuardFile,
      ).join("\n"),
      /guard: step "Check the changed files" must be one step with if:/,
      name,
    );
  // No if at all, or a second step under the name, fails too.
  for (const [name, fixture] of [
    ["no if", exportsGuard().replace(exact, "")],
    [
      "second step",
      exportsGuard().replace(
        "      - name: Check the changed files\n",
        "      - name: Check the changed files\n        run: true\n      - name: Check the changed files\n",
      ),
    ],
  ])
    assert.match(
      workflowPolicy(fixture, exportsGuardFile).join("\n"),
      /guard: step "Check the changed files" must be one step with if:/,
      name,
    );
  // The job itself stays unconditional.
  assert.equal(parse(exportsGuard()).jobs.guard.if, undefined);
});

test("exports guard: CS_STRICT_EXPORTS is set only on the two strict steps, and on both", () => {
  const strictEnv =
    '        env:\n          CS_STRICT_EXPORTS: "1"\n        run: pnpm gen:docs:check\n';
  const rustEnv = '        env:\n          CS_STRICT_EXPORTS: "1"\n        run: >-\n';
  assert.ok(exportsGuard().includes(strictEnv) && exportsGuard().includes(rustEnv));
  const cases = [
    // Job-wide or workflow-wide.
    exportsGuard().replace(
      "      CARGO_TERM_COLOR: always\n    steps:\n      - name: Check out the pull request head",
      '      CARGO_TERM_COLOR: always\n      CS_STRICT_EXPORTS: "1"\n    steps:\n      - name: Check out the pull request head',
    ),
    exportsGuard().replace(
      "permissions: {}\n",
      'permissions: {}\nenv:\n  CS_STRICT_EXPORTS: "1"\n',
    ),
    // On another step.
    exportsGuard().replace(
      "        run: bash scripts/build-session-server.sh\n",
      '        env:\n          CS_STRICT_EXPORTS: "1"\n        run: bash scripts/build-session-server.sh\n',
    ),
    exportsGuard().replace(
      "        run: pnpm install --frozen-lockfile\n",
      "        run: CS_STRICT_EXPORTS=1 pnpm install --frozen-lockfile\n",
    ),
    // Either strict step without it.
    exportsGuard().replace(strictEnv, "        run: pnpm gen:docs:check\n"),
    exportsGuard().replace(rustEnv, "        run: >-\n"),
    // Either strict step with another value.
    exportsGuard().replace(strictEnv, strictEnv.replace('"1"', '"0"')),
    // A second step under a strict step's name.
    exportsGuard().replace(
      "      - name: Strict gen:docs check\n",
      "      - name: Strict gen:docs check\n        if: github.event_name == 'pull_request'\n" +
        strictEnv +
        "      - name: Strict gen:docs check\n",
    ),
  ];
  for (const fixture of cases)
    assert.match(
      workflowPolicy(fixture, exportsGuardFile).join("\n"),
      /CS_STRICT_EXPORTS/,
      fixture,
    );
  // Any other workflow, at any level.
  assert.match(
    workflowPolicy(
      good.replace(
        "    timeout-minutes: 15\n",
        '    timeout-minutes: 15\n    env:\n      CS_STRICT_EXPORTS: "1"\n',
      ),
    ).join("\n"),
    /CS_STRICT_EXPORTS may be set only/,
  );
  assert.match(
    workflowPolicy(exportsGuard(), "ci.yml").join("\n"),
    /CS_STRICT_EXPORTS may be set only/,
  );
});

test("exports guard: no other job may report a check named Exports guard or Exports strict pins", () => {
  const named = (name) =>
    good.replace("    runs-on: ubuntu-24.04\n", `    name: ${name}\n    runs-on: ubuntu-24.04\n`);
  for (const name of [
    "Exports guard",
    "exports STRICT pins",
    "\"${{ 'Exports guard' }}\"",
    "Exports ${{ matrix.x }}",
    '"${{ matrix.x }} strict pins"',
    "Exports guard${{ matrix.unclosed",
  ])
    assert.match(
      workflowPolicy(named(name), "ci.yml").join("\n"),
      /static: the job name could report Exports (guard|strict pins), a check only exports-guard\.yml reports/,
      name,
    );
  for (const name of [
    "Rust (macOS arm64) tests ${{ matrix.shard }}/3",
    "Exports guard tests",
    "Static checks",
  ])
    assert.deepEqual(workflowPolicy(named(name), "ci.yml"), [], name);
  // Inside the guard's workflow, only its own job reports each name.
  const extra = exportsGuard().replace(
    "jobs:\n",
    "jobs:\n  shadow:\n    name: Exports ${{ 'strict pins' }}\n    runs-on: ubuntu-24.04\n    permissions:\n      contents: read\n    timeout-minutes: 5\n    steps:\n      - run: true\n",
  );
  assert.match(
    workflowPolicy(extra, exportsGuardFile).join("\n"),
    /shadow: the job name could report Exports strict pins/,
  );
  for (const file of files)
    if (file !== exportsGuardFile)
      for (const job of Object.values(
        parse(fs.readFileSync(path.join(directory, file), "utf8")).jobs,
      ))
        assert.ok(!/^Exports (guard|strict pins)$/i.test(job.name ?? ""), file);
});
