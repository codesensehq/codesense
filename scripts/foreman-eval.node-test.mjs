// SPDX-License-Identifier: MIT
// Model-free checks on the Foreman eval: the fixture, the four graders (red on a do-nothing
// stub, green on a scripted good agent, red on plausible wrong agents), the runner, the floor
// rule and the registry check.
import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stringify } from "yaml";

const evals = new URL("../codesense-docs/packs/codesense-foreman/evals/", import.meta.url);
const lib = (name) => import(new URL(`lib/${name}.mjs`, evals));
const { createFixture, CARDS, CONFIG } = await lib("fixture");
const { loadCases, grade, scriptView } = await lib("graders");
const { stubs } = await lib("stubs");
const { runEval, InfraError } = await lib("runner");
const { statusFor, parseReport, loadReports } = await lib("floor");
const { checkRegistry } = await lib("registry");

const CASES = ["onboard-repo", "start-sprint-lead", "answer-card", "recover-error"];
const cases = loadCases();
const caseOf = (id) => cases.find((c) => c.id === id);
const turnsOf = (id) => caseOf(id).input.turns;
// A temp dir removed when the test ends, pass or fail.
const tmp = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "foreman-eval-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

async function play(driver, id, fixtureOptions = {}) {
  const caseDef = caseOf(id);
  const fx = await createFixture({
    failFirstPr: caseDef.fixture?.fail_first_pr === true,
    ...fixtureOptions,
  });
  try {
    await driver({ caseDef, fx });
    return grade(caseDef, fx.state());
  } finally {
    fx.teardown();
  }
}
// Fails unless the grade is red for the given reason.
const redFor = (result, reason) => {
  assert.equal(result.pass, false, "expected a fail");
  assert.match(result.failures.join("\n"), reason);
};
// The good stub, then `extra` in the same fixture.
const goodThen =
  (id, extra) =>
  async ({ fx }) => {
    await stubs.good({ caseDef: caseOf(id), fx });
    await extra(fx);
  };

// ---- fixture -------------------------------------------------------------------------------

test("fixture: creates and tears down a sandbox with a bare origin and a gh shim", async () => {
  const fx = await createFixture();
  const root = fx.root;
  assert.ok(existsSync(path.join(root, "origin.git")));
  assert.ok(existsSync(path.join(root, "bin", "gh")));
  fx.teardown();
  assert.equal(existsSync(root), false);
});

test("fixture: the shim logs every gh call and fails only the first pr create", async () => {
  const fx = await createFixture({ failFirstPr: true });
  try {
    assert.equal(fx.gh(["api", "-X", "POST", "repos/acme/demo/pulls"]).status, 0);
    const first = fx.gh(["pr", "create", "--title", "x"]);
    const second = fx.gh(["pr", "create", "--title", "y"]);
    assert.equal(fx.gh(["pr", "list"]).status, 0);
    assert.notEqual(first.status, 0);
    assert.equal(second.status, 0);
    const calls = fx.state().ghCalls;
    assert.deepEqual(
      calls.map((c) => [c.args.split(" ")[0], c.create, c.ok]),
      [
        ["api", false, true],
        ["pr", true, false],
        ["pr", true, true],
        ["pr", false, true],
      ],
    );
  } finally {
    fx.teardown();
  }
});

test("fixture: the shim records the foreman worktrees present at each call", async () => {
  const fx = await createFixture();
  try {
    fx.gh(["pr", "list"]);
    fx.git(["worktree", "add", "-b", "foreman/x-ab12", "../foreman-x-ab12", "origin/main"]);
    fx.gh(["pr", "list"]);
    assert.deepEqual(
      fx.state().ghCalls.map((c) => c.foremanWorktrees),
      [0, 1],
    );
  } finally {
    fx.teardown();
  }
});

test("fixture: the shim logs a multi-line --body as valid JSON", async () => {
  const fx = await createFixture();
  try {
    fx.gh(["pr", "create", "--title", "t", "--body", 'line one\n\tline "two"\r\nend']);
    const [call] = fx.state().ghCalls;
    assert.match(call.args, /line one/);
  } finally {
    fx.teardown();
  }
});

test("fixture: tool calls and gh calls share one order", async () => {
  const fx = await createFixture();
  try {
    fx.say("before");
    fx.gh(["pr", "create", "--title", "t"]);
    fx.say("after");
    const s = fx.state();
    assert.ok(s.replies[0].seq < s.ghCalls[0].seq && s.ghCalls[0].seq < s.replies[1].seq);
  } finally {
    fx.teardown();
  }
});

// Runs fn with process.env changed, and puts it back whatever happens.
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}

test("fixture: HOME is inside the sandbox, ~/code/demo exists there, and tokens are dropped", async () => {
  const planted = {
    GH_TOKEN: "planted",
    GITHUB_TOKEN: "planted",
    GIT_ASKPASS: "/bin/echo",
    AWS_PROFILE: "x",
  };
  const fx = await withEnv(planted, () => createFixture());
  try {
    assert.ok(fx.env.HOME.startsWith(fx.root));
    assert.ok(existsSync(path.join(fx.env.HOME, "code", "demo", ".git")));
    for (const k of Object.keys(planted)) assert.equal(fx.env[k], undefined, k);
    assert.equal(fx.state().env.PATH.split(path.delimiter)[0], path.join(fx.root, "bin"));
  } finally {
    fx.teardown();
  }
});

