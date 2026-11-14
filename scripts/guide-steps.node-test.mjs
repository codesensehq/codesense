// SPDX-License-Identifier: MIT
// Setup steps as data: the step schema, the index, the ledger collection and how the pack
// build holds a pack to them.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { PACKS_ROOT, buildPack, docsMapping } from "./pack-build.mjs";
import { stepErrors, stepRuleErrors } from "./lib/pack-steps.mjs";

const PACK = join(PACKS_ROOT, "codesense-guide");

// DESIGN section 4.1, as data.
const ghInstalled = () => ({
  step_format: 1,
  id: "gh-installed",
  title: "Install gh",
  summary: "Lets agents talk to GitHub with your own login.",
  probe: [
    {
      id: "version",
      check: { tool: "probe_environment", check: "gh_version" },
      map: { present: "done", absent: "missing" },
    },
  ],
  ask: {
    text: "**Install gh?** I'll open the download page.",
    options: [
      { label: "Do it", act: "open" },
      { label: "Not now", act: "none" },
    ],
  },
  act: [
    {
      id: "open",
      consent: "install-or-sign-in",
      what: "open cli.github.com",
      where: "your browser",
      why: "so agents can use GitHub as you",
      open_url: "https://cli.github.com",
    },
  ],
  verify: { probe: "version", expect: "done" },
  record: { scope: "machine", fields: { tool: "gh" }, secret: "never" },
  undo: "Uninstall gh the way you installed it.",
});

const ghAuth = () => ({
  step_format: 1,
  id: "gh-auth",
  title: "Sign in to GitHub with gh",
  summary: "Lets agents read issues, clone repos and open pull requests with your own login.",
  needs: ["gh-installed"],
  when: { any_source_repo_host: "github.com" },
  probe: [
    {
      id: "status",
      check: { tool: "probe_environment", check: "gh_auth", host: "github.com" },
      map: {
        signed_in: "done",
        signed_out: "missing",
        token_expired: "partial",
        gh_missing: "unknown",
      },
    },
  ],
  ask: {
    text: "**Sign in to GitHub?** You sign in in your browser; I never see your password or token.",
    options: [
      { label: "Do it", act: "sign-in" },
      { label: "Not now", act: "none" },
    ],
  },
  act: [
    {
      id: "sign-in",
      consent: "install-or-sign-in",
      what: "gh auth login --web, GitHub's own sign-in",
      where: "a terminal tab on this Mac, then your browser",
      why: "so agents can read issues, clone repos and open pull requests as you",
      run: {
        cmd: "gh auth login --hostname github.com --git-protocol https --web",
        in: "terminal_tab",
      },
      wait: { until: "tab_exit", then: "verify", timeout: "10m" },
    },
  ],
  verify: { probe: "status", expect: "done" },
  record: {
    scope: "machine",
    fields: { host: "github.com", account: "{{probe.status.account}}" },
    secret: "never",
  },
  undo: "Run `gh auth logout --hostname github.com`. CodeSense stored nothing.",
});

const teamStep = () => ({
  step_format: 1,
  id: "team",
  title: "Name your team",
  summary: "Everything else is written to your team.",
  probe: [
    {
      id: "teams",
      check: { tool: "describe_setup" },
      map: { some: "done", none: "missing" },
    },
  ],
  ask: {
    text: "**Name your team.**",
    free_text: true,
    options: [
      { label: "Do it", act: "create" },
      { label: "Not now", act: "none" },
    ],
  },
  inputs: { team: { pattern: "^[a-z0-9][a-z0-9-]{0,38}$", shareable: true } },
  act: [
    {
      id: "create",
      consent: "local-write",
      what: "create the team",
      where: "your context repo",
      why: "so your stories have a home",
      verb: { tool: "create_team", args: { name: "{{team}}" } },
    },
  ],
  verify: { probe: "teams", expect: "done" },
  record: { scope: "team", fields: { team: "{{team}}" }, secret: "never" },
  undo: "Archive the team from the identity menu.",
});

const INDEX_OF = (steps) => ({
  step_format: 1,
  steps: steps.map((s) => ({ id: s.id, title: s.title, ...(s.needs ? { needs: s.needs } : {}) })),
});

