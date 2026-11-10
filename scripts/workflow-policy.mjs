// SPDX-License-Identifier: MIT
// Shared policy for public workflows, parsed as YAML rather than matched by indentation.
import { parseDocument, isMap, isScalar, visit } from "yaml";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
// The commit email audit runs nightly and on main, never on pull requests.
const COMMIT_EMAILS = {
  file: "commit-emails.yml",
  job: "commit-emails",
  triggers: ["push", "schedule", "workflow_dispatch"],
};
const JOB_PERMISSIONS = new Map([
  [`${COMMIT_EMAILS.file}:${COMMIT_EMAILS.job}`, { contents: "read" }],
  ["dco.yml:dco", { contents: "read", "pull-requests": "read" }],
  ["quarantine.yml:quarantine-issues", { contents: "read", issues: "read" }],
  [`${FLAKY_ISSUES.file}:${FLAKY_ISSUES.job}`, { contents: "read", issues: "write" }],
  [
    `${SCORECARD.file}:${SCORECARD.job}`,
    { contents: "read", "security-events": "write", "id-token": "write" },
  ],
]);
// A merge group is a temporary ref: caches it saved would only evict main's. setup-node saves
// its cache in a post step, so on a merge_group workflow it may cache only off merge groups.
const SETUP_NODE_CACHE = "${{ github.event_name != 'merge_group' && 'pnpm' || '' }}";
const PUSH_ONLY = "github.event_name == 'push'";
// A job in a workflow that runs on merge_group, push or schedule may be conditional only on
// pull requests: a merge group must report every required check, and main and the nightly runs
// must test everything. A pull request may skip a job (rust.yml's macOS job runs there only with
// the ci:macos label). GitHub reads || as the lowest-precedence operator, so an expression that
// begins with this term is true off pull requests whatever follows.
const OFF_PULL_REQUESTS = "github.event_name != 'pull_request' ||";
const NEVER_SKIPPED_ON = ["merge_group", "push", "schedule"];
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
    : ["pull_request", "merge_group", "push", "workflow_dispatch"];
  if (scorecardWorkflow && (Object.hasOwn(workflow, "env") || Object.hasOwn(workflow, "defaults")))
    errors.push("scorecard: workflow env and defaults are forbidden");
  // Kept apart from allowedTriggers, so each file's exception reads (and merges) on its own.
  const permittedTriggers = file === COMMIT_EMAILS.file ? COMMIT_EMAILS.triggers : allowedTriggers;
  if (!triggers.length || triggers.some((t) => !permittedTriggers.includes(t)))
    errors.push(
      "triggers must match the workflow allowlist; Scorecard and commit emails forbid pull requests",
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
    const runners = Array.isArray(job["runs-on"]) ? job["runs-on"] : [job["runs-on"]];
    if (runners.length !== 1 || typeof runners[0] !== "string" || !HOSTED_RUNNERS.has(runners[0]))
      errors.push(`${name}: runs-on must name a GitHub-hosted runner without expressions`);
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
            `${label} saves on merge groups; use actions/cache/restore and a push-only save`,
          );
        if (action === "actions/cache/save" && !topLevelConjuncts(condition).includes(PUSH_ONLY))
          errors.push(`${label}: if must require ${PUSH_ONLY} at the top level`);
        if (
          action === "Swatinem/rust-cache" &&
          !topLevelConjuncts(String(inputs["save-if"] ?? "")).includes(PUSH_ONLY)
        )
          errors.push(`${label}: save-if must require ${PUSH_ONLY} at the top level`);
        if (
          action === "actions/setup-node" &&
          Object.hasOwn(inputs, "cache") &&
          inputs.cache !== SETUP_NODE_CACHE
        )
          errors.push(`${label}: cache must be ${SETUP_NODE_CACHE}`);
      }
    }
    const scorecard = scorecardWorkflow && name === SCORECARD.job;
    const flakyIssues = file === FLAKY_ISSUES.file && name === FLAKY_ISSUES.job;
    if (
      NEVER_SKIPPED_ON.some((t) => triggers.includes(t)) &&
      !flakyIssues &&
      Object.hasOwn(job, "if")
    ) {
      const condition = String(job.if)
        .trim()
        .replace(/^\$\{\{([\s\S]*)\}\}$/, "$1")
        .trim();
      if (!condition.startsWith(OFF_PULL_REQUESTS))
        errors.push(
          `${name}: if must begin with ${OFF_PULL_REQUESTS} so merge_group, push and schedule always run it`,
        );
    }
    // Issue writes run only for pushes to main in the base repository, never pull requests or forks.
    if (flakyIssues) {
      const terms = topLevelConjuncts(String(job.if ?? ""));
      for (const required of [
        "github.event_name == 'push'",
        "github.ref == 'refs/heads/main'",
        "!github.event.repository.fork",
      ])
        if (!terms.includes(required))
          errors.push(`${name}: if must require ${required} at the top level`);
    }
    const requiredPermissions = JOB_PERMISSIONS.get(`${file}:${name}`) ?? { contents: "read" };
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