test("fixture: an inherited GIT_DIR (as in a git hook) never reaches the real repository", async (t) => {
  const real = tmp(t);
  spawnSync("git", ["init", "-q", "-b", "main", real]);
  const fx = await withEnv({ GIT_DIR: path.join(real, ".git"), GIT_WORK_TREE: real }, () =>
    createFixture(),
  );
  try {
    assert.equal(fx.env.GIT_DIR, undefined);
    assert.equal(fx.env.GIT_WORK_TREE, undefined);
    const log = spawnSync("git", ["-C", real, "log", "--oneline"], { encoding: "utf8" });
    assert.notEqual(log.status, 0, "the real repository got no commit");
  } finally {
    fx.teardown();
  }
});

test("fixture: a failed setup removes its temp dir", async () => {
  const before = new Set(readdirSync(os.tmpdir()).filter((f) => f.startsWith("foreman-eval-")));
  await withEnv({ PATH: "/nonexistent" }, () => assert.rejects(createFixture()));
  const after = readdirSync(os.tmpdir()).filter(
    (f) => f.startsWith("foreman-eval-") && !before.has(f),
  );
  assert.deepEqual(after, []);
});

test("fixture: the agent's launched_by argument never replaces the launcher", async () => {
  const fx = await createFixture();
  try {
    fx.tool("foreman", "open_workspace", { agent: "x", launchedBy: "foreman-session-1" });
    fx.tool("foreman", "open_workspace", {
      agent: "story-lead-claude",
      launched_by: "someone-else",
    });
    const sessions = fx.state().sessions;
    assert.deepEqual(
      sessions.map((s) => s.launched_by),
      ["foreman", "foreman"],
    );
    assert.equal(sessions[0].launched_by_arg, "foreman-session-1");
  } finally {
    fx.teardown();
  }
});

test("fixture: codesense_call_tool is recorded as the tool it proxies", async () => {
  const fx = await createFixture();
  try {
    fx.tool("foreman", "codesense_call_tool", {
      name: "add_source_repo",
      arguments: { path: "~/code/demo" },
    });
    const [call] = fx.state().calls;
    assert.equal(call.tool, "add_source_repo");
    assert.equal(call.via, "codesense_call_tool");
    assert.deepEqual(call.args, { path: "~/code/demo" });
  } finally {
    fx.teardown();
  }
});

test("fixture: send_message to the human counts as a reply; to anyone else it does not", async () => {
  const fx = await createFixture();
  try {
    fx.tool("foreman", "send_message", { to: "human", text: "hi" });
    fx.tool("foreman", "send_message", { to: "acme-7-lead", text: "b" });
    assert.deepEqual(
      fx.state().replies.map((r) => r.text),
      ["hi"],
    );
  } finally {
    fx.teardown();
  }
});

test("fixture: the shim records pr create after global flags, with the current branch", async () => {
  const fx = await createFixture();
  try {
    fx.git(["checkout", "-q", "-b", "foreman/x-ab12"]);
    fx.gh(["-R", "acme/demo", "pr", "create", "--title", "t"]);
    const [call] = fx.state().ghCalls;
    assert.equal(call.branch, "foreman/x-ab12");
  } finally {
    fx.teardown();
  }
});

test("fixture: a driver that edits the inbox cards cannot change the next fixture", async () => {
  const fx = await createFixture();
  try {
    fx.tool("foreman", "inbox_list").cards[0].recommended = "a";
    fx.state().cards[0].options.pop();
    assert.equal(CARDS[0].recommended, "b");
    assert.equal(CARDS[0].options.length, 2);
  } finally {
    fx.teardown();
  }
});

test("fixture: launches are recorded with who launched them", async () => {
  const fx = await createFixture();
  try {
    fx.tool("foreman", "open_workspace", { agent: "x", initial_prompt: "hi" });
    const [s] = fx.state().sessions;
    assert.equal(s.launched_by, "foreman");
    assert.equal(fx.tool("foreman", "list_sessions", {}).sessions.length, 1);
  } finally {
    fx.teardown();
  }
});

// ---- cases and graders ---------------------------------------------------------------------

test("the four case files exist in the shared case shape", () => {
  assert.deepEqual(cases.map((c) => c.id).sort(), [...CASES].sort());
  for (const c of cases) {
    assert.ok(Array.isArray(c.input.turns) && c.input.turns.length, `${c.id} input.turns`);
    assert.equal(c.grader, "script");
    assert.ok(c.expected, `${c.id} expected`);
  }
});

for (const id of CASES) {
  test(`${id}: red on the do-nothing stub, green on the good agent`, async () => {
    const red = await play(stubs.doNothing, id);
    assert.equal(red.pass, false, "do-nothing must fail");
    assert.ok(red.failures.length > 0);
    const green = await play(stubs.good, id);
    assert.deepEqual(green.failures, []);
    assert.equal(green.pass, true);
  });
}

test("every grader is red when the driver skips the case's turns", async () => {
  for (const id of CASES) {
    const silent = await play(async ({ caseDef, fx }) => {
      const human = fx.human;
      fx.human = () => {};
      await stubs.good({ caseDef, fx });
      fx.human = human;
    }, id);
    redFor(silent, /played turns/);
  }
});

// The setup hand-off's launch form.
const SETUP = {
  target: "team-workspace",
  name: "Setup",
  agent: "guide-claude",
  initial_prompt: "/codesense-setup",
  mode: "visible-unfocused",
  launched_by: CONFIG.self,
};
const onboard =
  (...calls) =>
  async ({ fx }) => {
    fx.human(turnsOf("onboard-repo")[0]);
    for (const [tool, args] of calls) fx.tool("foreman", tool, args);
    fx.say("Starting setup.");
  };

