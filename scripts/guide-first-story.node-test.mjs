// SPDX-License-Identifier: MIT
// The guide's `first-story` step: one consent card before anything is created, a story that
// `validate_story` passes, in a repo the team tracks, written to the person's own team, and a
// re-run that offers a new story and never writes over one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parseNext } from "../src-tauri/src/http/routes/dashboard_kit/chat/chat-core.js";
import { PACKS_ROOT, buildPack } from "./pack-build.mjs";
import { stepRuleErrors } from "./lib/pack-steps.mjs";
import { checkConsent, stepActVerbs, turnsOf } from "./setup-consent-check.mjs";

const PACK = join(PACKS_ROOT, "codesense-guide");
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(join(PACK, path), "utf8");
const step = () => parse(read("setup/steps/first-story.yml"));
const act = (id) => step().act.find((a) => a.id === id);

test("the index lists first-story after clone, and the pack builds clean", () => {
  const { steps } = parse(read("setup/steps/index.yml"));
  const ids = steps.map((s) => s.id);
  assert.equal(ids.at(-1), "first-story");
  assert.ok(ids.indexOf("first-story") > ids.indexOf("clone"));
  assert.deepEqual(steps.at(-1).needs, ["clone"]);
  assert.deepEqual(stepRuleErrors(step(), "first-story.yml"), []);
  assert.deepEqual(buildPack(PACK, { check: true }).errors, []);
});

test("one live consent card: What / Where / Why in its text, Do it and Not now, and Not now writes nothing", () => {
  const s = step();
  assert.deepEqual(
    s.ask.options.map((o) => [o.label, o.act]),
    [
      ["Do it", "create-story"],
      ["Not now", "none"],
    ],
  );
  const create = act("create-story");
  assert.equal(create.consent, "local-write");
  // The kit shows a card's text and buttons only, so the card's text carries the act's own words.
  for (const key of ["what", "where", "why"]) {
    assert.ok(create[key]?.length > 10, key);
    const label = key[0].toUpperCase() + key.slice(1);
    assert.ok(
      s.ask.text.split("\n").includes(`${label}: ${create[key]}`),
      `the card's text has its ${label} line, as the act says it`,
    );
  }
  // One write in the click, and nothing opens from the guide: the page opens the story.
  assert.equal(create.then, undefined);
  assert.deepEqual(
    s.act.filter((a) => a.consent !== "read").map((a) => a.id),
    ["create-story"],
  );
  assert.ok(s.act.every((a) => a.verb?.tool !== "open_workspace"));
  assert.doesNotMatch(read("setup/steps/first-story.yml"), /open_workspace/);
  assert.match(s.ask.text, /nothing is created until you click/i);
});

test("validate_story runs first on the very content that is written, and must come back clean", () => {
  const validate = act("validate-story");
  assert.equal(validate.consent, "read");
  assert.equal(validate.verb.tool, "validate_story");
  const create = act("create-story");
  assert.equal(validate.verb.args.content, create.verb.args.content);
  assert.equal(validate.verb.args.path, create.verb.args.path);
  assert.match(step().ask.text, /validate_story/);
  assert.match(step().ask.text, /nothing is created unless it comes back clean/i);
});

