// SPDX-License-Identifier: MIT
// Shared policy for public workflows, parsed as YAML rather than matched by indentation.
import { parseDocument, isMap, isScalar, visit } from "yaml";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A job may take its runner from its matrix: `runs-on: ${{ matrix.runner }}` stands for the
// `runner` of every `include` entry, each a literal label the caller checks. Null unless the
// matrix is only an `include` list: a base axis (`runner: [self-hosted]`) would add legs too.
const matrixRunners = (job) => {
  const match = /^\$\{\{\s*matrix\.(\w+)\s*\}\}$/.exec(job?.["runs-on"] ?? "");
  const matrix = job?.strategy?.matrix;
  if (!match || Object.keys(matrix ?? {}).join() !== "include") return null;
  return Array.isArray(matrix.include) ? matrix.include.map((entry) => entry?.[match[1]]) : null;
};

const HOSTED_RUNNERS = new Set([
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
]);

// Exact grants are scoped by file and job; each exception also needs its own constraints.
const SCORECARD = { file: "scorecard.yml", job: "scorecard" };
const FLAKY_ISSUES = { file: "rust.yml", job: "flaky-issues" };
// Deletes the nightly's superseded macOS build caches, the only job that may write actions.
const CACHE_PRUNE = { file: "rust.yml", job: "rust-macos-cache-prune" };
// The nightly tile, pane harness, perf and load lanes run on a schedule or by hand, never on a pull
// request or merge group, so none of them can be a required check. Its issue job alone writes:
// one issue for a red scheduled night on main.
const NIGHTLY = {
  file: "nightly.yml",
  job: "nightly-issue",
  triggers: ["schedule", "workflow_dispatch"],
};
// The jobs that write something, and so run only on main outside requests (below).
export const MAIN_WRITERS = [FLAKY_ISSUES, CACHE_PRUNE, NIGHTLY];
// The commit email audit runs nightly and on main, never on pull requests.
const COMMIT_EMAILS = {
  file: "commit-emails.yml",
  job: "commit-emails",
  triggers: ["push", "schedule", "workflow_dispatch"],
};
// The test build is dispatched by hand: its `platform` input picks which job runs, and each
// job names the platform it builds. Its x86_64 leg runs on the oldest hosted Linux runner, so
// the bundle links an older glibc; the arm64 leg runs on ubuntu-24.04-arm, so 24.04 is its floor.
// After the Linux build, each package installs in its own clean container on its build's runner,
// one leg per package and image; the deb and rpm listings are then compared, and the x86_64
// AppImage launches beside the installs.
const TEST_BUILD = {
  file: "test-build.yml",
  platforms: ["all", "macos", "windows", "linux"],
  jobs: {
    "macos-app": "macos",
    "linux-app": "linux",
    "linux-install": "linux",
    "linux-resources": "linux",
    "linux-smoke": "linux",
  },
  linuxJobs: ["linux-app"],
  linuxRunners: ["ubuntu-22.04", "ubuntu-24.04-arm"],
  install: "linux-install",
  needs: {
    "linux-install": "linux-app",
    "linux-resources": "linux-install",
    "linux-smoke": "linux-app",
  },
};
// The export regeneration runs nightly or by hand and only reads the repository: whoever ran it
// commits its artifact. Its `exports` input names scripts/generate-<name>.mjs (or all), and reaches
// the run script through env, so no run script expands an expression. A scheduled run has no
// inputs, so every use of the input falls back to all, and the run name says which exports ran.
const ALL_EXPORTS = "${{ inputs.exports || 'all' }}";
const REGENERATE_EXPORTS = {
  file: "regenerate-exports.yml",
  triggers: ["schedule", "workflow_dispatch"],
  exports: ["all", "model-schemas", "live-data-contract", "mcp-reference"],
  input: ALL_EXPORTS,
  runName: `Regenerate exports (${ALL_EXPORTS})`,
  group: `\${{ github.workflow }}-\${{ github.ref }}-\${{ github.event_name }}-${ALL_EXPORTS}`,
};
// The exports guard keeps cargo-written exports out of pull requests. Its guard job holds the only
// token (pull-requests: read), so it checks out the base commit and runs no pull request code. Only
// the strict-pins job's two strict steps set CS_STRICT_EXPORTS: the build script's write mode
// inherits it, so anywhere else it would fail a refresh's own export on a stale fixture. The two
// required checks are named only here, so no other job can report a same-named check.
const EXPORTS_GUARD = {
  file: "exports-guard.yml",
  job: "guard",
  baseRef: "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}",
  // The guard step runs on every pull request, and in a merge group whenever the base has the
  // script: the one skip is the merge group that lands the workflow, before main has the script.
  step: "Check the changed files",
  stepIf: "github.event_name == 'pull_request' || hashFiles('scripts/exports-guard.mjs') != ''",
  strictJob: "strict-pins",
  strictSteps: ["Strict gen:docs check", "Strict Rust pins"],
  checks: { guard: "Exports guard", "strict-pins": "Exports strict pins" },
};
const STRICT_EXPORTS = "CS_STRICT_EXPORTS";
// Whether a job name could render as `check`, each ${{ }} span standing for any text (and an
// unclosed one for the rest). Case is ignored, to be safe.
const couldRender = (name, check) => {
  const literal = String(name)
    .split(/\$\{\{[\s\S]*?(?:\}\}|$)/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${literal.join("[\\s\\S]*")}$`, "i").test(check);
};
const JOB_PERMISSIONS = new Map([
  [`${COMMIT_EMAILS.file}:${COMMIT_EMAILS.job}`, { contents: "read" }],
  ["dco.yml:dco", { contents: "read", "pull-requests": "read" }],
  [`${EXPORTS_GUARD.file}:${EXPORTS_GUARD.job}`, { contents: "read", "pull-requests": "read" }],
  ["quarantine.yml:quarantine-issues", { contents: "read", issues: "read" }],
  [`${FLAKY_ISSUES.file}:${FLAKY_ISSUES.job}`, { contents: "read", issues: "write" }],
  [`${NIGHTLY.file}:${NIGHTLY.job}`, { contents: "read", issues: "write" }],
  [`${CACHE_PRUNE.file}:${CACHE_PRUNE.job}`, { actions: "write" }],
  [
    `${SCORECARD.file}:${SCORECARD.job}`,
    { contents: "read", "security-events": "write", "id-token": "write" },
  ],
]);
// A merge group is a temporary ref: caches it saved would only evict main's. setup-node saves
// its cache in a post step, so on a merge_group workflow it may cache only off merge groups.
const SETUP_NODE_CACHE = "${{ github.event_name != 'merge_group' && 'pnpm' || '' }}";
const PUSH_ONLY = "github.event_name == 'push'";
const SCHEDULED = "github.event_name == 'schedule'";
const ON_MAIN = "github.ref == 'refs/heads/main'";
// The nightly Rust run on main saves its caches and tracks flaky tests, since main moves
// only through the merge queue.
const NIGHTLY_FILE = "rust.yml";
// A cache save, or the flaky-issues job, runs only for a push or a scheduled run on main.
const onMainOutsideRequests = (terms) =>
  (terms.includes(PUSH_ONLY) || terms.includes(SCHEDULED)) && terms.includes(ON_MAIN);
const MAIN_ONLY = `${PUSH_ONLY} or ${SCHEDULED}, and ${ON_MAIN},`;
// A job in a workflow that runs on merge_group, push or schedule may be conditional only on
// pull requests: a merge group must report every required check, and main and the nightly runs
// must test everything. A pull request may skip a job (rust.yml's macOS job runs there only with
// the ci:macos label). GitHub reads || as the lowest-precedence operator, so an expression that
// begins with this term is true off pull requests whatever follows.
const OFF_PULL_REQUESTS = "github.event_name != 'pull_request' ||";
const NEVER_SKIPPED_ON = ["merge_group", "push", "schedule"];
// The one exception: rust.yml's test jobs also skip a change that touches nothing Rust can see,
// as its changes job decides. They lead with these terms, so they run when that job says
// anything but rust=false, failure included; what follows must still begin with OFF_PULL_REQUESTS.
const RUST_PATH_FILTER = {
  file: "rust.yml",
  job: "changes",
  jobs: [
    "rust-macos-build",
    "rust-macos",
    "rust-linux",
    "rust-check-linux",
    "rust-check-windows",
    "rust-linux-app",
    "windows-e2e-linux",
  ],
  terms: ["!cancelled()", "needs.changes.outputs.rust != 'false'"],
};
// And one more: rust.yml's non-required jobs skip merge groups (they run on push to main and
// nightly instead): the macOS build and the result job that reports it (the test shards run only
// after the build), the Windows check, the Linux app job and the two-window e2e job. Each may put
// exactly this term right after the path filter's (and the macOS filter's, below); what follows
// must still begin with OFF_PULL_REQUESTS, so push and schedule always run them.
const OFF_MERGE_GROUPS = {
  file: "rust.yml",
  jobs: [
    "rust-macos-build",
    "rust-macos",
    "rust-check-windows",
    "rust-linux-app",
    "windows-e2e-linux",
  ],
  term: "github.event_name != 'merge_group'",
};
// The macOS build and the result job that reports it may also skip a change that only Windows or
// Linux compiles, as the changes job decides: exactly this term, right after the path filter's.
const MACOS_PATH_FILTER = {
  file: "rust.yml",
  jobs: ["rust-macos-build", "rust-macos"],
  term: "needs.changes.outputs.macos != 'false'",
};
// The macOS test shards skip a push to main whose build found main had moved on (the newer push
// runs them, and the nightly covers every commit): exactly this condition, and nothing else.
const SUPERSEDED = {
  file: "rust.yml",
  job: "rust-macos-test",
  needs: "rust-macos-build",
  condition: "needs.rust-macos-build.outputs.superseded != 'true'",
};
// rust.yml's macOS result job may lead with always() in place of the path filter's !cancelled(),
// so a cancelled run reports red rather than skipped. Only that job: it runs no build or tests.
const RESULT_ALWAYS = { file: "rust.yml", job: "rust-macos", term: "always()" };
const SCORECARD_ACTIONS = new Set([
  "actions/checkout",
  "ossf/scorecard-action",
  "github/codeql-action/upload-sarif",
]);

// The terms joined by && outside parentheses and quotes, after unwrapping ${{ }} and redundant outer
// parentheses. A top-level || keeps the expression whole, so `a || b` or `!(b)` never counts as b.
export function topLevelConjuncts(expression) {
  let e = expression
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, "$1")
    .trim();
  for (;;) {
    const terms = [];
    let depth = 0;
    let quoted = false;
    let start = 0;
    let or = false;
    let wrapped = e.startsWith("(");
    for (let i = 0; i < e.length; i++) {
      const c = e[i];
      if (c === "'") quoted = !quoted;
      else if (quoted) continue;
      else if (c === "(") depth++;
      else if (c === ")") {
        if (--depth === 0 && i < e.length - 1) wrapped = false;
      } else if (depth > 0) continue;
      else if (e.startsWith("||", i)) or = true;
      else if (e.startsWith("&&", i)) {
        terms.push(e.slice(start, i));
        start = ++i + 1;
      }
    }
    if (wrapped) e = e.slice(1, -1).trim();
    else return or ? [e] : [...terms, e.slice(start)].map((term) => term.trim());
  }
}

export function workflowPolicy(text, file = "") {
  const errors = [];
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) return doc.errors.map((e) => `invalid YAML: ${e.message}`);
  const workflow = doc.toJS();
  const mapping = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!mapping(workflow)) return ["workflow must be a mapping"];
  if (!mapping(workflow.permissions) || Object.keys(workflow.permissions).length)
    errors.push("top-level permissions must be {}");

  const triggers =
    typeof workflow.on === "string"
      ? [workflow.on]
      : Array.isArray(workflow.on)
        ? workflow.on
        : Object.keys(workflow.on ?? {});
  const scorecardWorkflow = file === SCORECARD.file;
  const allowedTriggers = scorecardWorkflow
    ? ["push", "schedule", "branch_protection_rule", "workflow_dispatch"]
    : ["pull_request", "merge_group", "push", "workflow_dispatch"].concat(
        file === NIGHTLY_FILE ? ["schedule"] : [],
      );
  if (scorecardWorkflow && (Object.hasOwn(workflow, "env") || Object.hasOwn(workflow, "defaults")))
    errors.push("scorecard: workflow env and defaults are forbidden");
  // Kept apart from allowedTriggers, so each file's exception reads (and merges) on its own.
  const permittedTriggers =
    file === COMMIT_EMAILS.file
      ? COMMIT_EMAILS.triggers
      : file === REGENERATE_EXPORTS.file
        ? REGENERATE_EXPORTS.triggers
        : file === NIGHTLY.file
          ? NIGHTLY.triggers
          : allowedTriggers;
  if (!triggers.length || triggers.some((t) => !permittedTriggers.includes(t)))
    errors.push(
      "triggers must match the workflow allowlist; Scorecard and commit emails forbid pull requests, export regeneration allows only schedule and workflow_dispatch, as does nightly.yml",
    );
  if (triggers.includes("merge_group")) {
    const mergeGroup = mapping(workflow.on) ? workflow.on.merge_group : null;
    if (mergeGroup !== null && JSON.stringify(mergeGroup) !== '{"types":["checks_requested"]}')
      errors.push("merge_group takes no filter other than types: [checks_requested]");
  }
  if (triggers.includes("push")) {
    const push = mapping(workflow.on) ? workflow.on.push : null;
    if (
      !mapping(push) ||
      JSON.stringify(push.branches) !== '["main"]' ||
      push.tags ||
      push["tags-ignore"]
    )
      errors.push("push must target branches: [main] only");
  }
  if (
    !mapping(workflow.concurrency) ||
    ![true, "${{ github.event_name == 'pull_request' }}"].includes(
      workflow.concurrency["cancel-in-progress"],
    ) ||
    !workflow.concurrency.group
  )
    errors.push("concurrency must group and cancel superseded runs");
  if (!mapping(workflow.jobs) || !Object.keys(workflow.jobs).length)
    errors.push("workflow must define jobs");
  if (file === TEST_BUILD.file) {
    const platform = mapping(workflow.on) ? workflow.on.workflow_dispatch?.inputs?.platform : null;
    if (
      !mapping(platform) ||
      platform.type !== "choice" ||
      platform.default !== "all" ||
      JSON.stringify(platform.options) !== JSON.stringify(TEST_BUILD.platforms)
    )
      errors.push(
        `test build: the platform input must be a choice of ${TEST_BUILD.platforms.join(", ")} defaulting to all`,
      );
    for (const [name, os] of Object.entries(TEST_BUILD.jobs))
      if (workflow.jobs?.[name]?.if !== `inputs.platform == 'all' || inputs.platform == '${os}'`)
        errors.push(`${name}: if must run the job for platform all or ${os} only`);
    for (const name of TEST_BUILD.linuxJobs)
      if (
        JSON.stringify(matrixRunners(workflow.jobs?.[name])) !==
        JSON.stringify(TEST_BUILD.linuxRunners)
      )
        errors.push(`${name}: the matrix must run on ${TEST_BUILD.linuxRunners.join(" and ")}`);
    // Every install leg runs on a build's runner, and each build has a leg.
    const install = matrixRunners(workflow.jobs?.[TEST_BUILD.install]) ?? [];
    if (
      !install.every((runner) => TEST_BUILD.linuxRunners.includes(runner)) ||
      !TEST_BUILD.linuxRunners.every((runner) => install.includes(runner))
    )
      errors.push(
        `${TEST_BUILD.install}: the matrix must run on ${TEST_BUILD.linuxRunners.join(" and ")}`,
      );
    for (const [name, needs] of Object.entries(TEST_BUILD.needs))
      if (workflow.jobs?.[name]?.needs !== needs) errors.push(`${name}: needs must be ${needs}`);
  }
  if (file === REGENERATE_EXPORTS.file) {
    const inputs = mapping(workflow.on) ? workflow.on.workflow_dispatch?.inputs : null;
    const exports = mapping(inputs) ? inputs.exports : null;
    if (
      JSON.stringify(Object.keys(inputs ?? {})) !== '["exports"]' ||
      !mapping(exports) ||
      exports.type !== "choice" ||
      exports.default !== "all" ||
      JSON.stringify(exports.options) !== JSON.stringify(REGENERATE_EXPORTS.exports)
    )
      errors.push(
        `export regeneration: the only input must be exports, a choice of ${REGENERATE_EXPORTS.exports.join(", ")} defaulting to all`,
      );
    if (workflow["run-name"] !== REGENERATE_EXPORTS.runName)
      errors.push(`export regeneration: run-name must be ${REGENERATE_EXPORTS.runName}`);
    if (workflow.concurrency?.group !== REGENERATE_EXPORTS.group)
      errors.push(`export regeneration: the concurrency group must be ${REGENERATE_EXPORTS.group}`);
    for (const [name, job] of Object.entries(workflow.jobs ?? {}))
      for (const step of Array.isArray(job?.steps) ? job.steps : [])
        for (const value of Object.values(mapping(step?.env) ? step.env : {}))
          if (String(value).includes("inputs.exports") && value !== REGENERATE_EXPORTS.input)
            errors.push(
              `${name}: step "${step.name ?? step.run}" must read the exports input as ${REGENERATE_EXPORTS.input}`,
            );
  }
  if (file === REGENERATE_EXPORTS.file || file === EXPORTS_GUARD.file)
    for (const [name, job] of Object.entries(workflow.jobs ?? {}))
      for (const step of Array.isArray(job?.steps) ? job.steps : [])
        if (mapping(step) && String(step.run ?? "").includes("${{"))
          errors.push(
            `${name}: step "${step.name ?? step.run}" expands an expression in run; pass it through env`,
          );
  if (file === EXPORTS_GUARD.file) {
    const steps = workflow.jobs?.[EXPORTS_GUARD.job]?.steps;
    const checkouts = (Array.isArray(steps) ? steps : []).filter(
      (step) => mapping(step) && String(step.uses ?? "").startsWith("actions/checkout@"),
    );
    if (!checkouts.length || checkouts.some((step) => step.with?.ref !== EXPORTS_GUARD.baseRef))
      errors.push(`${EXPORTS_GUARD.job}: checkout must check out ref ${EXPORTS_GUARD.baseRef}`);
    const guardSteps = (Array.isArray(steps) ? steps : []).filter(
      (step) => mapping(step) && step.name === EXPORTS_GUARD.step,
    );
    if (guardSteps.length !== 1 || guardSteps[0].if !== EXPORTS_GUARD.stepIf)
      errors.push(
        `${EXPORTS_GUARD.job}: step "${EXPORTS_GUARD.step}" must be one step with if: ${EXPORTS_GUARD.stepIf}`,
      );
    for (const [job, check] of Object.entries(EXPORTS_GUARD.checks))
      if (workflow.jobs?.[job]?.name !== check) errors.push(`${job}: name must be ${check}`);
    const strictSteps = workflow.jobs?.[EXPORTS_GUARD.strictJob]?.steps;
    for (const stepName of EXPORTS_GUARD.strictSteps) {
      const named = (Array.isArray(strictSteps) ? strictSteps : []).filter(
        (candidate) => candidate?.name === stepName,
      );
      if (named.length !== 1 || named[0]?.env?.[STRICT_EXPORTS] !== "1")
        errors.push(
          `${EXPORTS_GUARD.strictJob}: step "${stepName}" must be one step that sets ${STRICT_EXPORTS}: "1" in its env`,
        );
    }
  }
  // A required check's name belongs to the exports guard alone.
  for (const [name, job] of Object.entries(mapping(workflow.jobs) ? workflow.jobs : {}))
    for (const [owner, check] of Object.entries(EXPORTS_GUARD.checks))
      if (
        mapping(job) &&
        Object.hasOwn(job, "name") &&
        couldRender(job.name, check) &&
        !(file === EXPORTS_GUARD.file && name === owner)
      )
        errors.push(
          `${name}: the job name could report ${check}, a check only ${EXPORTS_GUARD.file} reports`,
        );
  if (
    file === COMMIT_EMAILS.file &&
    JSON.stringify(Object.keys(workflow.jobs ?? {})) !== JSON.stringify([COMMIT_EMAILS.job])
  )
    errors.push(`commit emails: the only job must be ${COMMIT_EMAILS.job}`);
  for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
    if (!mapping(job)) {
      errors.push(`${name}: job must be a mapping`);
      continue;
    }
    const fromMatrix = matrixRunners(job);
    const runners =
      fromMatrix ?? (Array.isArray(job["runs-on"]) ? job["runs-on"] : [job["runs-on"]]);
    if (
      (!fromMatrix && runners.length !== 1) ||
      runners.length === 0 ||
      !runners.every((runner) => typeof runner === "string" && HOSTED_RUNNERS.has(runner))
    )
      errors.push(`${name}: runs-on must name a GitHub-hosted runner, or a matrix of them`);
    const checkImage = (container, label) => {
      const image = mapping(container) ? container.image : container;
      if (typeof image !== "string" || !/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(image))
        errors.push(`${name}: ${label} image must pin a sha256 digest`);
    };
    if (Object.hasOwn(job, "container")) checkImage(job.container, "container");
    for (const [service, container] of Object.entries(job.services ?? {}))
      checkImage(container, `service ${service}`);
    if (!Number.isFinite(job["timeout-minutes"]) || job["timeout-minutes"] <= 0)
      errors.push(`${name}: missing positive timeout-minutes`);
    // A cargo step that also runs after a failure needs an earlier step's success; without it a
    // failed setup step skips the sidecar builds and the build script fails on missing resources.
    const earlierIds = new Set();
    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      if (!mapping(step)) continue;
      const condition = String(step.if ?? "");
      const gated = topLevelConjuncts(condition).some((term) => {
        const m = /^steps\.([\w-]+)\.(?:outcome|conclusion)\s*==\s*'success'$/.exec(term);
        return m && earlierIds.has(m[1]);
      });
      if (
        /(?:^|[\s;&|(])cargo(?=\s|$)/m.test(String(step.run ?? "")) &&
        /\b(?:failure|always|cancelled)\(\)/.test(condition) &&
        !gated
      )
        errors.push(
          `${name}: step "${step.name ?? step.run}" runs cargo after a failure; also require an earlier step's steps.<id>.outcome == 'success'`,
        );
      if (typeof step.id === "string") earlierIds.add(step.id);
      if (triggers.includes("merge_group")) {
        const action = typeof step.uses === "string" ? step.uses.split("@")[0] : "";
        const inputs = mapping(step.with) ? step.with : {};
        const label = `${name}: step "${step.name ?? action}"`;
        if (action === "actions/cache")
          errors.push(
            `${label} saves on merge groups; use actions/cache/restore and a main-only save`,
          );
        if (action === "actions/cache/save" && !onMainOutsideRequests(topLevelConjuncts(condition)))
          errors.push(`${label}: if must require ${MAIN_ONLY} at the top level`);
        if (
          action === "Swatinem/rust-cache" &&
          !onMainOutsideRequests(topLevelConjuncts(String(inputs["save-if"] ?? "")))
        )
          errors.push(`${label}: save-if must require ${MAIN_ONLY} at the top level`);
        if (
          action === "actions/setup-node" &&
          Object.hasOwn(inputs, "cache") &&
          inputs.cache !== SETUP_NODE_CACHE
        )
          errors.push(`${label}: cache must be ${SETUP_NODE_CACHE}`);
      }
    }
    const scorecard = scorecardWorkflow && name === SCORECARD.job;
    const mainWriter = MAIN_WRITERS.some((writer) => file === writer.file && name === writer.job);
    if (
      NEVER_SKIPPED_ON.some((t) => triggers.includes(t)) &&
      !mainWriter &&
      Object.hasOwn(job, "if")
    ) {
      let condition = String(job.if)
        .trim()
        .replace(/^\$\{\{([\s\S]*)\}\}$/, "$1")
        .trim();
      const terms = topLevelConjuncts(condition);
      const needs = [job.needs ?? []].flat();
      const pathFiltered =
        file === RUST_PATH_FILTER.file &&
        RUST_PATH_FILTER.jobs.includes(name) &&
        needs.includes(RUST_PATH_FILTER.job) &&
        RUST_PATH_FILTER.terms.every(
          (term, i) =>
            terms[i] === term ||
            (i === 0 &&
              file === RESULT_ALWAYS.file &&
              name === RESULT_ALWAYS.job &&
              terms[i] === RESULT_ALWAYS.term),
        );
      if (pathFiltered) {
        let rest = terms.slice(RUST_PATH_FILTER.terms.length);
        if (
          file === MACOS_PATH_FILTER.file &&
          MACOS_PATH_FILTER.jobs.includes(name) &&
          rest[0] === MACOS_PATH_FILTER.term
        )
          rest = rest.slice(1);
        if (
          file === OFF_MERGE_GROUPS.file &&
          OFF_MERGE_GROUPS.jobs.includes(name) &&
          rest[0] === OFF_MERGE_GROUPS.term
        )
          rest = rest.slice(1);
        // Nothing more, or one term that runs off pull requests.
        condition = !rest.length
          ? OFF_PULL_REQUESTS
          : rest.length === 1
            ? topLevelConjuncts(rest[0])[0]
            : "";
      }
      const superseded =
        file === SUPERSEDED.file &&
        name === SUPERSEDED.job &&
        needs.includes(SUPERSEDED.needs) &&
        condition === SUPERSEDED.condition;
      if (!superseded && !condition.startsWith(OFF_PULL_REQUESTS))
        errors.push(
          `${name}: if must begin with ${OFF_PULL_REQUESTS} so merge_group, push and schedule always run it`,
        );
    }
    // Issue and cache writes run only for pushes or scheduled runs on main in the base repository,
    // never pull requests, merge groups or forks.
    if (mainWriter) {
      const terms = topLevelConjuncts(String(job.if ?? ""));
      if (!terms.includes(PUSH_ONLY) && !terms.includes(SCHEDULED))
        errors.push(`${name}: if must require ${PUSH_ONLY} or ${SCHEDULED} at the top level`);
      for (const required of [ON_MAIN, "!github.event.repository.fork"])
        if (!terms.includes(required))
          errors.push(`${name}: if must require ${required} at the top level`);
    }
    const requiredPermissions = JOB_PERMISSIONS.get(`${file}:${name}`) ?? { contents: "read" };
    // An issue writer runs one at a time, so two runs (a scheduled run and a rerun, say) cannot
    // both open the same issue: a fixed job-level group that never cancels a running writer.
    const group = mapping(job.concurrency) ? job.concurrency.group : null;
    if (
      mainWriter &&
      requiredPermissions.issues === "write" &&
      (typeof group !== "string" ||
        !group.trim() ||
        group.includes("${{") ||
        job.concurrency["cancel-in-progress"] !== false)
    )
      errors.push(
        `${name}: concurrency must be one fixed group with cancel-in-progress: false, since it writes issues`,
      );
    if (
      !mapping(job.permissions) ||
      Object.entries(requiredPermissions).some(([key, level]) => job.permissions[key] !== level) ||
      Object.entries(job.permissions).some(([key, level]) => requiredPermissions[key] !== level)
    )
      errors.push(
        `${name}: permissions must grant exactly ${Object.entries(requiredPermissions)
          .map(([key, level]) => `${key}: ${level}`)
          .join(", ")}`,
      );
    if (scorecard) {
      for (const key of ["env", "defaults", "container", "services"])
        if (Object.hasOwn(job, key)) errors.push(`scorecard: job ${key} is forbidden`);
      if (!Array.isArray(job.steps) || !job.steps.length)
        errors.push("scorecard: approved uses steps are required");
      for (const step of Array.isArray(job.steps) ? job.steps : []) {
        if (
          !mapping(step) ||
          typeof step.uses !== "string" ||
          !SCORECARD_ACTIONS.has(step.uses.split("@")[0]) ||
          Object.hasOwn(step, "run")
        )
          errors.push("scorecard: only approved uses steps are allowed; run is forbidden");
        if (!mapping(step)) continue;
        if (Object.hasOwn(step, "env")) errors.push("scorecard: step env is forbidden");
        if (
          step.uses?.startsWith("actions/checkout@") &&
          mapping(step.with) &&
          ["ref", "repository"].some((key) => Object.hasOwn(step.with, key))
        )
          errors.push("scorecard: checkout ref and repository overrides are forbidden");
      }
    }
  }

  // CS_STRICT_EXPORTS appears only as the env key of the guard's two strict steps.
  let strictUses = 0;
  visit(doc, {
    Scalar(_, scalar) {
      if (String(scalar.value).includes(STRICT_EXPORTS)) strictUses++;
    },
  });
  const strictJobSteps = workflow.jobs?.[EXPORTS_GUARD.strictJob]?.steps;
  const allowedStrict =
    file === EXPORTS_GUARD.file && Array.isArray(strictJobSteps)
      ? strictJobSteps.filter(
          (step) =>
            mapping(step) &&
            EXPORTS_GUARD.strictSteps.includes(step.name) &&
            mapping(step.env) &&
            Object.hasOwn(step.env, STRICT_EXPORTS),
        ).length
      : 0;
  if (strictUses !== allowedStrict)
    errors.push(
      `${STRICT_EXPORTS} may be set only in the env of ${EXPORTS_GUARD.file}'s ${EXPORTS_GUARD.strictSteps.join(" and ")} steps`,
    );

  visit(doc, {
    Pair(_, pair) {
      if (!isScalar(pair.key)) return;
      if (String(pair.key.value).toLowerCase() === "secrets")
        errors.push("secrets mappings are forbidden");
      if (pair.key.value === "uses") {
        const value = pair.value;
        if (
          !isScalar(value) ||
          typeof value.value !== "string" ||
          !/^[^\s@]+@[0-9a-f]{40}$/.test(value.value)
        )
          errors.push("uses must pin a full 40-hex commit SHA");
        if (!isScalar(value) || !/^\s*v\d+\.\d+\.\d+(?:\s|$)/.test(value.comment ?? ""))
          errors.push("uses must have a # vX.Y.Z comment");
      }
    },
    Scalar(_, scalar) {
      if (typeof scalar.value === "string" && /\bsecrets\b/i.test(scalar.value))
        errors.push("secrets references are forbidden");
    },
    Map(_, node) {
      const uses = node.get("uses");
      if (typeof uses === "string" && uses.startsWith("actions/checkout@")) {
        const withNode = node.get("with", true);
        if (!isMap(withNode) || withNode.get("persist-credentials") !== false)
          errors.push("checkout must set persist-credentials: false");
      }
    },
  });
  return errors;
}

