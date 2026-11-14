// SPDX-License-Identifier: MIT
// Model-free checks on the setup hand-off cases: each grader is red on plausible wrong agents,
// and the scripted guide stub in the fixture matches the hand-back block in the setup skill.
// (Red on the do-nothing stub and green on the good agent are in foreman-behaviours.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const evals = new URL("../codesense-docs/packs/codesense-foreman/evals/", import.meta.url);
const lib = (name) => import(new URL(`lib/${name}.mjs`, evals));
const { fixtureFor, CONFIG, HANDBACK_PREFIX, HANDBACK_ROLE, SETUP_LAUNCH, SETUP_STEPS } =
  await lib("fixture");
const { loadExtraCases, grade } = await lib("graders");

const extra = loadExtraCases();
const caseOf = (id) => extra.find((c) => c.id === id);
const F = "foreman";
const LAUNCH = { ...SETUP_LAUNCH, launched_by: CONFIG.self };

async function withFixture(caseDef, fn) {
  const fx = await fixtureFor(caseDef);
  try {
    return await fn(fx);
  } finally {
    fx.teardown();
  }
}
// Plays a scripted (wrong or right) agent through a case and grades it.
const play = (id, run) =>
  withFixture(caseOf(id), async (fx) => {
    await run({ fx, turns: caseOf(id).input.turns });
    return grade(caseOf(id), fx.state());
  });
// The first turn, the reuse search, one launch and a reply.
const launchWith =
  (launch = LAUNCH) =>
  ({ fx, turns }) => (
    fx.human(turns[0]),
    fx.tool(F, "list_sessions"),
    fx.tool(F, "open_workspace", launch),
    fx.say("Starting.")
  );
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

test("the offer condition: a team with no repo is offered setup, a set-up team is not", async () => {
  await red(
    "setup-offer-no-repo",
    ({ fx, turns }) => (fx.human(turns[0]), fx.say("Hi.")),
    /0 needs-you cards raised, expected 1/,
  );
  await red(
    "setup-set-up",
    ({ fx, turns }) => (fx.human(turns[0]), fx.tool(F, "reply", card())),
    /1 needs-you cards raised, expected 0/,
  );
});

