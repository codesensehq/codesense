// SPDX-License-Identifier: MIT
// node --test scripts/workflow-policy.node-test.mjs (the repository's public workflows)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { workflowPolicy } from "./workflow-policy.mjs";

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

// main moves only through the merge queue: rust.yml runs on pull requests, merge groups, a
// nightly schedule and by hand, never on push. The nightly run on main saves its caches and tracks
// flaky tests; macOS, which skips only pull requests, always runs on merge groups and nightly.
test("rust.yml runs nightly instead of on push, and only the nightly run saves or tracks", () => {
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  assert.deepEqual(Object.keys(workflow.on), [
    "pull_request",
    "merge_group",
    "schedule",
    "workflow_dispatch",
  ]);
  assert.deepEqual(workflow.on.schedule, [{ cron: "17 6 * * *" }]);
  assert.ok(workflow.jobs["rust-macos"].if.startsWith("github.event_name != 'pull_request' ||"));
  const nightly = "github.event_name == 'schedule' && github.ref == 'refs/heads/main'";
  for (const name of ["rust-macos", "rust-linux"]) {
    const steps = workflow.jobs[name].steps;
    const saves = steps.filter((step) => step.uses?.startsWith("actions/cache/save@"));
    assert.equal(saves.length, 1, name);
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
  assert.equal(workflow.jobs["rust-macos"].if, macosOptIn);
  // Another label's run has a group of its own, so it cannot cancel the pull request's run.
  assert.equal(
    workflow.concurrency.group,
    "${{ github.workflow }}-${{ github.event.pull_request.number || github.sha }}${{ github.event.action == 'labeled' && github.event.label.name != 'ci:macos' && format('-{0}', github.run_id) || '' }}",
  );
  assert.equal(workflow.jobs["rust-linux"].if, undefined);
});

test("pull-requests read is limited to the DCO job", () => {
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
  test(`${trigger} is confined to scorecard.yml${trigger === "schedule" ? " and rust.yml" : ""}`, () => {
    const fixture = scorecard.replace("workflow_dispatch", trigger);
    assert.deepEqual(workflowPolicy(fixture, "scorecard.yml"), []);
    assert.match(workflowPolicy(fixture, "ci.yml").join("\n"), /triggers/);
    assert.equal(
      /triggers/.test(workflowPolicy(fixture, "rust.yml").join("\n")),
      trigger !== "schedule",
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
  const portable = ["codesense-host-proto", "codesense-fs-core"];
  for (const [name, expected] of [
    [
      "rust-macos",
      [
        ...portable,
        "codesense-pty-core",
        "codesense-session-server",
        "codesense-guards",
        "codesense",
      ],
    ],
    ["rust-linux", portable],
  ]) {
    const job = workflow.jobs[name];
    assert.deepEqual(packages(job.env.RUST_PACKAGES), [...expected].sort());
    const steps = job.steps;
    const runs = steps.filter((step) => step.run?.includes("cargo nextest run"));
    assert.equal(runs.length, 2, "compile and run both use nextest");
    for (const step of runs) {
      assert.match(step.run, /--profile ci/);
      assert.match(step.run, /\$RUST_PACKAGES/);
      assert.deepEqual(packages(step.run), []);
    }
    assert.ok(runs.some((step) => step.run.includes("--no-run")));
    assert.ok(runs.some((step) => !step.run.includes("--no-run")));
    const docs = steps.find((step) => step.run?.includes("cargo test --doc"));
    assert.match(docs.run, /\$RUST_PACKAGES/);
    assert.deepEqual(packages(docs.run), []);
    assert.equal(docs["timeout-minutes"], 15);
    // Doctests run after failed tests, but only once the test build ran and succeeded.
    assert.equal(docs.if, "(success() || failure()) && steps.compile.outcome == 'success'");
    assert.ok(runs.some((step) => step.id === "compile" && step.run.includes("--no-run")));
    assert.ok(steps.some((step) => step.run?.includes("--tool cargo-nextest")));
    const junit = steps.find((step) => step.with?.path === "target/nextest/ci/junit.xml");
    assert.equal(junit.if, "always()");
    assert.equal(junit.uses, "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9");
  }
});

const flakyIssues = good
  .replace(
    "on: [pull_request, workflow_dispatch]",
    "on:\n  pull_request:\n  push:\n    branches: [main]",
  )
  .replace(
    "  static:\n",
    "  flaky-issues:\n    if: ${{ !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' && !github.event.repository.fork }}\n",
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
test("Rust test jobs list flaky tests after nextest and only flaky-issues writes issues", () => {
  const workflow = parse(fs.readFileSync(path.join(directory, "rust.yml"), "utf8"));
  for (const name of ["rust-macos", "rust-linux"]) {
    const job = workflow.jobs[name];
    assert.deepEqual(job.permissions, { contents: "read" });
    const steps = job.steps;
    const test = steps.findIndex(
      (step) => step.run?.includes("cargo nextest run") && !step.run.includes("--no-run"),
    );
    const flaky = steps[test + 1];
    assert.equal(flaky.run, "node scripts/flaky-tests.mjs summary target/nextest/ci/junit.xml");
    assert.equal(flaky.if, "(success() || failure()) && steps.compile.outcome == 'success'");
  }
  const issues = workflow.jobs["flaky-issues"];
  assert.deepEqual([...issues.needs].sort(), ["rust-linux", "rust-macos"]);
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
  for (const name of ["rust-macos", "rust-linux"]) {
    const uploads = workflow.jobs[name].steps.filter((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    const junit = uploads.filter((step) => step.with.path === "target/nextest/ci/junit.xml");
    assert.equal(junit.length, 1, name);
    assert.match(junit[0].with.name, glob, name);
    for (const step of uploads.filter((step) => step !== junit[0]))
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
