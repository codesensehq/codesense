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
  "set_active_team",
  "add_source_repo",
  "attach_source_repo_path",
  "run_in_terminal_tab",
  "create_content_file",
  "set_epic_repos",
  "clone_repo",
];

// What a probe may read: each tool's arguments and the result fields its handler serialises
// (`[]` is a list's entry, `.*` any field of a record), and for a field with a fixed set of
// values, those values. The fields come from the Rust, not the tool's description, and
// `probe-tools.node-test.mjs` reads the handlers to hold them there. A probe on a tool listed
// here takes only those arguments, and picks, yields and maps only those fields and values. A
// probe on a tool that isn't listed is a lint error: it is added here, from the Rust, first.
export const PROBE_TOOLS = {
  // `describe_setup` takes no arguments; its `data` is `SetupState` (`mcp/setup_tools.rs`).
  // A repo's `attachment` is `attached`, `missing` (bound, the clone is gone) or `unattached`.
  describe_setup: {
    params: [],
    fields: [
      "activeOrg",
      "activeTeam",
      "orgs[].slug",
      "orgs[].displayName",
      "orgs[].orgRoot",
      "orgs[].remoteUrl",
      "orgs[].loadErrors[]",
      "orgs[].teams[].name",
      "orgs[].teams[].archived",
      "orgs[].teams[].parentTeam",
      "orgs[].teams[].starterPage",
      "orgs[].teams[].synced",
      "orgs[].teams[].sourceRepos[].slug",
      "orgs[].teams[].sourceRepos[].remoteKey",
      "orgs[].teams[].sourceRepos[].attachment",
      "orgs[].teams[].sourceRepos[].localPath",
    ],
    values: { "orgs[].teams[].sourceRepos[].attachment": ["attached", "missing", "unattached"] },
  },
  // `list_source_repos` takes no arguments and reads the session's own org only.
  list_source_repos: {
    params: [],
    fields: [
      "activeOrg",
      "activeTeam",
      "primary[]",
      "byTeam[].team",
      "byTeam[].sourceRepos[]",
      "sourceRepoIdentities[].team",
      "sourceRepoIdentities[].slug",
      "sourceRepoIdentities[].attachment",
      "sourceRepoIdentities[].localPath",
    ],
  },
  // `records_list` has no filter argument: a probe picks rows by their fields.
  records_list: {
    params: ["org", "team", "collection", "window"],
    fields: ["total", "rows[].id", "rows[].title", "rows[].fields.*"],
  },
  // `read_epic_repos` answers with the epic's `owner/repo` list, and fails when the path is not
  // an epic the session can read.
  read_epic_repos: { params: ["epicFilePath"], fields: ["[]"] },
  // `read_content_file` reads one file of the session's own team content; a file that isn't
  // there is a tool error. `text` is absent for a binary file and `bytesUrl` only for a large or
  // binary one (`file_surface.rs` `read_snapshot`).
  read_content_file: {
    params: ["path", "maxBytes"],
    fields: ["text", "bytesUrl", "size", "truncated", "sha256"],
  },
  // `probe_environment` (`mcp/probe_environment.rs`): `clis` maps each agent CLI to its fields,
  // `env_set` each asked name to a bool, and `git_repo` is there only when `gitRepoPath` is
  // given. No field is a secret and none holds a token.
  probe_environment: {
    params: ["gitRepoPath", "envNames"],
    fields: [
      "clis.*",
      "git.available",
      "git.version",
      "gh_version",
      "gh_auth.signed_in",
      "gh_auth.account",
      "gh_auth.scopes[]",
      "gh_auth.reason",
      "git_repo.path",
      "git_repo.exists",
      "git_repo.is_repo",
      "env_set.*",
    ],
  },
};

// What a probe reads, before its map turns it into a state: `found` (its pick matched an
// entry, or with no pick the tool answered), `none` (nothing matched, or an argument has no
// value yet: an earlier probe found nothing or the person hasn't given the input) and
// `unreadable` (the tool failed). A probe that yields a field the registry lists values for
// reads that field's value in place of `found`; across several entries the least-done state
// counts. Every map names each of these, so no state is left for the agent to guess.
export const PROBE_OUTCOMES = ["found", "none", "unreadable"];

const returns = (tool, field) =>
  PROBE_TOOLS[tool].fields.some((f) =>
    f.endsWith(".*")
      ? field.startsWith(f.slice(0, -1)) && field.length > f.length - 1
      : f === field,
  );