test("set me up is the yes: no offer card even with no user team", async () => {
  await red(
    "setup-handback",
    ({ fx, turns }) => (fx.human(turns[0]), fx.tool(F, "reply", card())),
    /1 needs-you cards raised, expected 0/,
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
  const write = (fx, fields) =>
    fx.tool(F, "records_create", { collection: "setup-ledger", fields });
  await red(
    "setup-not-now",
    ({ fx, turns }) => (
      offer(fx, turns),
      write(fx, { step: "foreman-offer", state: "done" }),
      fx.say("ok")
    ),
    /not step foreman-offer, state skipped/,
  );
  await red(
    "setup-not-now",
    ({ fx, turns }) => {
      offer(fx, turns);
      write(fx, { step: "foreman-offer", state: "skipped" });
      write(fx, { step: "foreman-offer", state: "skipped" });
      fx.say("ok");
    },
    /2 setup-ledger writes/,
  );
});

test("setup-reuse: a live guide an earlier Foreman launched is reused", async () => {
  await red("setup-reuse", launchWith(), /launched 1 sessions, expected 0/);
  await red(
    "setup-reuse",
    ({ fx, turns }) => (fx.human(turns[0]), fx.say("Already running.")),
    /did not look in list_sessions/,
  );
  // A guide the person started by hand is not a Foreman's: reusing it launches nothing.
  await red(
    "setup-reuse-by-hand",
    ({ fx, turns }) => (
      fx.human(turns[0]),
      fx.tool(F, "list_sessions"),
      fx.say("Already running.")
    ),
    /launched 0 sessions, expected 1/,
  );
});

test("setup-stopped: the ledger is read in the asking turn, and one reply comes", async () => {
  const first = (fx, turns) => (launchWith()({ fx, turns }), fx.human(turns[1]));
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
  await withFixture(caseOf("setup-stopped"), (fx) => {
    fx.human("x");
    fx.tool(F, "open_workspace", LAUNCH);
    const { roleMessages, ledger } = fx.state();
    assert.deepEqual(roleMessages, []);
    assert.deepEqual(ledger, [{ step: "team", state: "done" }]);
  });
});

test("launch form: the guide, the visible-unfocused mode, the Foreman's own handle and a /codesense-setup prompt", async () => {
  const id = "setup-handback";
  await red(id, launchWith({ ...LAUNCH, agent: "builtin/claude" }), /expected guide-claude/);
  await red(id, launchWith({ ...LAUNCH, mode: "focused" }), /expected visible-unfocused/);
  await red(id, launchWith({ ...LAUNCH, name: "Onboarding" }), /expected Setup/);
  await red(id, launchWith({ ...LAUNCH, launched_by: "someone" }), /launched_by is someone/);
  await red(
    id,
    launchWith({ ...LAUNCH, initial_prompt: "/codesense-setup resume" }),
    /prompt is not \/codesense-setup/,
  );
  await red(
    id,
    launchWith({ ...LAUNCH, initial_prompt: "set up codesense" }),
    /prompt is not \/codesense-setup/,
  );
});

test("setup-resume: a started ledger launches with resume, and the guide's first card is source-repos", async () => {
  await red("setup-resume", launchWith(), /prompt is not \/codesense-setup resume/);
  await green("setup-resume", launchWith({ ...LAUNCH, initial_prompt: "/codesense-setup resume" }));
  // Finished setup is not resumed; a resume carries the thread's latest Guide handoff.
  await red(
    "setup-rerun",
    launchWith({ ...LAUNCH, initial_prompt: "/codesense-setup resume" }),
    /prompt is not \/codesense-setup/,
  );
  const handoff =
    (prompt) =>
    ({ fx, turns }) => (
      fx.human(turns[0]),
      fx.say("Noted."),
      launchWith({ ...LAUNCH, initial_prompt: prompt })({ fx, turns: turns.slice(1) })
    );
  const note = caseOf("setup-resume-handoff").input.turns[0].replace("Guide handoff: ", "");
  await red(
    "setup-resume-handoff",
    handoff("/codesense-setup resume"),
    /does not carry the latest Guide handoff/,
  );
  await green("setup-resume-handoff", handoff(`/codesense-setup resume ${note}`));
  // The guide stub itself: it skips what the ledger shows done, so a fresh run starts at the team step.
  const caseDef = {
    ...caseOf("setup-resume"),
    fixture: { ...caseOf("setup-resume").fixture, ledger: [] },
  };
  await withFixture(caseDef, (fx) => {
    fx.human("x");
    fx.tool(F, "open_workspace", { ...LAUNCH, initial_prompt: "/codesense-setup resume" });
    assert.equal(fx.state().guideCards[0].step, "team");
  });
});

test("git access is a capability: the ledger step is git-access and the hand-back names a method, not gh", async () => {
  assert.deepEqual(SETUP_STEPS, ["team", "source-repos", "git-access"]);
  const id = "setup-handback";
  await withFixture(caseOf(id), async (fx) => {
    launchWith()({ fx, turns: caseOf(id).input.turns });
    const text = fx.tool(F, "claim_role_messages", { role: HANDBACK_ROLE }).deliveries[0].text;
    assert.match(text, /git access via git credentials/);
    assert.doesNotMatch(text, /\bgh\b/);
  });
  assert.doesNotMatch(
    caseOf(id)
      .rubric.map((r) => r.ask)
      .join(" "),
    /\bgh\b/,
  );
  assert.ok(caseOf("setup-rerun").fixture.ledger.some((r) => r.step === "git-access"));
});

test("setup-handback: claim, ack, then exactly one reply", async () => {
  const launch = (fx, turns) => launchWith()({ fx, turns });
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
