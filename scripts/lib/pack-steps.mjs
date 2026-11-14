// SPDX-License-Identifier: MIT
// Setup steps in a pack: `setup/steps/index.yml` orders them, each `setup/steps/<id>.yml`
// is one step (`step_format: 1`), and `setup/step.schema.json` is the contract. The guide
// agent reads these files and acts only after a click; the engine never runs a step, so
// this check is the only place a bad step is caught before it ships.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const STEP_SCHEMA_PATH = join(
  ROOT,
  "codesense-docs/packs/codesense-guide/setup/step.schema.json",
);

const INDEX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["step_format", "steps"],
  properties: {
    step_format: { const: 1 },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title"],
        properties: {
          id: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 },
          title: { type: "string", minLength: 1, maxLength: 120 },
          needs: { type: "array", items: { type: "string" }, uniqueItems: true },
          check: { type: "string" },
        },
      },
    },
  },
};

let validators;
function schemas() {
  if (!validators) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    validators = {
      step: ajv.compile(JSON.parse(readFileSync(STEP_SCHEMA_PATH, "utf8"))),
      index: ajv.compile(INDEX_SCHEMA),
    };
  }
  return validators;
}

// The verbs the guide uses to change something, by their bare names. Each waits for a click
// (`scripts/setup-consent-check.mjs`), so none belongs on a `read` act.
export const SETUP_VERBS = [
  "create_local_organization",
  "attach_context_repository",
  "create_team",
  "add_source_repo",
  "attach_source_repo_path",
  "run_in_terminal_tab",
  "create_content_file",
  "set_epic_repos",
  "clone_repo",
];

// A team ledger row is shared through git. These key names and value shapes are the ones
// that would carry a path, a username or a secret into it.
const PRIVATE_KEY = /path|dir|folder|home|user|account|token|secret|password|credential|key/i;
const PRIVATE_VALUE =
  /^~|^\/|\/(?:Users|home)\/|\{\{[^}]*(?:path|user|account|token|secret)[^}]*\}\}/i;

/** Every `{{a.b}}` template in a value, as its dotted name. */
function templates(value) {
  const found = [];
  const walk = (v) => {
    if (typeof v === "string")
      for (const m of v.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)) found.push(m[1]);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return found;
}

/** Problems in one step that the schema can't express. `where` names the file. */
export function stepRuleErrors(step, where) {
  const errors = [];
  const acts = step.act ?? [];
  const actIds = acts.map((a) => a.id);
  const probeIds = (step.probe ?? []).map((p) => p.id);
  for (const [list, what] of [
    [actIds, "act"],
    [probeIds, "probe"],
  ])
    if (new Set(list).size !== list.length) errors.push(`${where}: duplicate ${what} id`);

  for (const act of acts) {
    if (act.consent === "external-write")
      errors.push(`${where}: act ${act.id} is external-write, which setup refuses`);
    // A read act needs no click, so it may neither run a command nor call a setup verb.
    if (act.consent === "read" && act.run)
      errors.push(`${where}: act ${act.id} is read but runs a command`);
    if (act.consent === "read" && SETUP_VERBS.includes(act.verb?.tool))
      errors.push(`${where}: act ${act.id} is read but calls ${act.verb.tool}, a setup verb`);
  }

  for (const act of acts) {
    if (act.repeat && !act.verb) errors.push(`${where}: act ${act.id} repeats but has no verb`);
    for (const id of act.then ?? []) {
      const next = acts.find((a) => a.id === id);
      if (id === act.id) errors.push(`${where}: act ${act.id} then-runs itself`);
      else if (!next) errors.push(`${where}: act ${act.id} then-runs unknown act ${id}`);
      else if (next.then?.length)
        errors.push(
          `${where}: act ${next.id} then-runs ${next.then[0]}, but a then-act cannot chain`,
        );
      else if (!next.verb)
        errors.push(`${where}: act ${act.id} then-runs ${id}, which is not a verb act`);
      else if (next.consent !== act.consent)
        errors.push(`${where}: act ${act.id} then-runs ${id}, which has another consent class`);
    }
  }

  const options = step.ask?.options ?? [];
  for (const option of options)
    if (option.act !== "none" && !actIds.includes(option.act))
      errors.push(`${where}: option "${option.label}" names unknown act ${option.act}`);
  // A change waits for a click, and the person can always decline: "Not now" writes nothing.
  const changes = acts.some((a) => a.consent !== "read");
  if (changes && step.ask && !options.some((o) => o.act === "none"))
    errors.push(`${where}: a step that changes something needs a "none" option on its card`);
  if (changes && !step.ask)
    errors.push(`${where}: a step that changes something needs an ask card`);

  if (step.verify && !probeIds.includes(step.verify.probe))
    errors.push(`${where}: verify names unknown probe ${step.verify.probe}`);

  const inputs = Object.keys(step.inputs ?? {});
  for (const [name, spec] of Object.entries(step.inputs ?? {})) {
    try {
      new RegExp(spec.pattern);
    } catch {
      errors.push(`${where}: input ${name} has a pattern that is not a regular expression`);
    }
  }
  for (const act of acts) {
    // The one place outside text becomes a command is the engine's `clone_repo`. A step's
    // own command and its folder are fixed: not even a probe result (a git remote, a branch
    // name, an account name) goes into them, since those can hold shell syntax.
    for (const name of templates({ cmd: act.run?.cmd, cwd: act.run?.cwd }))
      errors.push(
        `${where}: act ${act.id} builds its command from {{${name}}}; a run command and its folder are fixed`,
      );
    for (const name of templates({ verb: act.verb, open_url: act.open_url })) {
      const root = name.split(".")[0];
      if (root !== "probe" && !inputs.includes(root))
        errors.push(
          `${where}: act ${act.id} uses {{${name}}}, which is not an input or a probe result`,
        );
    }
  }
  for (const name of templates(step.record?.fields))
    if (name.split(".")[0] !== "probe" && !inputs.includes(name.split(".")[0]))
      errors.push(`${where}: record uses {{${name}}}, which is not an input or a probe result`);

  if (step.record?.scope === "team")
    for (const [key, value] of Object.entries(step.record.fields ?? {})) {
      // An input can be a folder or a login whatever it is called, so a team row may name
      // only an input the step marks shareable.
      for (const name of templates(value)) {
        const root = name.split(".")[0];
        if (inputs.includes(root) && !step.inputs[root].shareable)
          errors.push(
            `${where}: record uses {{${name}}}, an input not marked shareable; a team row holds only shareable inputs`,
          );
      }
      if (PRIVATE_KEY.test(key))
        errors.push(
          `${where}: a team record field is named ${key}; team rows hold no paths, usernames or secrets`,
        );
      if (typeof value === "string" && PRIVATE_VALUE.test(value))
        errors.push(`${where}: team record field ${key} holds a path, a username or a secret`);
    }
  return errors;
}