test("the story names a repo the team tracks, read from the team's own listing", () => {
  const s = step();
  const create = act("create-story");
  const probe = s.probe.find((p) => p.id === "repos");
  assert.equal(probe.check.tool, "describe_setup");
  assert.deepEqual(probe.pick, {
    "orgs[].slug": { not: "codesense/docs" },
    "orgs[].teams[].archived": false,
  });
  assert.equal(probe.yields.repo, "orgs[].teams[].sourceRepos[].slug");
  assert.match(create.verb.args.content, /\nsource_repo: \{\{probe\.repos\.repo\}\}\n/);
  assert.match(
    create.verb.args.content,
    /^---\ntype: story\nstatus: todo\nstory_id: \{\{story_id\}\}\n/,
  );
  assert.match(create.verb.args.content, /\n## Purpose\n\n\S/);
});

test("every write names the user's own org and team, never the docs team", () => {
  const args = act("create-story").verb.args;
  assert.equal(
    args.path,
    "{{probe.repos.org_root}}/{{probe.repos.team}}/content/stories/{{story_id}}.md",
  );
  assert.doesNotMatch(read("setup/steps/first-story.yml"), /codesense\/docs"?\s*[,}]?\s*$/m);
});

test("a re-run offers a new story and never writes over one", () => {
  const s = step();
  assert.equal(act("create-story").verb.args.onCollision, "fail");
  assert.match(s.inputs.story_id.pattern, /^\^/);
  assert.ok(new RegExp(s.inputs.story_id.pattern).test("ACME-2"));
  assert.ok(!new RegExp(s.inputs.story_id.pattern).test("../x"));
  assert.match(s.ask.text, /another story/i);
  assert.match(s.ask.text, /never (?:changes|writes over) one you have/i);
  assert.deepEqual(s.verify.probe, ["story", "file"]);
  assert.equal(s.verify.expect, "done");
  // The title lands in a quoted heading, so it can hold no quote, newline or colon-space.
  const title = new RegExp(s.inputs.title.pattern);
  assert.ok(title.test("Fix the login bug"));
  for (const bad of ['a"b', "a\nb", "a\\b", "#x", ""]) assert.ok(!title.test(bad), bad);
});

test("the page opens the story, so the card promises the page's own reason and never its own", () => {
  const text = step().ask.text;
  assert.match(text, /this page opens the story/i);
  assert.match(text, /plain markdown with the reason/i);
  assert.doesNotMatch(text, /I'll say so/);
});

test("a failed create offers a new id or a skip, and says nothing was written", () => {
  const { on_fail } = step();
  assert.deepEqual(
    on_fail.options.map((o) => o.do),
    ["retry", "skip"],
  );
  assert.match(on_fail.text, /nothing was written/i);
  assert.match(on_fail.text, /\{\{story_id\}\}/);
});

test("the chip: the guide offers `Start my first story`, and the page's Next: parser reads it", () => {
  const command = read("commands/codesense-setup.md");
  assert.match(command, /`Start my first story`/);
  assert.ok(command.length < 4500, `${command.length} bytes`);
  assert.deepEqual(parseNext("Done.\n\nNext: `Start my first story`, `What have you set up?`"), {
    text: "Done.",
    chips: ["Start my first story", "What have you set up?"],
  });
});

const GUIDE = { actVerbs: stepActVerbs(PACK) };
const load = (name) =>
  JSON.parse(readFileSync(join(HERE, "fixtures/consent", `${name}.json`), "utf8"));

test("a first-story session passes: card, click, validate, create", () => {
  const { errors, calls } = checkConsent(load("first-story"), GUIDE);
  assert.deepEqual(errors, []);
  assert.equal(calls, 1);
});

test("a create before the click fails, and so does a story in a repo the team does not track", () => {
  const early = load("first-story");
  const turns = turnsOf(early);
  const create = turns.find((t) =>
    t.tool_calls.some((c) => c.name.endsWith("create_content_file")),
  );
  const card = turns.find((t) => t.tool_calls.some((c) => c.name.endsWith("send_message")));
  [create.index, card.index] = [card.index, create.index];
  turns.sort((a, b) => a.index - b.index);
  assert.match(checkConsent(early, GUIDE).errors.join("\n"), /no consent click|before/);

  const other = load("first-story");
  for (const turn of turnsOf(other))
    for (const c of turn.tool_calls)
      if (c.name.endsWith("create_content_file"))
        c.input = c.input.replace("source_repo: acme/web", "source_repo: acme/other");
  assert.match(checkConsent(other, GUIDE).errors.join("\n"), /source_repo acme\/other/);
});