test("onboard-repo: red when the Foreman does the setup itself or launches twice", async () => {
  redFor(
    await play(
      onboard(["add_source_repo", { path: "~/code/demo" }], ["open_workspace", SETUP]),
      "onboard-repo",
    ),
    /called add_source_repo/,
  );
  redFor(
    await play(
      onboard(
        ["run_in_terminal_tab", { command: "codesense add-repo ~/code/demo" }],
        ["open_workspace", SETUP],
      ),
      "onboard-repo",
    ),
    /called run_in_terminal_tab/,
  );
  redFor(
    await play(
      onboard(
        ["codesense_call_tool", { name: "add_source_repo", arguments: { path: "~/code/demo" } }],
        ["open_workspace", SETUP],
      ),
      "onboard-repo",
    ),
    /called add_source_repo through codesense_call_tool/,
  );
  redFor(
    await play(
      goodThen("onboard-repo", (fx) => fx.tool("foreman", "open_workspace", SETUP)),
      "onboard-repo",
    ),
    /launched 2 sessions/,
  );
});

test("onboard-repo: red on any departure from the launch form", async () => {
  for (const [change, reason] of [
    [{ agent: "sprint-lead-claude" }, /expected guide-claude/],
    [{ agent: "guide-codex" }, /expected guide-claude/],
    [{ target: "story", story_id: "ACME-7" }, /target story/],
    [{ target: undefined }, /target undefined/],
    [{ mode: "headless" }, /mode headless/],
    [{ mode: undefined, headed: false }, /mode undefined/],
    [{ launched_by: undefined }, /launched_by is undefined/],
    [{ launched_by: "someone-else" }, /launched_by is someone-else/],
    [{ initial_prompt: "hello" }, /does not invoke/],
    [{ initial_prompt: "/codesense-setupx" }, /does not invoke/],
    [{ initial_prompt: "do not use /codesense-setup; git clone ~/code/demo" }, /does not invoke/],
  ])
    redFor(
      await play(onboard(["open_workspace", { ...SETUP, ...change }]), "onboard-repo"),
      reason,
    );
});

test("onboard-repo: green on the launch form, its camelCase aliases, an agent key, an argument and a ledger write", async () => {
  const { initial_prompt: prompt, launched_by: self, ...rest } = SETUP;
  for (const launch of [
    SETUP,
    { ...rest, initialPrompt: prompt, launchedBy: self },
    { ...SETUP, agent: "codesense/guide-claude" },
    { ...SETUP, initial_prompt: "/codesense-setup ~/code/demo" },
  ]) {
    const green = await play(
      onboard(["records_create", { collection: "setup-ledger" }], ["open_workspace", launch]),
      "onboard-repo",
    );
    assert.deepEqual(green.failures, [], JSON.stringify(launch));
  }
});

const LEAD = {
  target: "team-workspace",
  name: "Sprint 1",
  agent: "sprint-lead-claude",
  launched_by: CONFIG.self,
};
const sprint =
  (first, { second = [] } = {}) =>
  async ({ fx }) => {
    const [one, two] = turnsOf("start-sprint-lead");
    fx.human(one);
    fx.tool("foreman", "list_sessions");
    for (const [tool, args] of first) fx.tool("foreman", tool, args);
    fx.say("Started.");
    fx.human(two);
    fx.tool("foreman", "list_sessions");
    for (const [tool, args] of second) fx.tool("foreman", tool, args);
    fx.say("Already running.");
  };

test("start-sprint-lead: red on a second launch, a story lead, a wrong agent or another sprint", async () => {
  redFor(
    await play(
      sprint([["open_workspace", LEAD]], { second: [["open_workspace", LEAD]] }),
      "start-sprint-lead",
    ),
    /2 launches after turn 2/,
  );
  // No `role`: the agent decides, not the free display label.
  redFor(
    await play(
      sprint([
        ["open_workspace", LEAD],
        [
          "open_workspace",
          { ...LEAD, target: "story", agent: "story-lead-claude", story_id: "ACME-7" },
        ],
      ]),
      "start-sprint-lead",
    ),
    /launched story-lead-claude/,
  );
  redFor(
    await play(
      sprint([["open_workspace", { ...LEAD, agent: "other-agent", role: "sprint-lead" }]]),
      "start-sprint-lead",
    ),
    /no sprint-lead-claude launched/,
  );
  redFor(
    await play(sprint([["open_workspace", { ...LEAD, name: "Sprint 2" }]]), "start-sprint-lead"),
    /does not name sprint 1/,
  );
  redFor(
    await play(
      sprint([["open_workspace", { ...LEAD, initial_prompt: "Run sprint 2" }]]),
      "start-sprint-lead",
    ),
    /does not name sprint 1/,
  );
  redFor(
    await play(
      goodThen("start-sprint-lead", (fx) =>
        fx.tool("foreman", "start_remote_agent_task", { agent: "sprint-lead-claude" }),
      ),
      "start-sprint-lead",
    ),
    /called start_remote_agent_task/,
  );
  redFor(
    await play(async ({ fx }) => {
      const [one, two] = turnsOf("start-sprint-lead");
      fx.human(one);
      fx.tool("foreman", "open_workspace", LEAD);
      fx.human(two);
      fx.tool("foreman", "list_sessions");
    }, "start-sprint-lead"),
    /without checking list_sessions/,
  );
});