// The verbs that write a file, and the argument naming it. A relative path lands in whatever
// team the app has active, so it must start from a probed value.
const PATH_ARGS = { create_content_file: "path", set_epic_repos: "epicFilePath" };

// A team ledger row is shared through git. These key names and value shapes are the ones
// that would carry a path, a username or a secret into it.
const PRIVATE_KEY = /path|dir|folder|home|user|account|token|secret|password|credential|key/i;
const PRIVATE_VALUE =
  /^~|^\/|\/(?:Users|home)\/|\{\{[^}]*(?:path|user|account|token|secret)[^}]*\}\}/i;

// One piece of a pattern a typed command may take: a character class whose members are
// letters, digits and `._/` (a range only within a-z, A-Z or 0-9, a `-` only first or last,
// so no range can span punctuation), or one such character, with an optional quantifier.
// Anything else (a wildcard, a group, an alternation, a negated class, a space, a symbol a
// shell reads) is more than a word, so the rule is on the pattern's shape and not on what it
// happens to match.
const CLASS_MEMBER = "(?:[A-Z]-[A-Z]|[a-z]-[a-z]|[0-9]-[0-9]|[A-Za-z0-9._/])";
const WORD_ATOM = `(?:\\[-?${CLASS_MEMBER}+-?\\]|\\\\\\.|[A-Za-z0-9_/-])(?:[+*?]|\\{\\d+(?:,\\d*)?\\})?`;
const WORD_PATTERN = new RegExp(`^\\^?(?:${WORD_ATOM})+\\$?$`);

/** Whether an input pattern can match text with a shell metacharacter in it. */
export function unsafeInput(pattern) {
  try {
    new RegExp(pattern);
  } catch {
    return true;
  }
  return !WORD_PATTERN.test(pattern);
}

/**
 * The value each `{{input}}` took in `command`, if it is the act's `cmd`: the same text, with
 * each input replaced by one value its pattern matches. `inputs` gives each name's pattern; a
 * command with none is exact. Gives `{name: value}`, or `undefined` when the command is not it.
 */
export function commandInputs(cmd, command, inputs) {
  if (typeof command !== "string") return undefined;
  if (!inputs) return command === cmd ? {} : undefined;
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  const parts = cmd.split(/\{\{\s*([^}\s]+)\s*\}\}/);
  const names = [];
  const body = parts
    .map((part, i) => {
      if (i % 2 === 0) return escape(part);
      names.push(part);
      const pattern = (inputs[part] ?? "^$").replace(/^\^/, "").replace(/\$$/, "");
      return `(?<g${names.length - 1}>${pattern})`;
    })
    .join("");
  const found = new RegExp(`^${body}$`).exec(command);
  if (!found) return undefined;
  return Object.fromEntries(names.map((name, i) => [name, found.groups[`g${i}`]]));
}

