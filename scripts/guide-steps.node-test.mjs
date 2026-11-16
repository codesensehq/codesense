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

// Two steps in DESIGN section 4.1's shape, as data: one that checks and opens a page, one that runs
// a command and waits for it.
const toolStep = () => ({
  step_format: 1,
  id: "tool-check",
  title: "Check a tool",
  summary: "Checks that a tool is set up.",
  probe: [
    {
      id: "version",
      check: { tool: "probe_environment", envNames: ["EDITOR"] },
      map: { found: "done", none: "missing", unreadable: "unknown" },
    },
  ],
  ask: {
    text: "**Check it?** I'll open the download page.",
    options: [
      { label: "Do it", act: "open" },
      { label: "Not now", act: "none" },
    ],
  },
  act: [
    {
      id: "open",
      consent: "install-or-sign-in",
      what: "open the download page",
      where: "your browser",
      why: "so agents can use it as you",
      open_url: "https://example.com/download",
    },
  ],
  verify: { probe: "version", expect: "done" },
  record: { scope: "machine", fields: { tool: "editor" }, secret: "never" },
  undo: "Uninstall it the way you installed it.",
});

const runStep = () => ({
  step_format: 1,
  id: "tool-run",
  title: "Run a command",
  summary: "Runs one command and waits for it.",
  needs: ["tool-check"],
  when: { any_source_repo_host: "github.com" },
  probe: [
    {
      id: "status",
      check: { tool: "probe_environment", envNames: ["EDITOR"] },
      yields: { account: "gh_auth.account" },
      map: { found: "done", none: "missing", unreadable: "unknown" },
    },
  ],
  ask: {
    text: "**Run it?** It runs in a terminal tab you can watch.",
    options: [
      { label: "Do it", act: "sign-in" },
      { label: "Not now", act: "none" },
    ],
  },
  act: [
    {
      id: "sign-in",
      consent: "install-or-sign-in",
      what: "run git status",
      where: "a terminal tab on this Mac, then your browser",
      why: "so you can see it",
      run: {
        cmd: "git status",
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
  undo: "Nothing to undo.",
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
      map: { found: "done", none: "missing", unreadable: "unknown" },
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
  assert.deepEqual(check([toolStep(), runStep(), teamStep()]), []);
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
  const noUndo = toolStep();
  delete noUndo.undo;
  has(check([noUndo]), "must have required property 'undo'");
  has(check([{ ...toolStep(), surprise: true }]), "must NOT have additional properties");
  has(check([{ ...toolStep(), step_format: 2 }]), "must be equal to constant");
});

test("an id that is not [a-z0-9-], a missing record or a multi-line undo is refused", () => {
  has(check([{ ...toolStep(), id: "Gh_Installed" }]), "must match pattern");
  const noRecord = toolStep();
  delete noRecord.record;
  has(check([noRecord]), "must have required property 'record'");
  has(check([{ ...toolStep(), undo: "one\ntwo" }]), "/undo must match pattern");
});

test("secret: never is required, with that fixed value", () => {
  const step = toolStep();
  step.record.secret = "sometimes";
  has(check([step]), "/record/secret");
  const missing = toolStep();
  delete missing.record.secret;
  has(check([missing]), "must have required property 'secret'");
});

test("an act has exactly one of verb, run and open_url, and a known consent class", () => {
  const two = runStep();
  two.act[0].open_url = "https://example.com";
  has(check([toolStep(), two]), "must match exactly one schema in oneOf");
  const none = toolStep();
  delete none.act[0].open_url;
  has(check([none]), "must match exactly one schema in oneOf");
  const odd = toolStep();
  odd.act[0].consent = "do-whatever";
  has(check([odd]), "must be equal to one of the allowed values");
});

test("an external-write act is refused, whatever the step says", () => {
  const step = toolStep();
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
  // A probe value can be a path or a login whatever its field is called (orgRoot is a
  // folder), so a team row holds none at all.
  const byProbe = teamStep();
  byProbe.probe[0].yields = { root: "orgs[].orgRoot" };
  byProbe.record.fields = { created: "{{probe.teams.root}}" };
  has(check([byProbe]), "record uses {{probe.teams.root}}, a probe value; a team row holds none");
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
  has(check([runStep(), toolStep()]), "tool-run needs tool-check, which is not an earlier entry");
  has(
    check([toolStep()], { index: INDEX_OF([toolStep(), { id: "ghost", title: "Ghost" }]) }),
    "setup/steps/ghost.yml: listed in index.yml but missing",
  );
  has(
    check([toolStep()], { extra: { "stray.yml": "id: stray\n" } }),
    "setup/steps/stray.yml: not listed in index.yml",
  );
  has(
    check([toolStep()], { index: INDEX_OF([{ ...toolStep(), title: "Another title" }]) }),
    "title differs from the index",
  );
  has(
    check([toolStep(), runStep()], {
      index: {
        step_format: 1,
        steps: [
          { id: "tool-check", title: "Check a tool" },
          { id: "tool-run", title: "Run a command" },
        ],
      },
    }),
    "needs differ from the index",
  );
  has(
    check([toolStep()], {
      index: {
        step_format: 1,
        steps: [
          { id: "tool-check", title: "Check a tool" },
          { id: "tool-check", title: "Check a tool" },
        ],
      },
    }),
    "duplicate step tool-check",
  );
});

test("the card, the acts and the probes agree", () => {
  const unknownAct = toolStep();
  unknownAct.ask.options[0].act = "nope";
  has(check([unknownAct]), "names unknown act nope");

  const noDecline = toolStep();
  noDecline.ask.options = [{ label: "Do it", act: "open" }];
  has(check([noDecline]), 'needs a "none" option');

  const noCard = toolStep();
  delete noCard.ask;
  has(check([noCard]), "needs an ask card");

  const badVerify = toolStep();
  badVerify.verify.probe = "nope";
  has(check([badVerify]), "verify names unknown probe nope");

  const twice = toolStep();
  twice.act.push({ ...twice.act[0] });
  has(check([twice]), "duplicate act id");
});

test("a command and its folder are fixed: no probe result, and only an input a shell reads as a word", () => {
  const step = teamStep();
  step.inputs.team.pattern = "^.+$";
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
  const probed = runStep();
  probed.act[0].run.cmd = "echo {{probe.status.account}}";
  has(check([toolStep(), probed]), "builds its command from {{probe.status.account}}");
  const folder = runStep();
  folder.act[0].run.cwd = "{{probe.repo.path}}";
  has(check([toolStep(), folder]), "builds its command from {{probe.repo.path}}");
  assert.deepEqual(check([toolStep(), runStep()]), []);
});

test("a read act neither runs a command nor calls a setup verb", () => {
  const runs = runStep();
  runs.act[0].consent = "read";
  has(check([toolStep(), runs]), `act ${runs.act[0].id} is read but runs a command`);
  const verb = teamStep();
  verb.act[0].consent = "read";
  has(check([verb]), `act ${verb.act[0].id} is read but calls create_team, a setup verb`);
});

test("a .yaml step file is reported, not skipped", () => {
  has(
    check([toolStep()], { extra: { "team.yaml": "id: team\n" } }),
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
  const step = toolStep();
  step.act[0].consent = "external-write";
  assert.ok(stepRuleErrors(step, "x.yml").every((e) => e.startsWith("x.yml:")));
});

test("the pack build refuses a pack whose step is bad, and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "guide-steps-pack-"));
  try {
    const copy = join(dir, "codesense-guide");
    cpSync(PACK, copy, { recursive: true });
    const bad = toolStep();
    delete bad.undo;
    writeFileSync(join(copy, "setup/steps/tool-check.yml"), stringify(bad));
    writeFileSync(join(copy, "setup/steps/index.yml"), stringify(INDEX_OF([toolStep()])));
    const { errors, written } = buildPack(copy, { check: false });
    has(errors, "setup/steps/tool-check.yml");
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
    step.probe[0].yields = { root: "orgs[].orgRoot" };
    step.act[0].then = ["schema"];
    step.act.push({
      id: "schema",
      consent: "local-write",
      what: "write the setup log's schema",
      where: "your team",
      why: "so setup can be recorded",
      verb: {
        tool: "create_content_file",
        args: { path: "{{probe.teams.root}}/{{team}}/content/schema/setup-ledger.yaml" },
      },
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

test("a verb act may not call run_in_terminal_tab: a command goes in run, where it is fixed", () => {
  const step = teamStep();
  step.inputs.c = { pattern: "^.+$" };
  step.act[0].verb = { tool: "run_in_terminal_tab", args: { command: "{{c}}" } };
  step.act[0].repeat = 10;
  has(check([step]), "act create calls run_in_terminal_tab as a verb; a command goes in run");
  // The engine's clone_repo stays a verb: it checks its own arguments.
  const clone = teamStep();
  clone.act[0].verb = { tool: "clone_repo", args: { repo: "{{team}}" } };
  assert.deepEqual(check([clone]), []);
});

test("a probe yields only fields its tool returns, and takes only the tool's arguments", () => {
  const ok = teamStep();
  ok.probe[0].pick = { "orgs[].slug": { not: "codesense/docs" }, "orgs[].teams[].archived": false };
  ok.probe[0].yields = { org: "orgs[].slug", root: "orgs[].orgRoot", team: "orgs[].teams[].name" };
  ok.act[0].verb.args = { org: "{{probe.teams.org}}", name: "{{team}}" };
  assert.deepEqual(check([ok]), []);
  const made = teamStep();
  made.probe[0].yields = { dir: "orgs[].team_content_dir" };
  has(
    check([made]),
    "probe teams yields orgs[].team_content_dir, which describe_setup does not return",
  );
  const picked = teamStep();
  picked.probe[0].pick = { "orgs[].org": "x" };
  has(check([picked]), "probe teams picks on orgs[].org, which describe_setup does not return");
  const arg = teamStep();
  arg.probe[0].check.exclude_org = "codesense/docs";
  has(check([arg]), "probe teams passes exclude_org, which describe_setup does not take");
  const undeclared = teamStep();
  undeclared.act[0].verb.args = { org: "{{probe.teams.org}}", name: "{{team}}" };
  has(check([undeclared]), "uses {{probe.teams.org}}, which probe teams does not yield");
  const unknown = teamStep();
  unknown.act[0].verb.args = { org: "{{probe.nope.org}}", name: "{{team}}" };
  has(check([unknown]), "uses {{probe.nope.org}}, which probe nope does not yield");
  // records_list takes org, team and collection; a key it lacks is refused.
  const ledger = teamStep();
  ledger.probe = [
    { ...ok.probe[0] },
    {
      id: "row",
      check: {
        tool: "records_list",
        org: "{{probe.teams.org}}",
        team: "{{probe.teams.team}}",
        collection: "setup-ledger",
      },
      pick: { "rows[].fields.step": "team", "rows[].fields.state": "done" },
      map: { found: "done", none: "missing", unreadable: "unknown" },
    },
  ];
  assert.deepEqual(check([ledger]), []);
  ledger.probe[1].check.step = "team";
  has(check([ledger]), "probe row passes step, which records_list does not take");
  // A probe's arguments may use an earlier probe only.
  const later = teamStep();
  later.probe = [{ ...ledger.probe[1], check: { ...ledger.probe[1].check } }, ok.probe[0]];
  delete later.probe[0].check.step;
  has(check([later]), "probe row uses {{probe.teams.org}}, which no earlier probe yields");
});

test("a probe maps what it can read: its outcomes, or its field's values, and all of them", () => {
  assert.deepEqual(check([teamStep()]), []);
  const stray = teamStep();
  stray.probe[0].map.some = "done";
  has(check([stray]), "probe teams maps some, which it never reads (found, none, unreadable)");
  const short = teamStep();
  delete short.probe[0].map.unreadable;
  has(check([short]), "probe teams does not map unreadable");
  // A yielded field whose values the registry lists is mapped value by value, in place of found.
  const valued = teamStep();
  valued.probe[0].yields = { attachment: "orgs[].teams[].sourceRepos[].attachment" };
  valued.probe[0].map = {
    attached: "done",
    unattached: "done",
    none: "missing",
    unreadable: "unknown",
  };
  has(check([valued]), "probe teams does not map missing");
  valued.probe[0].map.missing = "partial";
  assert.deepEqual(check([valued]), []);
  valued.probe[0].map.found = "done";
  has(check([valued]), "probe teams maps found, which it never reads");
});

test("a probe's argument is an earlier probe's value or an input", () => {
  const s = teamStep();
  s.probe.push({
    id: "epic",
    check: { tool: "read_epic_repos", epicFilePath: "/x/{{product}}/README.md" },
    map: { found: "done", none: "missing", unreadable: "missing" },
  });
  has(check([s]), "probe epic uses {{product}}, which is not an input or a probe result");
  s.inputs.product = { pattern: "^[a-z]+$", shareable: true };
  assert.deepEqual(check([s]), []);
});

test("verify names one probe or several, each a probe of the step", () => {
  const s = teamStep();
  s.verify = { probe: ["teams"], expect: "done" };
  assert.deepEqual(check([s]), []);
  s.verify.probe = ["teams", "nope"];
  has(check([s]), "verify names unknown probe nope");
  s.verify.probe = [];
  assert.ok(check([s]).length > 0, "an empty list is refused");
});

test("a write's path starts from a probe value, never a relative or bare path", () => {
  const write = (path) => {
    const step = teamStep();
    step.probe[0].yields = { root: "orgs[].orgRoot", team: "orgs[].teams[].name" };
    step.act[0].verb = { tool: "create_content_file", args: { path, content: "x" } };
    return check([step]);
  };
  assert.deepEqual(write("{{probe.teams.root}}/{{probe.teams.team}}/content/a.md"), []);
  for (const bad of [
    "content/a.md",
    "/home/user/a.md",
    "{{team}}/content/a.md",
    "a/{{probe.teams.root}}",
  ])
    has(write(bad), "create_content_file path must start with a {{probe.…}} value");
  const epic = teamStep();
  epic.inputs.repos = { pattern: "^[a-z]+/[a-z]+$", list: true };
  epic.act[0].verb = {
    tool: "set_epic_repos",
    args: { epicFilePath: "x/README.md", repos: "{{repos}}" },
  };
  has(check([epic]), "set_epic_repos epicFilePath must start with a {{probe.…}} value");
});

test("a list input is passed whole, as the list, never inside a longer string", () => {
  const step = (repos) => {
    const s = teamStep();
    s.probe[0].yields = { root: "orgs[].orgRoot" };
    s.inputs.repos = { pattern: "^[a-z]+/[a-z]+$", list: true, shareable: true };
    s.act[0].verb = {
      tool: "set_epic_repos",
      args: { epicFilePath: "{{probe.teams.root}}/web/content/p/README.md", repos },
    };
    return s;
  };
  assert.deepEqual(check([step("{{repos}}")]), []);
  has(check([step("{{repos}},acme/extra")]), 'input repos is a list; pass it whole as "{{repos}}"');
  const inRow = step("{{repos}}");
  inRow.record.fields = { created: "repos {{repos}}" };
  has(check([inRow]), 'input repos is a list; pass it whole as "{{repos}}"');
});

test("a probe on a tool the registry doesn't list is a lint error", () => {
  const step = teamStep();
  step.probe[0].check = { tool: "list_machines" };
  has(
    check([step]),
    "probe teams uses list_machines, which is not in the probe registry; add it from its Rust",
  );
  assert.deepEqual(check([teamStep()]), []);
});