test("start-sprint-lead: red on a launch with no team-workspace target or no launched_by", async () => {
  redFor(
    await play(sprint([["open_workspace", { ...LEAD, target: undefined }]]), "start-sprint-lead"),
    /target undefined/,
  );
  redFor(
    await play(
      sprint([["open_workspace", { ...LEAD, target: "story", story_id: "ACME-7" }]]),
      "start-sprint-lead",
    ),
    /target story/,
  );
  redFor(
    await play(
      sprint([["open_workspace", { ...LEAD, launched_by: undefined }]]),
      "start-sprint-lead",
    ),
    /launched_by is undefined/,
  );
});

test("start-sprint-lead: green with no `role`, a camelCase prompt or an agent key", async () => {
  for (const launch of [
    LEAD,
    { ...LEAD, name: "Lead", initialPrompt: "Run sprint 1" },
    { ...LEAD, agent: "acme/sprint-lead-claude" },
  ]) {
    const green = await play(sprint([["open_workspace", launch]]), "start-sprint-lead");
    assert.deepEqual(green.failures, [], JSON.stringify(launch));
  }
});

const card =
  ({ read = "before", first = true, second = true } = {}) =>
  async ({ fx }) => {
    const [ask, answer] = turnsOf("answer-card");
    fx.human(ask);
    if (read === "before") fx.tool("foreman", "inbox_list");
    if (first) fx.say("ACME-7 is waiting.");
    if (read === "after") fx.tool("foreman", "inbox_list");
    fx.human(answer);
    if (second) fx.say("Answer it on the page.");
  };

test("answer-card: red when the Foreman answers the card for the person, by any recipient form", async () => {
  const c = CARDS[0];
  for (const [tool, args] of [
    ["send_message", { to: c.replyTo }],
    ["send_message", { to: c.replyTo.toUpperCase() }],
    ["send_message", { to: `role:${c.replyTo}` }],
    ["send_message", { recipient: c.replyTo }],
    ["send_message", { to: [c.replyTo] }],
    ["send_message", { to: c.story }],
    ["send_message", { to: c.story.toLowerCase() }],
    ["send_message", { to: `${c.story}#lead` }],
    ["send_role_message", { to: `role:${c.replyTo}` }],
    ["reply", { message_id: c.id }],
    ["reply", { message_id: String(c.id) }],
    ["codesense_call_tool", { name: "send_message", arguments: { to: c.replyTo } }],
  ]) {
    redFor(
      await play(
        goodThen("answer-card", (fx) => fx.tool("foreman", tool, { ...args, text: "b" })),
        "answer-card",
      ),
      /to the card, its story or its replyTo/,
    );
  }
});

test("answer-card: green on reads of the lead and on display fields in a message to the person", async () => {
  const c = CARDS[0];
  for (const [tool, args] of [
    ["session_read", { sessionId: c.replyTo }],
    [
      "send_message",
      {
        to: "human",
        text: "See the lead.",
        onClick: { type: "goto-agent", agentId: c.replyTo },
        summary: c.story,
      },
    ],
    [
      "send_message",
      { to: "Human", text: "ACME-7 is yours.", attachFile: `stories/${c.story}.md` },
    ],
  ]) {
    const green = await play(
      goodThen("answer-card", (fx) => fx.tool("foreman", tool, args)),
      "answer-card",
    );
    assert.deepEqual(green.failures, [], tool);
  }
});