// The packaging smoke's containers (scripts/ci/smoke-images.txt): one <name>:<tag>@sha256:<digest>
// a line, besides comments and blank lines. The tag names the image the workflow asks for; the
// digest is what runs, so a retagged image cannot change the smoke.
export function smokeImagesPolicy(text) {
  const errors = [];
  const names = new Set();
  for (const line of text.split("\n").map((l) => l.trim())) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([^\s:@]+:[^\s:@]+)@sha256:[0-9a-f]{64}$/.exec(line);
    if (!match) errors.push(`${line}: must be <name>:<tag>@sha256:<digest>`);
    else if (names.has(match[1])) errors.push(`${match[1]}: listed twice`);
    else names.add(match[1]);
  }
  if (!names.size && !errors.length) errors.push("no images");
  return errors;
}

const workflowFiles = (directory) =>
  fs
    .readdirSync(directory)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort();

export function checkWorkflowDirectory(directory, files = workflowFiles(directory)) {
  if (!files.length) return [`${directory}: no workflows`];
  return files.flatMap((file) =>
    workflowPolicy(fs.readFileSync(path.join(directory, file), "utf8"), file).map(
      (error) => `${file}: ${error}`,
    ),
  );
}

// A realpath guard keeps imports inert, including when /tmp is a symlink on macOS.
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: node scripts/workflow-policy.mjs <dir>");
    const files = workflowFiles(process.argv[2]);
    const errors = checkWorkflowDirectory(process.argv[2], files);
    for (const error of errors) console.error(error);
    if (!errors.length) console.log(`workflow-policy: ${files.length} files OK`);
    process.exitCode = errors.length ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
