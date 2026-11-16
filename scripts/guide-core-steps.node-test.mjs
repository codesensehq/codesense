// SPDX-License-Identifier: MIT
// The guide's core setup steps: context-repo, team, product and source-repos. These tests
// hold what the design asks of every one of them (explicit org and team, one card, nothing
// written on Not now, safe to run again) against the files themselves.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { PACKS_ROOT, buildPack } from "./pack-build.mjs";
import { PROBE_TOOLS, SETUP_VERBS, stepErrors } from "./lib/pack-steps.mjs";

const PACK = join(PACKS_ROOT, "codesense-guide");
const BASE = ["context-repo", "team", "product", "source-repos"];
const IDS = [...BASE, "git-access", "clone"];
const step = (id) => parse(readFileSync(join(PACK, `setup/steps/${id}.yml`), "utf8"));
const index = () => parse(readFileSync(join(PACK, "setup/steps/index.yml"), "utf8"));
const allActs = () => IDS.flatMap((id) => step(id).act.map((act) => ({ id, act })));

// The verbs a core step may call, and the arguments that must name the user's own org, team
// or a path in that team. A verb not listed here is not one a core step uses.
const WRITES = {
  create_local_organization: {},
  attach_context_repository: {},
  create_team: { org: "org" },
  set_active_team: { org: "org", team: "team" },
  add_source_repo: { org: "org", team: "team" },
  attach_source_repo_path: { org: "org", team: "team" },
  clone_repo: { org: "org", team: "team" },
  create_content_file: { path: "path" },
  set_epic_repos: { epicFilePath: "path" },
};
// What each kind of argument must be built from: the describe_setup field it is read from.
const FROM = { org: "orgs[].slug", team: "orgs[].teams[].name", root: "orgs[].orgRoot" };
const NOT_DOCS = { "orgs[].slug": { not: "codesense/docs" } };

/** The probe value `{{probe.<id>.<name>}}` names: its probe and the field it yields. */
function probed(s, template) {
  const m = /^\{\{probe\.([a-z0-9-]+)\.([a-z_]+)\}\}$/.exec(template);
  const probe = m && s.probe.find((p) => p.id === m[1]);
  return probe && { probe, field: probe.yields?.[m[2]] };
}

test("every write names the user's org and team from describe_setup, never the docs team", () => {
  for (const { id, act } of allActs()) {
    if (!act.verb) continue;
    const s = step(id);
    const tool = act.verb.tool;
    const named = WRITES[tool];
    assert.ok(named, `${id}/${act.id} calls ${tool}, which no core step may use`);
    for (const [arg, kind] of Object.entries(named)) {
      const value = act.verb.args?.[arg];
      assert.ok(value, `${id}/${act.id}: ${tool} needs ${arg}`);
      // A path is the team's content folder as the app lays it out, `<orgRoot>/<team>/content`
      // (context_repo::path_to_team_content_dir), from the probed org root.
      const [head, team, content] = kind === "path" ? value.split("/") : [value];
      const from = probed(s, head);
      assert.ok(from, `${id}/${act.id}: ${arg} starts from a probe value, got ${value}`);
      assert.equal(from.probe.check.tool, "describe_setup", `${id}/${act.id}: ${arg}`);
      assert.equal(from.field, FROM[kind === "path" ? "root" : kind], `${id}/${act.id}: ${arg}`);
      assert.deepEqual(from.probe.pick?.["orgs[].slug"], NOT_DOCS["orgs[].slug"], `${id}: picks`);
      if (kind === "path") {
        assert.ok(team === "{{team}}" || probed(s, team)?.field === FROM.team, `${id}: ${value}`);
        assert.equal(content, "content", `${id}/${act.id}: ${value}`);
      }
    }
    assert.ok(
      !/codesense\/docs|getting-started/.test(JSON.stringify(act.verb.args ?? {})),
      `${id}/${act.id} names the docs team`,
    );
  }
});