function readYaml(path, errors, rel) {
  try {
    return parse(readFileSync(path, "utf8"));
  } catch (e) {
    errors.push(`${rel}: cannot read: ${String(e.message).split("\n")[0]}`);
    return undefined;
  }
}

/** The step folder's problems: the index, every step file and the two against each other. */
export function stepErrors(dir) {
  const stepsDir = join(dir, "setup/steps");
  const indexPath = join(stepsDir, "index.yml");
  let isFile = false;
  try {
    isFile = statSync(indexPath).isFile();
  } catch {
    // No index: not a step pack.
  }
  if (!isFile) return [];

  const { step: validateStep, index: validateIndex } = schemas();
  const errors = [];
  const index = readYaml(indexPath, errors, "setup/steps/index.yml");
  if (index === undefined) return errors;
  if (!validateIndex(index)) {
    for (const e of validateIndex.errors)
      errors.push(`setup/steps/index.yml${e.instancePath} ${e.message}`);
    return errors;
  }

  const entries = index.steps;
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) errors.push(`setup/steps/index.yml: duplicate step ${entry.id}`);
    for (const need of entry.needs ?? [])
      if (!seen.has(need))
        errors.push(
          `setup/steps/index.yml: ${entry.id} needs ${need}, which is not an earlier entry`,
        );
    seen.add(entry.id);
  }

  const listed = readdirSync(stepsDir);
  for (const file of listed.filter((f) => f.endsWith(".yaml")))
    errors.push(`setup/steps/${file}: a step file ends in .yml; this one is never read`);
  const files = listed.filter((f) => f.endsWith(".yml") && f !== "index.yml");
  for (const file of files)
    if (!entries.some((e) => `${e.id}.yml` === file))
      errors.push(`setup/steps/${file}: not listed in index.yml`);

  for (const entry of entries) {
    const rel = `setup/steps/${entry.id}.yml`;
    if (!files.includes(`${entry.id}.yml`)) {
      errors.push(`${rel}: listed in index.yml but missing`);
      continue;
    }
    const step = readYaml(join(stepsDir, `${entry.id}.yml`), errors, rel);
    if (step === undefined) continue;
    if (!validateStep(step)) {
      for (const e of validateStep.errors) errors.push(`${rel}${e.instancePath} ${e.message}`);
      continue;
    }
    if (step.id !== entry.id) errors.push(`${rel}: id is ${step.id}, the index says ${entry.id}`);
    if (step.title !== entry.title) errors.push(`${rel}: title differs from the index`);
    if (JSON.stringify(step.needs ?? []) !== JSON.stringify(entry.needs ?? []))
      errors.push(`${rel}: needs differ from the index`);
    errors.push(...stepRuleErrors(step, rel));
  }
  return errors;
}

/**
 * What each act of a pack's steps allows after its click, from the step files alone:
 * `steps`, the ids the index lists, and `allowances`, `"<step>/<act>"` to the act's consent
 * class and the verbs it may call, each with how many times, and for a `run` act the one
 * command it may type. An act allows its own verb (`repeat` times, default once) and the
 * verbs of the acts it `then`-runs. A step file that doesn't read is left out; the pack
 * build reports it.
 */
export function actAllowances(dir) {
  const allowances = new Map();
  const stepsDir = join(dir, "setup/steps");
  let entries;
  try {
    entries = parse(readFileSync(join(stepsDir, "index.yml"), "utf8")).steps ?? [];
  } catch {
    return { steps: new Set(), allowances };
  }
  for (const { id } of entries) {
    let step;
    try {
      step = parse(readFileSync(join(stepsDir, `${id}.yml`), "utf8"));
    } catch {
      continue;
    }
    const acts = step?.act ?? [];
    const own = (act) => {
      if (act.verb) return [{ verb: act.verb.tool, uses: act.repeat ?? 1 }];
      if (act.run) return [{ verb: "run_in_terminal_tab", uses: 1, cmd: act.run.cmd }];
      return [];
    };
    for (const act of acts) {
      const verbs = [...own(act)];
      for (const next of act.then ?? []) verbs.push(...own(acts.find((a) => a.id === next) ?? {}));
      allowances.set(`${id}/${act.id}`, { consent: act.consent, verbs });
    }
  }
  return { steps: new Set(entries.map((e) => e.id)), allowances };
}