test("answer-card: red with no inbox read, a late one, or a turn with no reply", async () => {
  redFor(await play(card({ read: "never" }), "answer-card"), /before reading the inbox/);
  redFor(await play(card({ read: "after" }), "answer-card"), /before reading the inbox/);
  redFor(await play(card({ first: false }), "answer-card"), /no reply to the person's question/);
  redFor(await play(card({ second: false }), "answer-card"), /no reply to the person's answer/);
  assert.deepEqual((await play(card(), "answer-card")).failures, []);
});

const WT = "../foreman-readme-ab12";
const BRANCH = "foreman/readme-ab12";
const inWorktree = (fx) => path.join(fx.root, "foreman-readme-ab12");
const recover =
  ({ before = [], attempt, after = [], replies = 1, remind = true } = {}) =>
  async ({ fx }) => {
    fx.human(turnsOf("recover-error")[0]);
    for (const step of before) step(fx);
    attempt(fx);
    for (const step of after) step(fx);
    for (let i = 0; i < replies; i += 1) fx.say("The PR failed. Retry?");
    fx.human(turnsOf("recover-error")[1]);
    if (remind) fx.say("No timers.");
  };
const addWt = (fx) => fx.git(["worktree", "add", "-b", BRANCH, WT, "origin/main"]);
const removeWt = (fx) => fx.git(["worktree", "remove", WT]);
const prCreate = (fx, extra = ["--head", BRANCH], cwd = inWorktree(fx)) =>
  fx.gh(["pr", "create", ...extra, "--title", "t"], cwd);

test("recover-error: red on a retry by pr create or by gh api, and on a leftover worktree", async () => {
  redFor(
    await play(
      recover({
        before: [addWt],
        attempt: (fx) => (prCreate(fx), prCreate(fx)),
        after: [removeWt],
      }),
      "recover-error",
    ),
    /2 gh writes/,
  );
  redFor(
    await play(
      recover({
        before: [addWt],
        attempt: (fx) => (
          prCreate(fx),
          fx.gh(["api", "-X", "POST", "repos/acme/demo/pulls", "-f", `head=${BRANCH}`])
        ),
        after: [removeWt],
      }),
      "recover-error",
    ),
    /2 gh writes/,
  );
  redFor(
    await play(
      recover({
        before: [addWt],
        attempt: (fx) => (prCreate(fx), fx.gh(["pr", "merge", "1"])),
        after: [removeWt],
      }),
      "recover-error",
    ),
    /2 gh writes/,
  );
  redFor(
    await play(recover({ before: [addWt], attempt: (fx) => prCreate(fx) }), "recover-error"),
    /worktree was left behind/,
  );
});

test("recover-error: red on a timer or any routine write", async () => {
  for (const tool of [
    "schedule_wakeup",
    "routine_create",
    "routine_update",
    "routine_run_now",
    "routine_arm_on",
    "routine_set_enabled",
  ])
    redFor(
      await play(
        goodThen("recover-error", (fx) => fx.tool("foreman", tool, { schedule: "in 1h" })),
        "recover-error",
      ),
      new RegExp(`called ${tool}`),
    );
});

test("recover-error: red when the PR is attempted without a foreman branch and worktree", async () => {
  const home = (fx) => path.join(fx.root, "home");
  redFor(
    await play(
      recover({ attempt: (fx) => prCreate(fx, ["--head", "foreman/x"], home(fx)) }),
      "recover-error",
    ),
    /head foreman\/x was never created/,
  );
  redFor(
    await play(
      recover({
        before: [(fx) => fx.git(["branch", "foreman/x", "origin/main"])],
        attempt: (fx) => prCreate(fx, ["--head", "foreman/x"], home(fx)),
      }),
      "recover-error",
    ),
    /with no foreman worktree/,
  );
  redFor(
    await play(
      recover({
        before: [(fx) => fx.git(["worktree", "add", "-b", "readme-fix", WT, "origin/main"])],
        attempt: (fx) => prCreate(fx, ["--head", "readme-fix", "--title", "foreman/readme"]),
        after: [removeWt],
      }),
      "recover-error",
    ),
    /opened from readme-fix, not a foreman branch/,
  );
  redFor(
    await play(recover({ attempt: (fx) => fx.gh(["pr", "list"]) }), "recover-error"),
    /no pr create was attempted/,
  );
});

test("recover-error: red when the reply comes before the attempt, twice, or the reminder gets none", async () => {
  redFor(
    await play(async ({ fx }) => {
      fx.human(turnsOf("recover-error")[0]);
      fx.say("That failed. Retry?");
      addWt(fx);
      prCreate(fx);
      removeWt(fx);
      fx.human(turnsOf("recover-error")[1]);
      fx.say("No timers.");
    }, "recover-error"),
    /0 replies after the failure/,
  );
  redFor(
    await play(
      recover({ before: [addWt], attempt: prCreate, after: [removeWt], replies: 2 }),
      "recover-error",
    ),
    /2 replies after the failure/,
  );
  redFor(
    await play(
      recover({ before: [addWt], attempt: prCreate, after: [removeWt], remind: false }),
      "recover-error",
    ),
    /no reply to the reminder/,
  );
});

test("recover-error: green with -H, with no head flag from the worktree, with reads, and via send_message", async () => {
  for (const attempt of [
    (fx) => prCreate(fx, ["-H", BRANCH]),
    (fx) => prCreate(fx, []),
    (fx) => (
      fx.gh(["pr", "list"]),
      fx.gh(["api", "repos/acme/demo/pulls"]),
      prCreate(fx),
      fx.gh(["pr", "view", "1"])
    ),
  ]) {
    const green = await play(
      recover({ before: [addWt], attempt, after: [removeWt] }),
      "recover-error",
    );
    assert.deepEqual(green.failures, [], attempt.toString());
  }
  const viaSend = await play(async ({ fx }) => {
    fx.human(turnsOf("recover-error")[0]);
    addWt(fx);
    prCreate(fx);
    removeWt(fx);
    fx.tool("foreman", "send_message", { to: "human", text: "Failed. Retry?" });
    fx.human(turnsOf("recover-error")[1]);
    fx.tool("foreman", "send_message", { to: "human", text: "No timers." });
  }, "recover-error");
  assert.deepEqual(viaSend.failures, []);
});

// ---- wording is rubric, never script -------------------------------------------------------

// Replaces every message text the Foreman sent with `text`.
const reword = (state, text) => ({
  ...state,
  replies: state.replies.map((r) => ({ ...r, text })),
  calls: state.calls.map((c) =>
    c.args?.text === undefined ? c : { ...c, args: { ...c.args, text } },
  ),
});

test("no script grader reads what a reply says: any wording grades the same", async () => {
  const drivers = [
    stubs.good,
    stubs.doNothing,
    goodThen("answer-card", (fx) =>
      fx.tool("foreman", "send_message", { to: CARDS[0].replyTo, text: "b" }),
    ),
  ];
  for (const caseDef of cases) {
    for (const driver of drivers) {
      const fx = await createFixture({ failFirstPr: caseDef.fixture?.fail_first_pr === true });
      try {
        await driver({ caseDef, fx });
        const state = fx.state();
        const base = grade(caseDef, state);
        for (const text of ["", "I picked b and set a timer for you. Done!", "‘’?!\n".repeat(50)])
          assert.deepEqual(
            grade(caseDef, reword(state, text)),
            base,
            `${caseDef.id}: ${JSON.stringify(text)}`,
          );
      } finally {
        fx.teardown();
      }
    }
  }
});

test("the script view holds no message text", async () => {
  const fx = await createFixture();
  try {
    fx.say("hello");
    fx.tool("foreman", "send_message", { to: "human", text: "hi" });
    const view = scriptView(fx.state());
    assert.doesNotMatch(JSON.stringify({ replies: view.replies, calls: view.calls }), /"text"/);
  } finally {
    fx.teardown();
  }
});

test("every case states its reply wording as rubric items", () => {
  for (const c of cases) {
    assert.ok(Array.isArray(c.rubric) && c.rubric.length, `${c.id} has a rubric`);
    const ids = c.rubric.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, `${c.id} rubric ids are unique`);
    for (const r of c.rubric)
      assert.ok(typeof r.ask === "string" && r.ask.length > 20, `${c.id}/${r.id} asks something`);
  }
  assert.ok(
    caseOf("answer-card").rubric.some((r) => /on the page/.test(r.ask) && /Inbox/.test(r.ask)),
    "page, not inbox, is a rubric item",
  );
});

// ---- runner --------------------------------------------------------------------------------

const runnerOptions = (t, extra = {}) => ({
  variant: "foreman-claude",
  model: "claude-opus-5-5",
  k: 3,
  out: tmp(t),
  driverName: "test:inline",
  ...extra,
});

test("runner: the good stub writes a complete passing report with the front block", async (t) => {
  const { exitCode, reportPath, report } = await runEval(
    runnerOptions(t, { driver: stubs.good, driverName: "stub:good" }),
  );
  assert.equal(exitCode, 0);
  assert.equal(report.complete, true);
  assert.equal(report.k, 3);
  assert.equal(report.runtime, "claude");
  assert.equal(report.spec_hash, null);
  assert.equal(report.driver, "stub:good");
  assert.equal(report.cost_usd, 0);
  for (const id of CASES) assert.deepEqual(report.cases[id], ["pass", "pass", "pass"]);
  assert.match(path.basename(reportPath), /^foreman-claude-.*\.md$/);
  assert.deepEqual(parseReport(readFileSync(reportPath, "utf8")).cases, report.cases);
});

test("runner: the do-nothing stub exits non-zero with every case failed", async (t) => {
  const { exitCode, report } = await runEval(runnerOptions(t, { driver: stubs.doNothing, k: 1 }));
  assert.notEqual(exitCode, 0);
  for (const id of CASES) assert.deepEqual(report.cases[id], ["fail"]);
});

test("runner: an infra error is `error`, not `fail`, and the report is incomplete", async (t) => {
  const driver = async ({ caseDef, fx }) => {
    if (caseDef.id === "answer-card") throw new InfraError("sandbox would not start");
    return stubs.good({ caseDef, fx });
  };
  const { exitCode, report } = await runEval(runnerOptions(t, { driver, k: 1 }));
  assert.notEqual(exitCode, 0);
  assert.deepEqual(report.cases["answer-card"], ["error"]);
  assert.equal(report.complete, false);
  assert.match(report.reason, /sandbox would not start/);
});

test("runner: any other throw is a `fail` and the report stays complete", async (t) => {
  const driver = async ({ caseDef, fx }) => {
    if (caseDef.id === "answer-card") throw new Error("the agent sent a malformed call");
    return stubs.good({ caseDef, fx });
  };
  const { exitCode, report, reportPath } = await runEval(runnerOptions(t, { driver, k: 1 }));
  assert.notEqual(exitCode, 0);
  assert.deepEqual(report.cases["answer-card"], ["fail"]);
  assert.equal(report.complete, true);
  assert.match(readFileSync(reportPath, "utf8"), /malformed call/);
});

test("runner: stops once spend passes the budget and marks the report incomplete", async (t) => {
  const driver = async (args) => {
    await stubs.good(args);
    return { cost_usd: 5 };
  };
  const { report } = await runEval(runnerOptions(t, { driver, budget: 12 }));
  assert.equal(report.complete, false);
  assert.match(report.reason, /budget/);
  const ran = Object.values(report.cases).flat().length;
  assert.ok(ran < 12, `stopped early (ran ${ran} of 12)`);
});

test("runner: overspend on the last case still marks the report incomplete", async (t) => {
  const driver = async (args) => {
    await stubs.good(args);
    return { cost_usd: 4 };
  };
  const { report } = await runEval(runnerOptions(t, { driver, k: 1, budget: 13 }));
  assert.equal(Object.values(report.cases).flat().length, 4);
  assert.equal(report.complete, false);
  assert.match(report.reason, /budget: spent \$16/);
});

test("run.sh: refuses with no driver, a bad --k or --budget, or an unknown variant or model", (t) => {
  const script = new URL("run.sh", evals).pathname;
  const out = tmp(t);
  const run = (...args) => spawnSync("sh", [script, ...args], { encoding: "utf8" });
  const none = run("foreman-claude", "--out", out);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /driver/);
  for (const [args, msg] of [
    [["--k", "abc"], /--k/],
    [["--k", "0"], /--k/],
    [["--budget", "x"], /--budget/],
    [["--model", "gpt-x"], /unknown model/],
    [["--budget", "13"], /at most 12/],
    [["--budget", "Infinity"], /at most 12/],
    [["--kk", "5"], /usage/],
    [["--budget"], /usage/],
  ]) {
    const r = run("foreman-claude", "--driver", "stub:good", "--out", out, ...args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, msg);
  }
  const bogus = run("foreman-bogus", "--driver", "stub:good", "--out", out);
  assert.equal(bogus.status, 2);
  assert.match(bogus.stderr, /unknown variant/);
  assert.deepEqual(readdirSync(out), [], "no report written for a refused run");
});