test("a probe reads what its tool returns, with the user's org and team for the ledger", () => {
  for (const id of IDS)
    for (const probe of step(id).probe)
      assert.ok(PROBE_TOOLS[probe.check.tool], `${id}: probe ${probe.id} uses a known tool`);
  const ledger = step("product").probe.find((p) => p.check.tool === "records_list");
  assert.deepEqual(ledger.check, {
    tool: "records_list",
    org: "{{probe.teams.org}}",
    team: "{{probe.teams.team}}",
    collection: "setup-ledger",
  });
  assert.deepEqual(ledger.pick, { "rows[].fields.step": "product", "rows[].fields.state": "done" });
});

test("no base step clones, runs a command, writes outside or skips its card", () => {
  for (const { id, act } of allActs().filter((a) => BASE.includes(a.id))) {
    assert.notEqual(act.verb?.tool, "clone_repo", `${id}/${act.id}`);
    assert.ok(!act.run && !act.open_url, `${id}/${act.id} is a verb act`);
    assert.equal(act.consent, "local-write", `${id}/${act.id}`);
    if (act.verb) assert.ok(SETUP_VERBS.includes(act.verb.tool), act.verb.tool);
  }
  for (const id of IDS) assert.ok(step(id).ask, `${id} has a card`);
});

test("each step asks one card, and Not now writes nothing", () => {
  for (const id of IDS) {
    const { ask, act } = step(id);
    const none = ask.options.filter((o) => o.act === "none");
    assert.equal(none.length, 1, `${id} has one Not now`);
    assert.equal(none[0].label, "Not now");
    // Every other option names an act, and no act is reachable from Not now.
    for (const option of ask.options.filter((o) => o.act !== "none"))
      assert.ok(
        act.some((a) => a.id === option.act),
        `${id}: ${option.label}`,
      );
    // git-access offers one button per way to reach the host (frame E), the rest at most three.
    assert.ok(ask.options.length <= (id === "git-access" ? 5 : 3), `${id} offers few buttons`);
  }
});

test("a step checks first: its probe can say done, and verify expects done", () => {
  for (const id of IDS) {
    const s = step(id);
    assert.ok(s.probe?.length, `${id} probes first`);
    assert.ok(
      s.probe.some((p) => Object.values(p.map).includes("done")),
      `${id} can find itself done, so a re-run skips it`,
    );
    assert.equal(s.verify.expect, "done", id);
    assert.equal(s.record.secret, "never");
  }
});

test("one up-front card makes the context repo, the first team and the setup log together", () => {
  const { act, ask } = step("context-repo");
  const create = act.find((a) => a.id === "create-local-organization");
  assert.deepEqual(create.then, ["create-team", "write-ledger-schema"]);
  assert.match(ask.text, /^\*\*Create your team folder\?\*\*/);
  assert.ok(ask.options.some((o) => o.act === "create-local-organization"));
  assert.ok(ask.options.some((o) => o.act === "attach-context-repository"));
  // The same two follow-on acts are the team step's, for a context repo that already exists.
  const team = step("team").act.find((a) => a.id === "create-team");
  assert.deepEqual(team.then, ["write-ledger-schema"]);
  // The two steps' copies are the same acts, but for the probe each reads.
  const same = (id, name) => {
    const s = step(id);
    const act = s.act.find((a) => a.id === name);
    return JSON.parse(JSON.stringify(act).replaceAll(`{{probe.${s.probe[0].id}.`, "{{probe.P."));
  };
  for (const name of ["create-team", "write-ledger-schema"])
    assert.deepEqual(same("context-repo", name).verb, same("team", name).verb, name);
  assert.deepEqual(
    same("context-repo", "write-ledger-schema"),
    same("team", "write-ledger-schema"),
  );
});

test("the cards say what happens to a remote context repo: nothing is committed or pushed", () => {
  // The four verbs leave their edits in the context repo's folder, uncommitted; nothing in the
  // app commits, pushes or opens a pull request for them (registry_local.rs, files.rs).
  for (const id of IDS) {
    const { text } = step(id).ask;
    assert.doesNotMatch(text, /pull request/i, id);
  }
  for (const id of ["context-repo", "team", "product", "source-repos"])
    assert.match(step(id).ask.text, /nothing is committed or pushed/i, id);
});

