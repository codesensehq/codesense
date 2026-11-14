// SPDX-License-Identifier: MIT
// Model-free checks on the setup hand-off cases: each grader is red on plausible wrong agents,
// and the scripted guide stub in the fixture matches the hand-back block in the setup skill.
// (Red on the do-nothing stub and green on the good agent are in foreman-behaviours.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const evals = new URL("../codesense-docs/packs/codesense-foreman/evals/", import.meta.url);
const lib = (name) => import(new URL(`lib/${name}.mjs`, evals));
const { fixtureFor, CONFIG, HANDBACK_PREFIX, HANDBACK_ROLE } = await lib("fixture");
const { loadExtraCases, grade } = await lib("graders");
const { stubs } = await lib("stubs");

const extra = loadExtraCases();
const caseOf = (id) => extra.find((c) => c.id === id);
const F = "foreman";
const GUIDE = `guide-${CONFIG.runtime}`;
const LAUNCH = {
  target: "team-workspace",
  name: "Setup",
  agent: GUIDE,
  initial_prompt: "/codesense-setup",
  mode: "visible-unfocused",
  launched_by: CONFIG.self,
};

// Plays the good agent up to a point, then a wrong one: `wrong({fx, caseDef})` replaces the whole run.
async function play(id, wrong) {
  const caseDef = caseOf(id);
  const fx = await fixtureFor(caseDef);
  try {
    await (wrong
      ? wrong({ fx, caseDef, turns: caseDef.input.turns })
      : stubs.good({ caseDef, fx }));
    return grade(caseDef, fx.state());
  } finally {
    fx.teardown();
  }
}
const red = async (id, wrong, reason) => {
  const result = await play(id, wrong);
  assert.equal(result.pass, false, `${id}: expected a fail`);
  assert.match(result.failures.join("\n"), reason);
};
const green = async (id, run) => assert.deepEqual((await play(id, run)).failures, [], id);
const card = (extra = {}) => ({
  kind: "needs-you",
  text: "Set up now?",
  options: ["Set up now", "Not now"],
  ...extra,
});

test("setup-offer: one card, never two, never a launch", async () => {
  await red(
    "setup-offer",
    ({ fx, turns }) => (fx.human(turns[0]), fx.say("hi")),
    /0 needs-you cards raised/,
  );
  await red(
    "setup-offer",
    ({ fx, turns }) => (
      fx.human(turns[0]),
      fx.tool(F, "reply", card()),
      fx.tool(F, "reply", card())
    ),
    /2 needs-you cards/,
  );
  await red(
    "setup-offer",
    ({ fx, turns }) => (fx.human(turns[0]), fx.tool(F, "reply", card({ options: ["Yes", "No"] }))),
    /options are not Set up now and Not now/,
  );
  await red(
    "setup-offer",
    ({ fx, turns }) => (
      fx.human(turns[0]),
      fx.tool(F, "reply", card()),
      fx.tool(F, "open_workspace", LAUNCH)
    ),
    /launched 1 sessions, expected 0/,
  );
});

test("setup-offer-pending and -skipped: an unanswered card or a skipped ledger row means no new card", async () => {
  for (const id of ["setup-offer-pending", "setup-offer-skipped"])
    await red(
      id,
      ({ fx, turns }) => (fx.human(turns[0]), fx.tool(F, "reply", card())),
      /1 needs-you cards raised, expected 0/,
    );
});

test("setup-not-now: records exactly one skipped foreman-offer row, and launches nothing", async () => {
  const offer = (fx, turns) => (
    fx.human(turns[0]),
    fx.tool(F, "reply", card()),
    fx.human(turns[1])
  );
  await red(
    "setup-not-now",
    ({ fx, turns }) => (offer(fx, turns), fx.say("ok")),
    /0 setup-ledger writes, expected 1/,
  );
  const write = (fields) => (fx) =>
    fx.tool(F, "records_create", { collection: "setup-ledger", fields });
  await red(
    "setup-not-now",
    ({ fx, turns }) => (
      offer(fx, turns),
      write({ step: "foreman-offer", state: "done" })(fx),
      fx.say("ok")
    ),
    /not step foreman-offer, state skipped/,
  );
  await red(
    "setup-not-now",
    ({ fx, turns }) => {
      offer(fx, turns);
      write({ step: "foreman-offer", state: "skipped" })(fx);
      write({ step: "foreman-offer", state: "skipped" })(fx);
      fx.say("ok");
    },
    /2 setup-ledger writes/,
  );
});

test("setup-reuse: a live guide this Foreman launched is reused", async () => {
  await red(
    "setup-reuse",
    ({ fx, turns }) => (
      fx.human(turns[0]),
      fx.tool(F, "list_sessions"),
      fx.tool(F, "open_workspace", LAUNCH),
      fx.say("Starting.")
    ),
    /launched 1 sessions, expected 0/,
  );
  await red(
    "setup-reuse",
    ({ fx, turns }) => (fx.human(turns[0]), fx.say("Already running.")),
    /did not look in list_sessions/,
  );
});

test("setup-stopped: the ledger is read in the asking turn, and one reply comes", async () => {
  const first = (fx, turns) => (
    fx.human(turns[0]),
    fx.tool(F, "list_sessions"),
    fx.tool(F, "open_workspace", LAUNCH),
    fx.say("Starting."),
    fx.human(turns[1])
  );
  await red(
    "setup-stopped",
    ({ fx, turns }) => (first(fx, turns), fx.say("Going fine.")),
    /did not read the setup-ledger/,
  );
  await red(
    "setup-stopped",
    ({ fx, turns }) => (
      first(fx, turns),
      fx.tool(F, "records_list", { collection: "setup-ledger" }),
      fx.say("a"),
      fx.say("b")
    ),
    /2 replies in the last turn/,
  );
  // A stopped guide sends no hand-back.
  const fx = await fixtureFor(caseOf("setup-stopped"));
  try {
    fx.human("x");
    fx.tool(F, "open_workspace", LAUNCH);
    assert.deepEqual(fx.state().roleMessages, []);
    assert.deepEqual(fx.state().ledger, [{ step: "team", state: "done" }]);
  } finally {
    fx.teardown();
  }
});