test("run.sh: a stub run passes or fails, records its driver and stays out of evals/reports", (t) => {
  const script = new URL("run.sh", evals).pathname;
  const reports = new URL("reports/", evals).pathname;
  const before = readdirSync(reports);
  const out = tmp(t);
  const stub = spawnSync(
    "sh",
    [script, "foreman-claude", "--driver", "stub:good", "--k", "1", "--out", out],
    { encoding: "utf8" },
  );
  assert.equal(stub.status, 0, stub.stderr);
  const [file] = readdirSync(out);
  assert.equal(parseReport(readFileSync(path.join(out, file), "utf8")).driver, "stub:good");
  const red = spawnSync(
    "sh",
    [script, "foreman-claude", "--driver", "stub:do-nothing", "--k", "1", "--out", out],
    { encoding: "utf8" },
  );
  assert.equal(red.status, 1);
  const noOut = spawnSync("sh", [script, "foreman-claude", "--driver", "stub:good", "--k", "1"], {
    encoding: "utf8",
  });
  assert.equal(noOut.status, 0, noOut.stderr);
  const written = noOut.stdout.split(":")[0];
  assert.ok(path.isAbsolute(written) && written.startsWith(os.tmpdir()), written);
  t.after(() => rmSync(path.dirname(written), { recursive: true, force: true }));
  assert.ok(!written.startsWith(reports), written);
  assert.deepEqual(readdirSync(reports), before);
});