test("a new team becomes the active team, so the setup log's schema lands in it", () => {
  for (const id of ["context-repo", "team"]) {
    const create = step(id).act.find((a) => a.id === "create-team");
    assert.equal(create.verb.args.activate, true, id);
    assert.match(step(id).ask.text, /switch CodeSense to it/, id);
  }
});

test("the setup log's schema is written to the user's team from the pack's own file", () => {
  for (const id of ["context-repo", "team"]) {
    const write = step(id).act.find((a) => a.id === "write-ledger-schema");
    assert.equal(write.verb.tool, "create_content_file");
    assert.match(
      write.verb.args.path,
      /^\{\{probe\.[a-z-]+\.org_root\}\}\/\{\{team\}\}\/content\/schema\/setup-ledger\.yaml$/,
    );
    assert.equal(write.verb.args.onCollision, "fail");
    const source = write.verb.args.content_from;
    assert.equal(source, "guide/setup/ledger/setup-ledger.yaml");
    assert.ok(existsSync(join(PACK, source.replace(/^guide\//, ""))));
  }
});

test("the product step writes a ledger row and one epic with its repos, as the interim", () => {
  const s = step("product");
  const switchTeam = s.act.find((a) => a.id === "create-epic");
  assert.equal(switchTeam.verb.tool, "set_active_team");
  assert.deepEqual(switchTeam.then, ["write-epic", "set-epic-repos"]);
  assert.match(s.ask.text, /switch CodeSense to your team/);
  const create = s.act.find((a) => a.id === "write-epic");
  assert.equal(create.verb.tool, "create_content_file");
  assert.match(create.verb.args.content, /^---\ntype: epic\n/);
  const set = s.act.find((a) => a.id === "set-epic-repos");
  assert.equal(set.verb.tool, "set_epic_repos");
  assert.equal(set.verb.args.epicFilePath, create.verb.args.path);
  // set_epic_repos takes the full list of owner/repo; the input is that list, one per entry.
  assert.equal(set.verb.args.repos, "{{repos}}");
  assert.equal(s.inputs.repos.list, true);
  const one = new RegExp(s.inputs.repos.pattern);
  assert.ok(one.test("acme/api") && !one.test("acme/api, acme/web"));
  assert.equal(s.record.scope, "team");
  assert.match(s.record.fields.created, /product/);
});

test("the source-repos step adds each repo on one click and keeps clone folders out of team rows", () => {
  const s = step("source-repos");
  const add = s.act.find((a) => a.id === "add-source-repo");
  assert.equal(add.verb.tool, "add_source_repo");
  assert.ok(add.repeat > 1);
  const bind = s.act.find((a) => a.id === "attach-source-repo-path");
  assert.equal(bind.verb.tool, "attach_source_repo_path");
  assert.ok(!bind.repeat);
  assert.equal(s.record.scope, "team");
  assert.ok(!/\{\{path\}\}/.test(JSON.stringify(s.record)));
  assert.ok(!s.inputs.path.shareable);
});

test("a team row names only shareable inputs, and the paths stay private", () => {
  for (const id of IDS) {
    const s = step(id);
    for (const [name, spec] of Object.entries(s.inputs ?? {}))
      if (/path/.test(name)) assert.ok(!spec.shareable, `${id}: ${name}`);
    assert.equal(s.record.scope, "team", id);
    assert.ok(!/\/(?:Users|home)\//.test(JSON.stringify(s)), id);
  }
});

// The step table: what each step's verify probes read before its card, after each act its card
// offers, and in a new session that knows none of the inputs yet. Before, no verify probe says
// done, so the card is offered; after each act and on a re-run one does, so verify passes and
// the step is skipped. A probe the row leaves out reads `none`.
const TABLE = {
  "context-repo": {
    before: [{ orgs: "none" }],
    after: {
      "create-local-organization": { orgs: "found" },
      "attach-context-repository": { orgs: "found" },
    },
    calls: {
      "create-local-organization": [
        "create_local_organization",
        "create_team",
        "create_content_file",
      ],
      "attach-context-repository": ["attach_context_repository"],
    },
    rerun: { orgs: "found" },
  },
  team: {
    // No team yet, so the ledger probe has no team to read; or a team with no setup log.
    before: [{}, { ledger: "unreadable" }],
    after: { "create-team": { ledger: "found" }, "add-ledger-schema": { ledger: "found" } },
    calls: {
      "create-team": ["create_team", "create_content_file"],
      "add-ledger-schema": ["set_active_team", "create_content_file"],
    },
    rerun: { ledger: "found" },
  },
  product: {
    // The ledger row is written after verify, so verify reads the epic; a new session doesn't
    // know the product's name, so it reads the row.
    before: [{}, { epic: "unreadable" }],
    after: { "create-epic": { epic: "found" } },
    calls: { "create-epic": ["set_active_team", "create_content_file", "set_epic_repos"] },
    rerun: { product: "found" },
  },
  "source-repos": {
    before: [{}, { repos: "missing" }],
    after: {
      "add-source-repo": { repos: "unattached" },
      "attach-source-repo-path": { repos: "attached" },
    },
    calls: {
      "add-source-repo": ["add_source_repo"],
      "attach-source-repo-path": ["attach_source_repo_path"],
    },
    rerun: { repos: "unattached" },
  },
  // Done by the file it writes, never by the read that gates the write.
  "git-access": {
    before: [{}, { note: "unreadable" }, { note: "none" }],
    after: Object.fromEntries(
      ["check-credentials", "check-gh-cli", "check-mcp-server", "check-token-tool"].map((a) => [
        a,
        { note: "found" },
      ]),
    ),
    // The read gates the write; the write goes to the team the `team` step switched to (this
    // step needs it, and reads the same org and team), so it doesn't switch again.
    calls: Object.fromEntries(
      ["check-credentials", "check-gh-cli", "check-mcp-server", "check-token-tool"].map((a) => [
        a,
        ["run_in_terminal_tab", "create_content_file"],
      ]),
    ),
    relies: "team",
    rerun: { note: "found" },
  },
  // One repo with no clone keeps the step open; a bound clone that is gone is missing again.
  clone: {
    before: [{}, { repos: "unattached" }, { repos: "missing" }],
    after: { "clone-repo": { repos: "attached" }, "bind-clone": { repos: "attached" } },
    calls: { "clone-repo": ["clone_repo"], "bind-clone": ["attach_source_repo_path"] },
    rerun: { repos: "attached" },
  },
};
/** Whether `id` needs `target`, directly or through the steps it needs. */
function needsStep(id, target) {
  const needs = index().steps.find((e) => e.id === id)?.needs ?? [];
  return needs.includes(target) || needs.some((n) => needsStep(n, target));
}
const RANK = ["unknown", "missing", "partial", "done"];

/** The step's state from what its verify probes read: the most-done of them. */
function stateOf(s, reads) {
  return [s.verify.probe]
    .flat()
    .map((id) => s.probe.find((p) => p.id === id).map[reads[id] ?? "none"])
    .reduce((a, b) => (RANK.indexOf(a) >= RANK.indexOf(b) ? a : b));
}

test("the step table: each card is offered until done, each act ends done, and a re-run skips it", () => {
  assert.deepEqual(Object.keys(TABLE), IDS);
  for (const id of IDS) {
    const s = step(id);
    const row = TABLE[id];
    for (const reads of row.before)
      assert.notEqual(stateOf(s, reads), "done", `${id} before ${JSON.stringify(reads)}`);
    const acts = s.ask.options.filter((o) => o.act !== "none").map((o) => o.act);
    assert.deepEqual(Object.keys(row.after).sort(), acts.sort(), `${id}: every card act has a row`);
    for (const [act, reads] of Object.entries(row.after))
      assert.equal(stateOf(s, reads), s.verify.expect, `${id}/${act} ends ${s.verify.expect}`);
    assert.equal(stateOf(s, row.rerun), "done", `${id}: a re-run skips it`);
    // The verbs one click runs, in order: a write into the team comes after the switch to it.
    for (const act of acts) {
      const own = s.act.find((a) => a.id === act);
      const chain = [own, ...(own.then ?? []).map((n) => s.act.find((a) => a.id === n))];
      assert.deepEqual(
        chain.map((a) => a.verb?.tool ?? "run_in_terminal_tab"),
        row.calls[act],
        `${id}/${act}`,
      );
      const write = chain.findIndex((a) =>
        ["create_content_file", "set_epic_repos"].includes(a.verb?.tool),
      );
      const switched = chain.findIndex(
        (a) => a.verb?.tool === "set_active_team" || a.verb?.args?.activate === true,
      );
      if (write >= 0 && !row.relies)
        assert.ok(switched >= 0 && switched < write, `${id}/${act} switches team before it writes`);
      if (write >= 0 && row.relies) {
        // No switch of its own: the write's team is the one the `team` step made active.
        assert.equal(switched, -1, `${id}/${act} relies on ${row.relies}, so it doesn't switch`);
        assert.ok(needsStep(id, row.relies), `${id} needs ${row.relies}`);
        assert.match(
          chain[write].verb.args.path,
          /^\{\{probe\.repos\.org_root\}\}\/\{\{probe\.repos\.team\}\}\/content\//,
        );
        const probe = s.probe.find((p) => p.id === "repos");
        const theirs = step(row.relies).probe.find((p) => p.id === "teams");
        assert.deepEqual(
          probe.pick,
          theirs.pick,
          `${id} reads the same org and team as ${row.relies}`,
        );
        assert.equal(probe.yields.org_root, theirs.yields.org_root);
        assert.equal(probe.yields.team, theirs.yields.team);
      }
    }
  }
});

test("the team step adds the setup log to a team that has none, and is done only with one", () => {
  const s = step("team");
  const ledger = s.probe.find((p) => p.id === "ledger");
  assert.deepEqual(ledger.check, {
    tool: "records_list",
    org: "{{probe.teams.org}}",
    team: "{{probe.teams.team}}",
    collection: "setup-ledger",
  });
  // records_list fails with "unknown collection" until the schema file exists.
  assert.equal(ledger.map.unreadable, "partial");
  assert.equal(s.verify.probe, "ledger");
  const add = s.act.find((a) => a.id === "write-existing-ledger-schema");
  const write = s.act.find((a) => a.id === "write-ledger-schema");
  assert.equal(
    add.verb.args.path,
    "{{probe.teams.org_root}}/{{probe.teams.team}}/content/schema/setup-ledger.yaml",
  );
  assert.deepEqual({ ...add.verb.args, path: "" }, { ...write.verb.args, path: "" });
  assert.ok(!add.then, "adding the log creates no team");
  // The click switches CodeSense to the person's team first (create_content_file writes into
  // the active team), and the card and the act both say so.
  const first = s.act.find((a) => a.id === "add-ledger-schema");
  assert.deepEqual(first.verb, {
    tool: "set_active_team",
    args: { org: "{{probe.teams.org}}", team: "{{probe.teams.team}}" },
  });
  assert.deepEqual(first.then, ["write-existing-ledger-schema"]);
  assert.match(first.what, /switch CodeSense to the team you already have/);
  assert.ok(s.ask.options.some((o) => o.act === "add-ledger-schema"));
  assert.match(s.ask.text, /no setup log, I'll switch CodeSense to it and add only the log/);
});

test("the product step verifies its epic, which it can read before the ledger row is written", () => {
  const s = step("product");
  const create = s.act.find((a) => a.id === "write-epic");
  const epic = s.probe.find((p) => p.id === "epic");
  assert.deepEqual(epic.check, { tool: "read_epic_repos", epicFilePath: create.verb.args.path });
  assert.deepEqual([s.verify.probe].flat().sort(), ["epic", "product"]);
});