test("launch form: the guide, the visible-unfocused mode, the Foreman's own handle and a /codesense-setup prompt", async () => {
  const run =
    (launch) =>
    ({ fx, turns }) => (
      fx.human(turns[0]),
      fx.tool(F, "list_sessions"),
      fx.tool(F, "open_workspace", launch),
      fx.say("Starting.")
    );
  const id = "setup-handback";
  await red(id, run({ ...LAUNCH, agent: "builtin/claude" }), /expected guide-claude/);
  await red(id, run({ ...LAUNCH, mode: "focused" }), /expected visible-unfocused/);
  await red(id, run({ ...LAUNCH, launched_by: "someone" }), /launched_by is someone/);
  await red(
    id,
    run({ ...LAUNCH, initial_prompt: "/codesense-setup resume" }),
    /prompt is not \/codesense-setup/,
  );
  await red(
    id,
    run({ ...LAUNCH, initial_prompt: "set up codesense" }),
    /prompt is not \/codesense-setup/,
  );
});

test("setup-resume: a started ledger launches with resume, and the guide's first card is source-repos", async () => {
  const run =
    (launch) =>
    ({ fx, turns }) => (
      fx.human(turns[0]),
      fx.tool(F, "list_sessions"),
      fx.tool(F, "open_workspace", launch),
      fx.say("Starting.")
    );
  await red("setup-resume", run(LAUNCH), /prompt is not \/codesense-setup resume/);
  await green("setup-resume", run({ ...LAUNCH, initial_prompt: "/codesense-setup resume" }));
  // The guide stub itself: it skips what the ledger shows done, so a fresh run starts at the team step.
  const caseDef = {
    ...caseOf("setup-resume"),
    fixture: { ...caseOf("setup-resume").fixture, ledger: [] },
  };
  const fx = await fixtureFor(caseDef);
  try {
    fx.human("x");
    fx.tool(F, "open_workspace", { ...LAUNCH, initial_prompt: "/codesense-setup resume" });
    assert.equal(fx.state().guideCards[0].step, "team");
  } finally {
    fx.teardown();
  }
});

test("setup-handback: claim, ack, then exactly one reply", async () => {
  const launch = (fx, turns) => (
    fx.human(turns[0]),
    fx.tool(F, "list_sessions"),
    fx.tool(F, "open_workspace", LAUNCH),
    fx.say("Starting.")
  );
  await red("setup-handback", ({ fx, turns }) => launch(fx, turns), /did not claim the hand-back/);
  await red(
    "setup-handback",
    ({ fx, turns }) => (
      launch(fx, turns),
      fx.tool(F, "claim_role_messages", { role: HANDBACK_ROLE }),
      fx.say("Set up: x")
    ),
    /never acked/,
  );
  const claimed = (fx, turns) => (
    launch(fx, turns),
    fx.tool(F, "claim_role_messages", { role: HANDBACK_ROLE }),
    fx.tool(F, "ack_role_message", { deliveryId: 1 })
  );
  await red(
    "setup-handback",
    ({ fx, turns }) => claimed(fx, turns),
    /exactly one reply after the hand-back/,
  );
  await red(
    "setup-handback",
    ({ fx, turns }) => (claimed(fx, turns), fx.say("Set up: a"), fx.say("Set up: b")),
    /exactly one reply/,
  );
  // A claim on the wrong role's queue finds nothing, so nothing is claimed.
  await red(
    "setup-handback",
    ({ fx, turns }) => (
      launch(fx, turns),
      fx.tool(F, "claim_role_messages", { role: "foreman" }),
      fx.tool(F, "ack_role_message", { deliveryId: 1 }),
      fx.say("Set up: x")
    ),
    /exactly one reply|never acked|did not claim/,
  );
});

test("a broken setup fixture is refused", async () => {
  for (const bad of [
    { offer_card: "x" },
    { ledger: "x" },
    { guide: "nope" },
    { guide: { stop_after: -1 } },
  ]) {
    await assert.rejects(
      async () => (await fixtureFor({ fixture: bad })).teardown(),
      /offer_card|ledger|guide/,
    );
  }
});

test("the setup skill's hand-back block and the guide stub agree", () => {
  const skill = readFileSync(
    new URL(
      "../codesense-docs/getting-started/content/examples/skills/codesense-setup/SKILL.md",
      import.meta.url,
    ),
    "utf8",
  );
  const block = /<!-- foreman-handback -->([\s\S]*?)<!-- \/foreman-handback -->/.exec(skill)?.[1];
  assert.ok(block, "SKILL.md has a foreman-handback block");
  assert.ok(block.includes(`\`${HANDBACK_PREFIX}\``), "the block names the Setup done: prefix");
  assert.ok(block.includes(`role:${HANDBACK_ROLE}`), "the block names the queue");
  assert.match(block, /launched by another session/);
  assert.ok(
    block.indexOf("send_role_message") < block.indexOf("signal_done"),
    "the message goes before signal_done",
  );
  assert.ok(block.includes("Guide handoff:") === false, "the block is the hand-back only");
});