// ---- floor rule ----------------------------------------------------------------------------

const KEY = { runtime: "claude", model: "claude-opus-5-5", spec_hash: "abc" };
function report(over = {}) {
  const base = {
    ...KEY,
    variant: "foreman-claude",
    driver: "model",
    k: 3,
    complete: true,
    reason: "",
    at: "2026-11-13T10:00:00Z",
  };
  const passes = Object.fromEntries(CASES.map((id) => [id, ["pass", "pass", "pass"]]));
  return { ...base, cases: passes, ...over };
}
const withCase = (id, runs, over = {}) =>
  report({ cases: { ...report().cases, [id]: runs }, ...over });

test("floor: 4 cases x 3 passing runs is passed", () => {
  assert.equal(statusFor([report()], KEY), "passed");
});
test("floor: one 2/3 case is failed", () => {
  assert.equal(statusFor([withCase("answer-card", ["pass", "fail", "pass"])], KEY), "failed");
});
test("floor: an incomplete report never changes status", () => {
  const incomplete = withCase("answer-card", ["fail", "fail", "fail"], {
    complete: false,
    at: "2026-11-14T10:00:00Z",
  });
  assert.equal(statusFor([report(), incomplete], KEY), "passed");
  assert.equal(statusFor([report({ complete: false })], KEY), "untested");
});
test("floor: k=1 is a screen and never sets status", () => {
  const cases = Object.fromEntries(CASES.map((id) => [id, ["pass"]]));
  assert.equal(statusFor([report({ k: 1, cases })], KEY), "untested");
});
test("floor: a stub's report, or one with no driver, never sets status", () => {
  assert.equal(statusFor([report({ driver: "stub:good" })], KEY), "untested");
  assert.equal(statusFor([report({ driver: undefined })], KEY), "untested");
});
test("floor: an older spec's pass does not carry to the current key", () => {
  assert.equal(statusFor([report({ spec_hash: "old" })], KEY), "untested");
});
test("floor: a newer fail after an older pass is failed, and the reverse is passed", () => {
  const fail = withCase("onboard-repo", ["fail", "pass", "pass"], { at: "2026-11-14T10:00:00Z" });
  assert.equal(statusFor([report(), fail], KEY), "failed");
  assert.equal(statusFor([fail, report({ at: "2026-11-15T10:00:00Z" })], KEY), "passed");
});
test("floor: a report with no date is never the latest", () => {
  const undated = withCase("onboard-repo", ["fail", "fail", "fail"], { at: undefined });
  assert.equal(statusFor([report(), undated], KEY), "passed");
});
test("floor: a missing case is not a pass", () => {
  const partial = report();
  delete partial.cases["recover-error"];
  assert.equal(statusFor([partial], KEY), "untested");
});
test("floor: a model is its own key", () => {
  assert.equal(statusFor([report()], { ...KEY, model: "claude-sonnet-5-5" }), "untested");
});
test("runner: a run with no driver name is refused, and the report records its budget", async (t) => {
  await assert.rejects(
    runEval(runnerOptions(t, { driver: stubs.good, driverName: undefined, k: 1 })),
    /driverName/,
  );
  const { report } = await runEval(runnerOptions(t, { driver: stubs.good, k: 1, budget: 7 }));
  assert.equal(report.budget_usd, 7);
});

test("runner: a driver cost that is not a number is an infra error, not free", async (t) => {
  const driver = async (args) => {
    await stubs.good(args);
    return { cost_usd: "lots" };
  };
  const { report } = await runEval(runnerOptions(t, { driver, k: 1 }));
  assert.equal(report.complete, false);
  assert.match(report.reason, /driver reported cost lots/);
});

test("floor: a scalar case result, a string k or an unparsable front block never counts", (t) => {
  const scalar = report({ cases: Object.fromEntries(CASES.map((id) => [id, "pass"])) });
  assert.equal(statusFor([scalar], KEY), "untested");
  assert.equal(statusFor([report({ k: "3" })], KEY), "untested");
  const dir = tmp(t);
  writeFileSync(path.join(dir, "bad.md"), "---\nk: [unclosed\n---\n");
  assert.deepEqual(loadReports(dir), []);
});

test("floor: reports with the same time are ordered by number, so -10 is after -2", () => {
  const pass = { ...report(), file: "foreman-claude-2026-11-13-2.md" };
  const fail = {
    ...withCase("answer-card", ["fail", "fail", "fail"]),
    file: "foreman-claude-2026-11-13-10.md",
  };
  assert.equal(statusFor([fail, pass], KEY), "failed");
});