/** Write `steps` (and an index for them unless `index` is given) into a scratch pack folder. */
function check(steps, { index, extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "guide-steps-"));
  try {
    const folder = join(dir, "setup/steps");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "index.yml"), stringify(index ?? INDEX_OF(steps)));
    for (const step of steps) writeFileSync(join(folder, `${step.id}.yml`), stringify(step));
    for (const [name, text] of Object.entries(extra)) writeFileSync(join(folder, name), text);
    return stepErrors(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const has = (errors, text) =>
  assert.ok(
    errors.some((e) => e.includes(text)),
    `expected an error with "${text}", got ${JSON.stringify(errors)}`,
  );

test("the guide pack's own steps and index are clean", () => {
  assert.deepEqual(stepErrors(PACK), []);
  assert.deepEqual(buildPack(PACK, { check: true }).errors, []);
});

test("good steps pass, in order", () => {
  assert.deepEqual(check([ghInstalled(), ghAuth(), teamStep()]), []);
});

test("a folder with no index is not a step pack", () => {
  const dir = mkdtempSync(join(tmpdir(), "guide-steps-"));
  try {
    assert.deepEqual(stepErrors(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a step without undo, with an unknown key or with step_format 2 is refused", () => {
  const noUndo = ghInstalled();
  delete noUndo.undo;
  has(check([noUndo]), "must have required property 'undo'");
  has(check([{ ...ghInstalled(), surprise: true }]), "must NOT have additional properties");
  has(check([{ ...ghInstalled(), step_format: 2 }]), "must be equal to constant");
});

test("an id that is not [a-z0-9-], a missing record or a multi-line undo is refused", () => {
  has(check([{ ...ghInstalled(), id: "Gh_Installed" }]), "must match pattern");
  const noRecord = ghInstalled();
  delete noRecord.record;
  has(check([noRecord]), "must have required property 'record'");
  has(check([{ ...ghInstalled(), undo: "one\ntwo" }]), "/undo must match pattern");
});

test("secret: never is required, with that fixed value", () => {
  const step = ghInstalled();
  step.record.secret = "sometimes";
  has(check([step]), "/record/secret");
  const missing = ghInstalled();
  delete missing.record.secret;
  has(check([missing]), "must have required property 'secret'");
});

test("an act has exactly one of verb, run and open_url, and a known consent class", () => {
  const two = ghAuth();
  two.act[0].open_url = "https://example.com";
  has(check([ghInstalled(), two]), "must match exactly one schema in oneOf");
  const none = ghInstalled();
  delete none.act[0].open_url;
  has(check([none]), "must match exactly one schema in oneOf");
  const odd = ghInstalled();
  odd.act[0].consent = "do-whatever";
  has(check([odd]), "must be equal to one of the allowed values");
});

test("an external-write act is refused, whatever the step says", () => {
  const step = ghInstalled();
  step.act[0].consent = "external-write";
  has(check([step]), "external-write, which setup refuses");
});

test("a team ledger record may not name or hold a path, username or secret", () => {
  const byKey = teamStep();
  byKey.record.fields = { clonePath: "x" };
  has(check([byKey]), "a team record field is named clonePath");
  const byValue = teamStep();
  byValue.record.fields = { note: "/home/user/code" };
  has(check([byValue]), "holds a path, a username or a secret");
  const byTemplate = teamStep();
  byTemplate.record.fields = { note: "{{probe.status.account}}" };
  has(check([byTemplate]), "holds a path, a username or a secret");
  // A team row names an input only when the step marks it shareable (#120 L3): an input can
  // be a folder or a login whatever its name is.
  const unmarked = teamStep();
  delete unmarked.inputs.team.shareable;
  has(check([unmarked]), "record uses {{team}}, an input not marked shareable");
  const inVerbOnly = teamStep();
  delete inVerbOnly.inputs.team.shareable;
  inVerbOnly.record.fields = { note: "done" };
  assert.deepEqual(check([inVerbOnly]), []);
  const disguised = teamStep();
  disguised.inputs = { team: { pattern: "^[a-z]+$" }, dest: { pattern: "^/.*$" } };
  disguised.record.fields = { created: "{{dest}}" };
  has(check([disguised]), "record uses {{dest}}, an input not marked shareable");
  // The same fields are fine in a machine row.
  const machine = teamStep();
  machine.record = { scope: "machine", fields: { clonePath: "{{team}}" }, secret: "never" };
  delete machine.inputs.team.shareable;
  assert.deepEqual(check([machine]), []);
});

test("needs must name earlier steps; the index and the files must agree", () => {
  has(
    check([ghAuth(), ghInstalled()]),
    "gh-auth needs gh-installed, which is not an earlier entry",
  );
  has(
    check([ghInstalled()], { index: INDEX_OF([ghInstalled(), { id: "ghost", title: "Ghost" }]) }),
    "setup/steps/ghost.yml: listed in index.yml but missing",
  );
  has(
    check([ghInstalled()], { extra: { "stray.yml": "id: stray\n" } }),
    "setup/steps/stray.yml: not listed in index.yml",
  );
  has(
    check([ghInstalled()], { index: INDEX_OF([{ ...ghInstalled(), title: "Another title" }]) }),
    "title differs from the index",
  );
  has(
    check([ghInstalled(), ghAuth()], {
      index: {
        step_format: 1,
        steps: [
          { id: "gh-installed", title: "Install gh" },
          { id: "gh-auth", title: "Sign in to GitHub with gh" },
        ],
      },
    }),
    "needs differ from the index",
  );
  has(
    check([ghInstalled()], {
      index: {
        step_format: 1,
        steps: [
          { id: "gh-installed", title: "Install gh" },
          { id: "gh-installed", title: "Install gh" },
        ],
      },
    }),
    "duplicate step gh-installed",
  );
});

test("the card, the acts and the probes agree", () => {
  const unknownAct = ghInstalled();
  unknownAct.ask.options[0].act = "nope";
  has(check([unknownAct]), "names unknown act nope");

  const noDecline = ghInstalled();
  noDecline.ask.options = [{ label: "Do it", act: "open" }];
  has(check([noDecline]), 'needs a "none" option');

  const noCard = ghInstalled();
  delete noCard.ask;
  has(check([noCard]), "needs an ask card");

  const badVerify = ghInstalled();
  badVerify.verify.probe = "nope";
  has(check([badVerify]), "verify names unknown probe nope");

  const twice = ghInstalled();
  twice.act.push({ ...twice.act[0] });
  has(check([twice]), "duplicate act id");
});

test("a command and its folder are fixed: no template at all, not even a probe result", () => {
  const step = teamStep();
  step.act = [
    {
      id: "create",
      consent: "local-write",
      what: "run it",
      where: "a terminal tab",
      why: "because",
      run: { cmd: "git init {{team}}", in: "terminal_tab" },
    },
  ];
  has(
    check([step]),
    "act create builds its command from {{team}}; a run command and its folder are fixed",
  );
  const probed = ghAuth();
  probed.act[0].run.cmd = "echo {{probe.status.account}}";
  has(check([ghInstalled(), probed]), "builds its command from {{probe.status.account}}");
  const folder = ghAuth();
  folder.act[0].run.cwd = "{{probe.repo.path}}";
  has(check([ghInstalled(), folder]), "builds its command from {{probe.repo.path}}");
  assert.deepEqual(check([ghInstalled(), ghAuth()]), []);
});

test("a read act neither runs a command nor calls a setup verb", () => {
  const runs = ghAuth();
  runs.act[0].consent = "read";
  has(check([ghInstalled(), runs]), `act ${runs.act[0].id} is read but runs a command`);
  const verb = teamStep();
  verb.act[0].consent = "read";
  has(check([verb]), `act ${verb.act[0].id} is read but calls create_team, a setup verb`);
});

test("a .yaml step file is reported, not skipped", () => {
  has(
    check([ghInstalled()], { extra: { "team.yaml": "id: team\n" } }),
    "setup/steps/team.yaml: a step file ends in .yml; this one is never read",
  );
});

test("a template must be an input or a probe result; an input pattern must compile and be anchored", () => {
  const step = teamStep();
  step.act[0].verb.args = { name: "{{who}}" };
  has(check([step]), "{{who}}, which is not an input or a probe result");
  const unanchored = teamStep();
  unanchored.inputs.team.pattern = "[a-z]+";
  has(check([unanchored]), "/inputs/team/pattern must match pattern");
  const broken = teamStep();
  broken.inputs.team.pattern = "^([a-z$";
  has(check([broken]), "not a regular expression");
});

test("stepRuleErrors on its own names the file it was given", () => {
  const step = ghInstalled();
  step.act[0].consent = "external-write";
  assert.ok(stepRuleErrors(step, "x.yml").every((e) => e.startsWith("x.yml:")));
});

test("the pack build refuses a pack whose step is bad, and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "guide-steps-pack-"));
  try {
    const copy = join(dir, "codesense-guide");
    cpSync(PACK, copy, { recursive: true });
    const bad = ghInstalled();
    delete bad.undo;
    writeFileSync(join(copy, "setup/steps/gh-installed.yml"), stringify(bad));
    writeFileSync(join(copy, "setup/steps/index.yml"), stringify(INDEX_OF([ghInstalled()])));
    const { errors, written } = buildPack(copy, { check: false });
    has(errors, "setup/steps/gh-installed.yml");
    assert.deepEqual(written, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the step schema describes step_format 1 and its index entries match", () => {
  const schema = JSON.parse(readFileSync(join(PACK, "setup/step.schema.json"), "utf8"));
  assert.deepEqual(schema.properties.step_format, { const: 1 });
  assert.deepEqual(schema.properties.record.properties.secret, { const: "never" });
  assert.deepEqual(schema.required, ["step_format", "id", "title", "summary", "record", "undo"]);
});

test("the setup-ledger collection: append-only for agents, no private facts in a team row", () => {
  const text = readFileSync(join(PACK, "setup/ledger/setup-ledger.yaml"), "utf8");
  const ledger = parse(text);
  assert.equal(ledger.collection, "setup-ledger");
  assert.equal(ledger.scope, "team");
  assert.deepEqual(ledger.humanOnly, ["delete"]);
  assert.ok(ledger.folder.startsWith("content/"));
  for (const required of ["title", "step", "state", "at"])
    assert.equal(ledger.fields[required].required, true, required);
  assert.deepEqual(ledger.fields.state.allowedValues, ["done", "failed", "stopped", "skipped"]);
  for (const name of Object.keys(ledger.fields))
    assert.ok(!/path|user|token|secret|password|credential/i.test(name), name);
  for (const field of Object.values(ledger.fields))
    assert.ok(["text", "number", "choice", "yes-no", "date"].includes(field.type));
});

test("the docs bundle carries the step index, the steps and the ledger schema", () => {
  const pairs = docsMapping(PACK, parse(readFileSync(join(PACK, "pack.yml"), "utf8")));
  const to = pairs.map((p) => p.to);
  assert.ok(to.includes("getting-started/content/guide/setup/steps/index.yml"));
  assert.ok(to.includes("getting-started/content/guide/setup/ledger/setup-ledger.yaml"));
});

test("then runs more acts on one click: same class, verbs only, no chains", () => {
  const withThen = () => {
    const step = teamStep();
    step.act[0].then = ["schema"];
    step.act.push({
      id: "schema",
      consent: "local-write",
      what: "write the setup log's schema",
      where: "your team",
      why: "so setup can be recorded",
      verb: { tool: "create_content_file", args: { path: "{{team}}" } },
    });
    return step;
  };
  assert.deepEqual(check([withThen()]), []);
  const unknown = withThen();
  unknown.act[0].then = ["nope"];
  has(check([unknown]), "act create then-runs unknown act nope");
  const self = withThen();
  self.act[0].then = ["create"];
  has(check([self]), "act create then-runs itself");
  const mixed = withThen();
  mixed.act[1].consent = "install-or-sign-in";
  has(check([mixed]), "act create then-runs schema, which has another consent class");
  const run = withThen();
  run.act[1] = { ...run.act[1], verb: undefined, run: { cmd: "echo hi", in: "terminal_tab" } };
  has(check([run]), "act create then-runs schema, which is not a verb act");
  const chain = withThen();
  chain.act[1].then = ["create"];
  has(check([chain]), "act schema then-runs create, but a then-act cannot chain");
});

test("repeat lets one click use a verb up to that many times, on a verb act only", () => {
  const many = teamStep();
  many.act[0].repeat = 5;
  assert.deepEqual(check([many]), []);
  const zero = teamStep();
  zero.act[0].repeat = 0;
  assert.ok(check([zero]).length > 0);
  const tooMany = teamStep();
  tooMany.act[0].repeat = 11;
  assert.ok(check([tooMany]).length > 0);
  const run = teamStep();
  run.act[0] = {
    id: "create",
    consent: "local-write",
    what: "x",
    where: "y",
    why: "z",
    run: { cmd: "echo hi", in: "terminal_tab" },
    repeat: 2,
  };
  has(check([run]), "act create repeats but has no verb");
});
