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
import { SETUP_VERBS, stepErrors } from "./lib/pack-steps.mjs";

const PACK = join(PACKS_ROOT, "codesense-guide");
const IDS = ["context-repo", "team", "product", "source-repos"];
const step = (id) => parse(readFileSync(join(PACK, `setup/steps/${id}.yml`), "utf8"));
const index = () => parse(readFileSync(join(PACK, "setup/steps/index.yml"), "utf8"));
const allActs = () => IDS.flatMap((id) => step(id).act.map((act) => ({ id, act })));

// The verbs a core step may call, with the arguments that must name the user's own org or
// team. A verb not listed here is not one a core step uses.
const WRITES = {
  create_local_organization: [],
  attach_context_repository: [],
  create_team: ["org"],
  add_source_repo: ["org", "team"],
  attach_source_repo_path: ["org", "team"],
  create_content_file: ["path"],
  set_epic_repos: ["epicFilePath"],
};

test("the four core steps are listed in order, each validated by the pack's step checks", () => {
  assert.deepEqual(
    index().steps.map((s) => s.id),
    IDS,
  );
  assert.deepEqual(stepErrors(PACK), []);
  assert.deepEqual(buildPack(PACK, { check: true }).errors, []);
  assert.deepEqual(index().steps.find((s) => s.id === "team").needs, ["context-repo"]);
  assert.deepEqual(index().steps.find((s) => s.id === "product").needs, ["team"]);
  assert.deepEqual(index().steps.find((s) => s.id === "source-repos").needs, ["team"]);
});

test("every write names the user's org and team, never the docs team", () => {
  for (const { id, act } of allActs()) {
    if (!act.verb) continue;
    const tool = act.verb.tool;
    const named = WRITES[tool];
    assert.ok(named, `${id}/${act.id} calls ${tool}, which no core step may use`);
    for (const arg of named) {
      const value = act.verb.args?.[arg];
      assert.ok(value, `${id}/${act.id}: ${tool} needs ${arg}`);
      assert.match(value, /\{\{/, `${id}/${act.id}: ${arg} must come from an input or a probe`);
    }
    assert.ok(
      !/codesense\/docs|getting-started/.test(JSON.stringify(act.verb.args ?? {})),
      `${id}/${act.id} names the docs team`,
    );
  }
});

test("no core step clones, runs a command, writes outside or skips its card", () => {
  for (const { id, act } of allActs()) {
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
    assert.ok(ask.options.length <= 3, `${id} offers at most three buttons`);
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
});

test("a remote context repo goes by pull request, and the card says so", () => {
  for (const id of ["context-repo", "team", "product"])
    assert.match(step(id).ask.text, /pull request/i, id);
});

test("the setup log's schema is written to the user's team from the pack's own file", () => {
  for (const id of ["context-repo", "team"]) {
    const write = step(id).act.find((a) => a.id === "write-ledger-schema");
    assert.equal(write.verb.tool, "create_content_file");
    assert.match(
      write.verb.args.path,
      /^\{\{probe\.[a-z-]+\.team_content_dir\}\}\/schema\/setup-ledger\.yaml$/,
    );
    assert.equal(write.verb.args.onCollision, "fail");
    const source = write.verb.args.content_from;
    assert.equal(source, "guide/setup/ledger/setup-ledger.yaml");
    assert.ok(existsSync(join(PACK, source.replace(/^guide\//, ""))));
  }
});

test("the product step writes a ledger row and one epic with its repos, as the interim", () => {
  const s = step("product");
  const create = s.act.find((a) => a.id === "create-epic");
  assert.deepEqual(create.then, ["set-epic-repos"]);
  assert.equal(create.verb.tool, "create_content_file");
  assert.match(create.verb.args.content, /^---\ntype: epic\n/);
  const set = s.act.find((a) => a.id === "set-epic-repos");
  assert.equal(set.verb.tool, "set_epic_repos");
  assert.equal(set.verb.args.epicFilePath, create.verb.args.path);
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