test("floor: a stray note and a CRLF report in the reports dir load without a throw", (t) => {
  const dir = tmp(t);
  writeFileSync(path.join(dir, "README.md"), "# Reports\n\nOne file per run.\n");
  writeFileSync(path.join(dir, "r0.md"), `---\r\n${stringify(report())}---\r\n`);
  const loaded = loadReports(dir);
  assert.deepEqual(
    loaded.map((r) => r.file),
    ["r0.md"],
  );
  assert.equal(statusFor(loaded, KEY), "passed");
});

// ---- registry check ------------------------------------------------------------------------

const MODELS = [{ model: "claude-opus-5-5", default: true }];
function setup(t, { rows, reports = [], built = "abc", models = MODELS }) {
  const dir = tmp(t);
  const reportDir = path.join(dir, "reports");
  const pack = path.join(dir, "pack.yml");
  const variants = path.join(dir, "variants.yml");
  writeFileSync(pack, stringify({ spec_hash: { "foreman-claude": built } }));
  writeFileSync(variants, stringify({ agent: "foreman-claude", models, variants: rows }));
  mkdirSync(reportDir);
  reports.forEach((r, i) =>
    writeFileSync(path.join(reportDir, `r${i}.md`), `---\n${stringify(r)}---\n`),
  );
  return { variants, pack, reports: reportDir };
}
const row = (over = {}) => ({ ...KEY, eval: "untested", report: null, at: null, ...over });
const passedRow = (over = {}) =>
  row({ eval: "passed", report: "r0.md", at: "2026-11-13T10:00:00Z", ...over });

test("registry: untested rows with no reports pass", (t) => {
  assert.deepEqual(checkRegistry(setup(t, { rows: [row()] })), []);
});
test("registry: a planted passed with no report fails", (t) => {
  assert.match(
    checkRegistry(setup(t, { rows: [passedRow()] })).join("\n"),
    /passed.*untested|untested.*passed/,
  );
});
test("registry: a row naming an older pass when a newer complete fail exists fails", (t) => {
  const fail = withCase("answer-card", ["fail", "fail", "fail"], { at: "2026-11-14T10:00:00Z" });
  assert.match(
    checkRegistry(setup(t, { rows: [passedRow()], reports: [report(), fail] })).join("\n"),
    /failed/,
  );
});
test("registry: a matching passed row passes", (t) => {
  assert.deepEqual(checkRegistry(setup(t, { rows: [passedRow()], reports: [report()] })), []);
});
test("registry: a passed row naming another key's report, or the wrong `at`, fails", (t) => {
  const other = report({ model: "claude-sonnet-5-5", complete: false });
  const p = setup(t, { rows: [passedRow({ report: "r1.md" })], reports: [report(), other] });
  assert.match(checkRegistry(p).join("\n"), /names report r1\.md.*deciding report is r0\.md/);
  const q = setup(t, { rows: [passedRow({ at: "1999" })], reports: [report()] });
  assert.match(checkRegistry(q).join("\n"), /at 1999/);
});
test("registry: a stub's passing report cannot back a passed row", (t) => {
  const p = setup(t, { rows: [passedRow()], reports: [report({ driver: "stub:good" })] });
  assert.match(checkRegistry(p).join("\n"), /reports say "untested"/);
});
test("registry: a row for a model not in models, or another runtime, fails", (t) => {
  const errors = checkRegistry(
    setup(t, { rows: [row(), row({ model: "gpt-x" }), row({ runtime: "codex" })] }),
  ).join("\n");
  assert.match(errors, /gpt-x .*model is not in models/);
  assert.match(errors, /runtime is not claude/);
});

test("registry: a duplicate row and a model with no row fail", (t) => {
  const models = [...MODELS, { model: "claude-sonnet-5-5", setting: "cheaper" }];
  const errors = checkRegistry(setup(t, { rows: [row(), row()], models })).join("\n");
  assert.match(errors, /duplicate row/);
  assert.match(errors, /claude-sonnet-5-5: no variants row/);
});
test("registry: a changed spec with a stale passed row fails", (t) => {
  assert.match(
    checkRegistry(setup(t, { rows: [passedRow()], reports: [report()], built: "def" })).join("\n"),
    /spec_hash/,
  );
});
test("registry: a row for another model with no reports cannot be passed", (t) => {
  const p = setup(t, { rows: [passedRow({ model: "claude-sonnet-5-5" })], reports: [report()] });
  assert.match(checkRegistry(p).join("\n"), /claude-sonnet-5-5/);
});

test("registry: the real pack passes its own check and the CLI exits 0", () => {
  assert.deepEqual(checkRegistry(), []);
  const script = new URL("check-registry.mjs", evals).pathname;
  assert.equal(spawnSync("node", [script], { encoding: "utf8" }).status, 0);
});
test("registry: the CLI names the file it checked and refuses a flag with no value", (t) => {
  const p = setup(t, { rows: [passedRow()] });
  const renamed = path.join(path.dirname(p.variants), "other.yml");
  writeFileSync(renamed, readFileSync(p.variants));
  const script = new URL("check-registry.mjs", evals).pathname;
  const r = spawnSync(
    "node",
    [script, "--variants", renamed, "--pack", p.pack, "--reports", p.reports],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^other\.yml: /m);
  assert.equal(spawnSync("node", [script, "--variants"], { encoding: "utf8" }).status, 2);
});
