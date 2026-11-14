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

  for (const act of acts)
    if (act.consent === "external-write")
      errors.push(`${where}: act ${act.id} is external-write, which setup refuses`);

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
    // The one place user text becomes a command is the engine's `clone_repo`; a step's own
    // command is fixed, so it may read a probe result and nothing the person typed.
    for (const name of templates(act.run))
      if (name.split(".")[0] !== "probe")
        errors.push(
          `${where}: act ${act.id} builds a command from ${name}; a run command is fixed`,
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

  const files = readdirSync(stepsDir).filter((f) => f.endsWith(".yml") && f !== "index.yml");
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