/** Whether `command` is the act's `cmd`, with each `{{input}}` filled by a value it matches. */
export const commandMatches = (cmd, command, inputs) =>
  commandInputs(cmd, command, inputs) !== undefined;

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

  for (const act of acts)
    if (act.verb?.tool === "run_in_terminal_tab")
      errors.push(
        `${where}: act ${act.id} calls run_in_terminal_tab as a verb; a command goes in run, where it is fixed`,
      );

  // `{{probe.<id>.<name>}}` names a value an earlier probe yields.
  const yielded = new Set();
  const probeErrors = (name, what) => {
    const [root, id, value] = name.split(".");
    if (root === "probe" && !yielded.has(`${id}.${value}`)) errors.push(what(id));
  };
  for (const probe of step.probe ?? []) {
    const { tool, ...args } = probe.check;
    const known = PROBE_TOOLS[tool];
    if (!known)
      errors.push(
        `${where}: probe ${probe.id} uses ${tool}, which is not in the probe registry; add it from its Rust`,
      );
    if (known) {
      for (const arg of Object.keys(args))
        if (!known.params.includes(arg))
          errors.push(`${where}: probe ${probe.id} passes ${arg}, which ${tool} does not take`);
      for (const field of Object.keys(probe.pick ?? {}))
        if (!returns(tool, field))
          errors.push(
            `${where}: probe ${probe.id} picks on ${field}, which ${tool} does not return`,
          );
      for (const field of Object.values(probe.yields ?? {}))
        if (!returns(tool, field))
          errors.push(`${where}: probe ${probe.id} yields ${field}, which ${tool} does not return`);
      const valued = Object.values(probe.yields ?? {}).filter((f) => known.values?.[f]);
      if (valued.length > 1)
        errors.push(`${where}: probe ${probe.id} yields ${valued.join(" and ")}; it maps one`);
      const reads = valued.length
        ? ["none", "unreadable", ...known.values[valued[0]]]
        : PROBE_OUTCOMES;
      for (const key of Object.keys(probe.map ?? {}))
        if (!reads.includes(key))
          errors.push(
            `${where}: probe ${probe.id} maps ${key}, which it never reads (${reads.join(", ")})`,
          );
      for (const key of reads)
        if (!(key in (probe.map ?? {})))
          errors.push(`${where}: probe ${probe.id} does not map ${key}`);
    }
    for (const name of templates(args)) {
      probeErrors(
        name,
        () => `${where}: probe ${probe.id} uses {{${name}}}, which no earlier probe yields`,
      );
      const root = name.split(".")[0];
      if (root !== "probe" && !(root in (step.inputs ?? {})))
        errors.push(
          `${where}: probe ${probe.id} uses {{${name}}}, which is not an input or a probe result`,
        );
    }
    for (const value of Object.keys(probe.yields ?? {})) yielded.add(`${probe.id}.${value}`);
  }

  for (const act of acts) {
    for (const name of templates({ args: act.verb?.args, open_url: act.open_url }))
      probeErrors(
        name,
        (id) => `${where}: act ${act.id} uses {{${name}}}, which probe ${id} does not yield`,
      );
    const pathArg = PATH_ARGS[act.verb?.tool];
    const path = act.verb?.args?.[pathArg];
    if (pathArg && !(typeof path === "string" && /^\{\{\s*probe\./.test(path)))
      errors.push(
        `${where}: act ${act.id}: ${act.verb.tool} ${pathArg} must start with a {{probe.…}} value, never a relative or bare path`,
      );
  }

  // A list input is the whole value of an argument, never part of a string.
  for (const [name, spec] of Object.entries(step.inputs ?? {})) {
    if (!spec.list) continue;
    const strings = [];
    const walk = (v) => {
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk([acts.map((a) => [a.verb, a.open_url]), step.record?.fields]);
    for (const value of strings)
      if (templates(value).includes(name) && value.trim() !== `{{${name}}}`)
        errors.push(`${where}: input ${name} is a list; pass it whole as "{{${name}}}"`);
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

  for (const name of templates(step.on_fail))
    if (!(name in (step.inputs ?? {})))
      errors.push(`${where}: on_fail uses {{${name}}}, which is not an input`);
  for (const option of step.on_fail?.options ?? [])
    if (option.do === "copy" && !step.on_fail.copy)
      errors.push(`${where}: on_fail offers "${option.label}" but has no copy text`);

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

  for (const id of [step.verify?.probe ?? []].flat())
    if (!probeIds.includes(id)) errors.push(`${where}: verify names unknown probe ${id}`);

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
    // own command and its folder hold no probe result (a git remote, a branch name, an
    // account name can hold shell syntax). A command may take an input, once the input's
    // pattern can match nothing a shell reads: the guide types it as one line, and the
    // consent check matches it against that pattern.
    for (const name of templates({ cmd: act.run?.cmd, cwd: act.run?.cwd })) {
      const spec = step.inputs?.[name];
      const inFolder = templates({ cwd: act.run?.cwd }).includes(name);
      if (!spec || inFolder || unsafeInput(spec.pattern))
        errors.push(
          `${where}: act ${act.id} builds its command from {{${name}}}; a run command and its folder are fixed`,
        );
    }
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
        // A probe value can be a folder or a login whatever its field is called.
        if (root === "probe")
          errors.push(`${where}: record uses {{${name}}}, a probe value; a team row holds none`);
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
 * verbs of the acts it `then`-runs. A command with `{{input}}` templates also carries
 * `inputs`, each input's pattern, so the check can match the typed command. A step file that
 * doesn't read is left out; the pack build reports it.
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
      if (act.verb) {
        // A literal `content` is fixed by the step file, so the write must carry exactly it.
        const content = act.verb.args?.content;
        const fixed = typeof content === "string" && templates(content).length === 0;
        return [{ verb: act.verb.tool, uses: act.repeat ?? 1, ...(fixed ? { content } : {}) }];
      }
      if (act.run) {
        // A command that takes inputs is matched against each input's own pattern.
        const names = [...new Set(templates(act.run.cmd))];
        const inputs = Object.fromEntries(names.map((n) => [n, step.inputs?.[n]?.pattern ?? "^$"]));
        return [
          {
            verb: "run_in_terminal_tab",
            uses: 1,
            cmd: act.run.cmd,
            ...(names.length ? { inputs } : {}),
          },
        ];
      }
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
