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
import { spawn, spawnSync } from "node:child_process";
import { stringify } from "yaml";

const evals = new URL("../codesense-docs/packs/codesense-foreman/evals/", import.meta.url);
const lib = (name) => import(new URL(`lib/${name}.mjs`, evals));
const { createFixture, fixtureFor, CARDS, CONFIG, GIT_ACCESS_PATH } = await lib("fixture");
const { loadCases, grade, scriptView } = await lib("graders");
const { stubs } = await lib("stubs");
const { runEval, InfraError } = await lib("runner");
const { CASE_IDS, statusFor, parseReport, loadReports } = await lib("floor");
const { checkRegistry } = await lib("registry");

const CASES = CASE_IDS;
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
  const fx = await createFixture({ ...caseDef.fixture, ...fixtureOptions });
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
  const fx = await createFixture({ fail_first_pr: true });
  try {
    assert.equal(fx.gh(["api", "-X", "POST", "repos/acme/demo/pulls"]).status, 0);
    const first = fx.gh(["pr", "create", "--title", "x"]);
    const second = fx.gh(["pr", "create", "--title", "y"]);
    assert.equal(fx.gh(["pr", "list"]).status, 0);
    assert.notEqual(first.status, 0);
    assert.equal(second.status, 0);
    const calls = fx.state().ghCalls;
    assert.deepEqual(
      calls.map((c) => [c.argv[0], c.create, c.ok]),
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

test("fixture: the shim finds pr create after a repo flag, and --help spends no failure", async () => {
  const fx = await createFixture({ fail_first_pr: true });
  try {
    assert.equal(fx.gh(["pr", "create", "--help"]).status, 0);
    assert.notEqual(fx.gh(["pr", "-R", "acme/demo", "create", "--title", "t"]).status, 0);
    assert.deepEqual(
      fx.state().ghCalls.map((c) => [c.create, c.ok]),
      [
        [false, true],
        [true, false],
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

test("fixture: git refuses a cwd outside the sandbox", async () => {
  const fx = await createFixture();
  try {
    const outside = fx.git(["status"], os.tmpdir());
    assert.equal(outside.status, 128);
    assert.match(outside.stderr, /outside the eval sandbox/);
    assert.equal(fx.git(["status"]).status, 0);
    assert.equal(fx.git(["status"], path.join(fx.root, "home")).status, 0);
  } finally {
    fx.teardown();
  }
});

test("fixture: the shim logs a multi-line --body as valid JSON", async () => {
  const fx = await createFixture();
  try {
    fx.gh(["pr", "create", "--title", "t", "--body", 'line one\n\tline "two"\r\nend']);
    const [call] = fx.state().ghCalls;
    assert.equal(call.argv.at(-1), 'line one\n\tline "two"\r\nend');
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
  // This process's fixtures only: other test files make fixtures at the same time.
  const mine = (f) => f.startsWith(`foreman-eval-${process.pid}-`);
  const before = new Set(readdirSync(os.tmpdir()).filter(mine));
  await withEnv({ PATH: "/nonexistent" }, () => assert.rejects(createFixture()));
  const after = readdirSync(os.tmpdir()).filter((f) => mine(f) && !before.has(f));
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
    fx.tool("foreman", "send_message", { to: " Human", text: "there" });
    fx.tool("foreman", "send_message", { to: "acme-7-lead", text: "b" });
    assert.deepEqual(
      fx.state().replies.map((r) => r.text),
      ["hi", "there"],
    );
  } finally {
    fx.teardown();
  }
});

test("fixture: the agent's session id is the Foreman's own, whatever the parent had", async () => {
  const fx = await withEnv({ CODESENSE_TAB_SESSION_ID: "the-reviewers-own-session" }, () =>
    createFixture(),
  );
  try {
    assert.equal(fx.env.CODESENSE_TAB_SESSION_ID, CONFIG.self);
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
  org: "codesense/docs",
  team: "getting-started",
  name: "Setup",
  agent: "codesense/docs/getting-started/guide-claude",
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
    [{ agent: "sprint-lead-claude" }, /expected codesense\/docs\/getting-started\/guide-claude/],
    [{ agent: "guide-codex" }, /expected codesense\/docs\/getting-started\/guide-claude/],
    // A bare id or another team's key resolves to whatever guide that team defines.
    [{ agent: "guide-claude" }, /expected codesense\/docs\/getting-started\/guide-claude/],
    [{ agent: "acme/guide-claude" }, /expected codesense\/docs\/getting-started\/guide-claude/],
    [
      { org: undefined, team: undefined },
      /in undefined\/undefined, expected codesense\/docs\/getting-started/,
    ],
    [{ team: "acme" }, /in codesense\/docs\/acme, expected codesense\/docs\/getting-started/],
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

test("onboard-repo: green on the launch form, its camelCase aliases, an argument and a ledger write", async () => {
  const { initial_prompt: prompt, launched_by: self, ...rest } = SETUP;
  for (const launch of [
    SETUP,
    { ...rest, initialPrompt: prompt, launchedBy: self },
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
    // The real tools' own recipient arguments.
    ["send_role_message", { team: { org: "acme", team: "acme" }, role: c.replyTo }],
    ["post_agent_message", { role: c.replyTo }],
    ["workspace_chat_send", { workspace: `story:${c.story}` }],
    // Forms the host would resolve to the same recipient.
    ["send_message", { to: [[c.replyTo]] }],
    ["send_message", { to: `role: ${c.replyTo}` }],
    ["send_message", { to: `acme/${c.replyTo}` }],
    ["reply", { to: "human", message_id: c.id }],
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

test("answer-card: red when the answer is typed into the lead's terminal", async () => {
  for (const tool of ["run_in_terminal_tab"])
    redFor(
      await play(
        goodThen("answer-card", (fx) =>
          fx.tool("foreman", tool, { handle: CARDS[0].replyTo, command: "b" }),
        ),
        "answer-card",
      ),
      new RegExp(`called ${tool}`),
    );
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
  ({ before = [], attempt, after = [], replies = 1, remind = true, read = true } = {}) =>
  async ({ fx }) => {
    fx.human(turnsOf("recover-error")[0]);
    for (const step of before) step(fx);
    if (read) fx.tool("foreman", "read_content_file", { path: GIT_ACCESS_PATH });
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
    fx.tool("foreman", "read_content_file", { path: GIT_ACCESS_PATH });
    prCreate(fx);
    removeWt(fx);
    fx.tool("foreman", "send_message", { to: "human", text: "Failed. Retry?" });
    fx.human(turnsOf("recover-error")[1]);
    fx.tool("foreman", "send_message", { to: "human", text: "No timers." });
  }, "recover-error");
  assert.deepEqual(viaSend.failures, []);
});

test("recover-error: gh reads in any form are not writes; field writes and mutations are", async () => {
  for (const read of [
    ["--repo=acme/demo", "pr", "list"],
    ["-Racme/demo", "pr", "view", "1"],
    ["issue", "list"],
    ["run", "view", "7"],
    ["search", "prs", "readme"],
    ["api", "-X", "GET", "search/issues", "-f", "q=readme"],
    ["api", "repos/my-Xrepo/pulls"],
    ["api", "graphql", "-f", "query=query { viewer { login } }"],
    ["pr", "create", "--help"],
  ]) {
    const green = await play(
      recover({ before: [addWt], attempt: (fx) => (fx.gh(read), prCreate(fx)), after: [removeWt] }),
      "recover-error",
    );
    assert.deepEqual(green.failures, [], read.join(" "));
  }
  for (const write of [
    ["api", "repos/acme/demo/pulls", `-fhead=${BRANCH}`],
    ["api", "graphql", "-f", "query=mutation { createPullRequest }"],
    ["pr", "-R", "acme/demo", "create", "--title", "again"],
  ]) {
    redFor(
      await play(
        recover({
          before: [addWt],
          attempt: (fx) => (prCreate(fx), fx.gh(write)),
          after: [removeWt],
        }),
        "recover-error",
      ),
      /2 gh writes/,
    );
  }
});

test("recover-error: the head is the --head flag's value, with an owner prefix allowed", async () => {
  const green = await play(
    recover({
      before: [addWt],
      attempt: (fx) => prCreate(fx, ["--head", `acme:${BRANCH}`]),
      after: [removeWt],
    }),
    "recover-error",
  );
  assert.deepEqual(green.failures, []);
  const home = (fx) => path.join(fx.root, "home");
  redFor(
    await play(
      recover({
        before: [addWt],
        attempt: (fx) => prCreate(fx, ["--body", `see --head ${BRANCH}`], home(fx)),
        after: [removeWt],
      }),
      "recover-error",
    ),
    /opened from main, not a foreman branch/,
  );
});

test("answer-card: pane_write shows a pane and is not an answer", async () => {
  const green = await play(
    goodThen("answer-card", (fx) =>
      fx.tool("foreman", "pane_write", { id: "card", html: "<p>ACME-7</p>" }),
    ),
    "answer-card",
  );
  assert.deepEqual(green.failures, []);
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
      const fx = await fixtureFor(caseDef);
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

test("fixture: read_content_file answers any other path from the team's checkout, or not found", async () => {
  const fx = await createFixture();
  try {
    assert.equal(
      fx.tool("foreman", "read_content_file", { path: "story-view.yml" }).text,
      `sprint: ${CONFIG.sprintLeadAgent}\n`,
    );
    assert.equal(fx.tool("foreman", "read_content_file", { path: "./README.md" }).text, "# demo\n");
    for (const p of ["nope.md", "../origin.git/config", "/etc/hosts"])
      assert.deepEqual(
        fx.tool("foreman", "read_content_file", { path: p }),
        { error: "File not found" },
        p,
      );
  } finally {
    fx.teardown();
  }
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

test("floor: with the same time, a day's first report sorts before its -2", () => {
  const fail = {
    ...withCase("answer-card", ["fail", "fail", "fail"]),
    file: "foreman-claude-2026-11-13.md",
  };
  const pass = { ...report(), file: "foreman-claude-2026-11-13-2.md" };
  assert.equal(statusFor([pass, fail], KEY), "passed");
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

test("recover-error: red when the pull request is attempted before the recorded git-access method is read", async () => {
  redFor(
    await play(
      recover({ before: [addWt], attempt: prCreate, after: [removeWt], read: false }),
      "recover-error",
    ),
    /before reading the recorded git-access method/,
  );
});

// ---- the Claude driver ---------------------------------------------------------------------
// A fake `claude` stands in for the CLI: it reads the same flags, talks to the driver's MCP host
// over HTTP, runs git from its "Bash tool" (CLAUDECODE=1, as the real one sets), and prints
// stream-json. Each invocation plays the next turn of `scenario.json` beside it. A turn's
// `total_cost_usd` is what that turn spends; on `--resume` the fake reports the session's running
// total, as the real CLI does.

const { claudeDriver, launchArgs, loadAgent } = await lib("claude-driver");
const { claudeJudge } = await lib("judge");

const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const dir = __dirname;
const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const log = path.join(dir, "invocations.jsonl");
const n = existsSync(log) ? readFileSync(log, "utf8").split("\\n").filter(Boolean).length : 0;
appendFileSync(log, JSON.stringify({ argv, cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()), env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDECODE: process.env.CLAUDECODE ?? null, FOREMAN_EVAL_HOST: process.env.FOREMAN_EVAL_HOST ?? null } }) + "\\n");
const scenario = JSON.parse(readFileSync(path.join(dir, "scenario.json"), "utf8"));
const turn = scenario.turns[Math.min(n, scenario.turns.length - 1)];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const session = flag("--session-id") ?? flag("--resume") ?? "judge";
(async () => {
  const mcp = flag("--mcp-config") ? JSON.parse(flag("--mcp-config")).mcpServers : {};
  let id = 0;
  const rpc = async (server, method, params) => {
    const res = await fetch(mcp[server].url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    return (await res.json()).result;
  };
  const status = {};
  for (const name of Object.keys(mcp)) {
    try { await rpc(name, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } }); status[name] = "connected"; } catch { status[name] = "failed"; }
  }
  out({ type: "system", subtype: "init", session_id: session, mcp_servers: Object.entries({ ...status, ...(turn.mcp_status ?? {}) }).map(([name, s]) => ({ name, status: s })) });
  for (const step of turn.steps ?? []) {
    if (step.list) appendFileSync(path.join(dir, "answers.jsonl"), JSON.stringify((await rpc(step.list, "tools/list", {})).tools.map((t) => t.name)) + "\\n");
    if (step.tool) {
      const r = await rpc(step.server ?? "codesense", "tools/call", { name: step.tool, arguments: step.args ?? {} });
      appendFileSync(path.join(dir, "answers.jsonl"), JSON.stringify(r) + "\\n");
    }
    if (step.bash) {
      const r = spawnSync("sh", ["-c", step.bash], { cwd: process.cwd(), env: { ...process.env, CLAUDECODE: "1" }, encoding: "utf8" });
      appendFileSync(path.join(dir, "answers.jsonl"), JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }) + "\\n");
    }
    // A process left in the fake's group: "hold" keeps the fake's stdout open, "free" does not.
    if (step.grandchild) {
      const kid = spawn("sleep", ["15"], { stdio: step.grandchild === "hold" ? ["ignore", "inherit", "inherit"] : "ignore" });
      kid.unref();
      writeFileSync(path.join(dir, "pids.json"), JSON.stringify({ fake: process.pid, grandchild: kid.pid }));
    }
    if (step.sleep) await new Promise((r) => setTimeout(r, step.sleep));
  }
  if (turn.stdout !== undefined) process.stdout.write(turn.stdout);
  if (turn.result) {
    const costFile = path.join(dir, "cost-" + session);
    const before = argv.includes("--resume") && existsSync(costFile) ? Number(readFileSync(costFile, "utf8")) : 0;
    const spent = turn.result.total_cost_usd;
    const total = typeof spent === "number" ? before + spent : spent;
    if (typeof total === "number") writeFileSync(costFile, String(total));
    out({ type: "result", session_id: session, ...turn.result, total_cost_usd: total });
  }
  process.exit(turn.exit ?? 0);
})();
`;

// A fake claude in its own dir, playing `turns` (one entry per invocation).
function fakeClaude(t, turns) {
  const dir = tmp(t);
  const bin = path.join(dir, "claude");
  writeFileSync(bin, FAKE_CLAUDE, { mode: 0o755 });
  writeFileSync(path.join(dir, "scenario.json"), JSON.stringify({ turns }));
  const lines = (name) =>
    existsSync(path.join(dir, name))
      ? readFileSync(path.join(dir, name), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  return {
    bin,
    invocations: () => lines("invocations.jsonl"),
    answers: () => lines("answers.jsonl"),
    pids: () =>
      existsSync(path.join(dir, "pids.json"))
        ? JSON.parse(readFileSync(path.join(dir, "pids.json"), "utf8"))
        : undefined,
  };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// True once `pid` is gone, polling for up to `ms`.
async function gone(pid, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
  }
  return false;
}
const ok = (cost = 0.1, extra = {}) => ({
  result: {
    subtype: "success",
    is_error: false,
    total_cost_usd: cost,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
    },
    ...extra,
  },
});
const reply = (text) => ({ tool: "reply", args: { text } });
// Plays a case with the driver in a fresh fixture and returns the outcome and the state.
async function drive(t, id, turns, options = {}, driveArgs = {}) {
  const fake = fakeClaude(t, turns);
  const caseDef = caseOf(id);
  const fx = await createFixture(caseDef.fixture ?? {});
  t.after(() => fx.teardown());
  const driver = claudeDriver({ model: "claude-sonnet-5-5", bin: fake.bin, ...options });
  let spent;
  let error;
  try {
    spent = await driver({ caseDef, fx, ...driveArgs });
  } catch (e) {
    error = e;
  }
  return { fake, fx, spent, error, state: fx.state(), caseDef };
}

test("claude driver: launches with the agent's own prompt, permissions and model, home as cwd", async (t) => {
  const { fake, fx, error } = await drive(t, "onboard-repo", [ok()]);
  assert.equal(error, undefined);
  const [{ argv, cwd, env }] = fake.invocations();
  const agent = loadAgent();
  const flag = (name) => argv[argv.indexOf(name) + 1];
  assert.equal(flag("--model"), "claude-sonnet-5-5");
  assert.equal(
    flag("--append-system-prompt"),
    readFileSync(new URL("../foreman.md", evals), "utf8"),
  );
  assert.equal(
    flag("--setting-sources"),
    "local",
    "no user or project settings, hooks or CLAUDE.md",
  );
  assert.ok(argv.includes("--strict-mcp-config"));
  assert.equal(flag("--add-dir"), "..");
  const settings = JSON.parse(flag("--settings"));
  assert.deepEqual(settings.permissions, agent.permissions.claude);
  assert.equal(settings.env.HOME, fx.env.HOME, "the agent's shell keeps the sandbox HOME");
  assert.equal(settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(
    argv.at(-1),
    `[inbox t1] You have 1 new message. Call read_messages with session_id ${CONFIG.self}.`,
  );
  assert.equal(path.basename(cwd), "home");
  assert.ok(env.PATH.startsWith(path.join(fx.root, "eval-bin")), "the git shim is first on PATH");
  assert.equal(env.CLAUDECODE, null, "a nested CLI does not inherit the outer session's markers");
  assert.deepEqual(launchArgs(agent, "claude-opus-5-5").slice(0, 2), [
    "--model",
    "claude-opus-5-5",
  ]);
});

test("claude driver: every turn is played, MCP and git calls are captured in order, cost and tokens summed", async (t) => {
  const { fake, spent, error, state, caseDef } = await drive(t, "answer-card", [
    {
      ...ok(0.25),
      steps: [
        { bash: "git fetch" },
        { tool: "inbox_list", args: { kind: "needs-you" } },
        { tool: "reply", args: { text: "ACME-7 asks..." } },
      ],
    },
    { ...ok(0.5), steps: [reply("Answer it on the page.")] },
  ]);
  assert.equal(error, undefined);
  // The CLI reports 0.25 then 0.75 (the session's total), so the run spent 0.75, not 1.
  assert.deepEqual(spent.cost_usd, 0.75);
  assert.equal(spent.tokens, 40);
  assert.match(spent.session, /^[0-9a-f-]{36}$/);
  const [first, second] = fake.invocations();
  assert.equal(first.argv[first.argv.indexOf("--session-id") + 1], spent.session);
  assert.equal(second.argv[second.argv.indexOf("--resume") + 1], spent.session);
  assert.deepEqual(
    state.calls.map((c) => [c.turn, c.tool]),
    [
      [1, "git"],
      [1, "inbox_list"],
      [1, "reply"],
      [2, "reply"],
    ],
  );
  assert.deepEqual(state.calls[0].args.argv, ["fetch"]);
  assert.deepEqual(
    state.turns.map((x) => x.text),
    caseDef.input.turns,
  );
  assert.equal(grade(caseDef, state).pass, true);
});

test("claude driver: each turn arrives as the person's inbox mail, read once with read_messages", async (t) => {
  const { fake, state, error } = await drive(t, "answer-card", [
    {
      ...ok(),
      steps: [
        { tool: "read_messages" },
        { tool: "read_messages" },
        { tool: "reply", args: { message_id: 7001, text: "x" } },
      ],
    },
    { ...ok(), steps: [{ tool: "read_messages" }] },
  ]);
  assert.equal(error, undefined);
  const [first, again, sent, second] = fake.answers().map((a) => JSON.parse(a.content[0].text));
  const [one, two] = turnsOf("answer-card");
  assert.deepEqual(first.messages, [
    { messageId: 7001, from: "human", fromName: "You", text: one },
  ]);
  assert.deepEqual(again.messages, [], "mail is returned once");
  assert.equal(sent.status, "sent");
  assert.deepEqual(
    second.messages.map((m) => [m.messageId, m.text]),
    [[7002, two]],
  );
  assert.match(fake.invocations()[1].argv.at(-1), /^\[inbox t2\] You have 1 new message\./);
  assert.deepEqual(
    state.replies.map((r) => r.turn),
    [1],
  );
});

test("claude driver: state reads are answered from the sandbox profile, tools carry the real schemas", async (t) => {
  const { fake, error } = await drive(t, "onboard-repo", [
    {
      ...ok(),
      steps: [
        { list: "codesense" },
        { tool: "list_source_repos" },
        { tool: "who_am_i" },
        { tool: "read_content_file", args: { path: "tools/git-access.md" } },
      ],
    },
  ]);
  assert.equal(error, undefined);
  const [names, repos, me, missing] = fake.answers();
  for (const tool of [
    "open_workspace",
    "list_sessions",
    "inbox_list",
    "reply",
    "run_in_terminal_tab",
  ])
    assert.ok(names.includes(tool), tool);
  assert.deepEqual(JSON.parse(repos.content[0].text).repos[0].repo, "acme/demo");
  assert.equal(JSON.parse(me.content[0].text).handle, CONFIG.self);
  assert.equal(missing.isError, true, "a fixture error is an MCP tool error");
  const { tools } = JSON.parse(readFileSync(new URL("lib/tool-schemas.json", evals), "utf8"));
  const open = tools.find((x) => x.name === "open_workspace");
  for (const arg of ["target", "agent", "initial_prompt", "launched_by", "mode"])
    assert.ok(arg in open.inputSchema.properties, arg);
});

test("claude driver: a GitHub MCP case gets the github server, logged by its full name", async (t) => {
  const fake = fakeClaude(t, [
    {
      ...ok(),
      steps: [
        {
          server: "github",
          tool: "create_pull_request",
          args: { owner: "acme", repo: "demo", head: "foreman/x-0a1b", base: "main", title: "t" },
        },
      ],
    },
  ]);
  const caseDef = {
    id: "pr",
    fixture: { git_access: "github-mcp" },
    input: { turns: ["open it"] },
  };
  const fx = await createFixture(caseDef.fixture);
  t.after(() => fx.teardown());
  await claudeDriver({ model: "claude-sonnet-5-5", bin: fake.bin })({ caseDef, fx });
  assert.deepEqual(
    fx.state().calls.map((c) => c.tool),
    ["mcp__github__create_pull_request"],
  );
  const [{ argv }] = fake.invocations();
  assert.deepEqual(
    Object.keys(JSON.parse(argv[argv.indexOf("--mcp-config") + 1]).mcpServers).sort(),
    ["codesense", "github"],
  );
});

test("claude driver: git from a team script, or outside the agent's shell, is not logged as the Foreman's", async (t) => {
  const { state, error } = await drive(t, "onboard-repo", [
    {
      ...ok(),
      steps: [
        {
          bash: "mkdir -p stories && printf 'git status >/dev/null\\n' > stories/probe.sh && sh stories/probe.sh",
        },
        { bash: "CLAUDECODE= git status >/dev/null" },
        { bash: "git worktree list" },
      ],
    },
  ]);
  assert.equal(error, undefined);
  assert.deepEqual(
    state.calls.map((c) => c.args.argv),
    [["worktree", "list"]],
  );
});

const infra = (r, pattern) => {
  assert.ok(r.error instanceof InfraError, `expected an InfraError, got ${r.error}`);
  assert.match(r.error.message, pattern);
};

test("claude driver: a missing CLI, an API error or a dead MCP server is an InfraError with its spend", async (t) => {
  const fx = await createFixture();
  t.after(() => fx.teardown());
  await assert.rejects(
    claudeDriver({ model: "m", bin: path.join(tmp(t), "no-claude") })({
      caseDef: caseOf("onboard-repo"),
      fx,
    }),
    (e) => e instanceof InfraError && /could not start/.test(e.message),
  );
  const loggedOut = await drive(t, "onboard-repo", [
    {
      result: {
        subtype: "success",
        is_error: true,
        result: "Not logged in · Please run /login",
        total_cost_usd: 0,
      },
    },
  ]);
  infra(loggedOut, /Not logged in/);
  const apiDown = await drive(t, "answer-card", [
    ok(0.2),
    { result: { subtype: "error_during_execution", is_error: true, total_cost_usd: 0.05 } },
  ]);
  infra(apiDown, /error_during_execution/);
  assert.ok(Math.abs(apiDown.error.cost_usd - 0.25) < 1e-9, "spend so far rides on the error");
  const mcpDown = await drive(t, "onboard-repo", [
    { ...ok(), mcp_status: { codesense: "failed" } },
  ]);
  infra(mcpDown, /MCP server codesense failed/);
  const noResult = await drive(t, "onboard-repo", [{ exit: 1 }]);
  infra(noResult, /no result/);
  assert.equal(noResult.error.cost_usd, 3, "a turn with no result is charged its cap");
  const badCost = await drive(t, "onboard-repo", [ok("x")]);
  infra(badCost, /cost/);
});

test("claude driver: the agent running out of turns is graded, not an infra error", async (t) => {
  const r = await drive(t, "onboard-repo", [
    { result: { subtype: "error_max_turns", is_error: true, total_cost_usd: 0.3, usage: {} } },
  ]);
  assert.equal(r.error, undefined);
  assert.equal(r.spent.cost_usd, 0.3);
  assert.equal(grade(r.caseDef, r.state).pass, false);
});

test("claude driver: a turn past its timeout is killed with its whole process group and is an InfraError", async (t) => {
  const started = Date.now();
  // The grandchild holds the fake's stdout, so only a group kill ends the turn on time.
  const r = await drive(
    t,
    "onboard-repo",
    [{ ...ok(), steps: [{ grandchild: "hold" }, { sleep: 20000 }] }],
    { timeoutMs: 400 },
    { budgetLeft: 2 },
  );
  infra(r, /timed out after 0\.4s/);
  assert.ok(Date.now() - started < 10000, "did not wait for the child");
  assert.ok(await gone(r.fake.pids().grandchild), "the grandchild was killed with the group");
  assert.equal(r.error.cost_usd, 2, "a timed-out turn is charged its cap");
});

test("claude driver: a turn that exits normally has what it left in its process group reaped", async (t) => {
  const r = await drive(t, "onboard-repo", [{ ...ok(), steps: [{ grandchild: "free" }] }]);
  assert.equal(r.error, undefined);
  assert.ok(await gone(r.fake.pids().grandchild), "the grandchild was reaped");
});

test("claude driver: each turn's budget is the smaller of the run cap and what the runner has left", async (t) => {
  const { fake, spent } = await drive(
    t,
    "answer-card",
    [ok(0.5), ok(0.5)],
    { runCapUsd: 3 },
    { budgetLeft: 2 },
  );
  const caps = fake
    .invocations()
    .map(({ argv }) => Number(argv[argv.indexOf("--max-budget-usd") + 1]));
  // The CLI checks the cap against the session's total, so every turn gets the same one.
  assert.deepEqual(caps, [2, 2]);
  assert.equal(spent.cost_usd, 1);
  const capped = await drive(
    t,
    "onboard-repo",
    [{ result: { subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 1 } }],
    {},
    { budgetLeft: 1 },
  );
  infra(capped, /budget/);
  const runaway = await drive(
    t,
    "onboard-repo",
    [{ result: { subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 3 } }],
    { runCapUsd: 3 },
  );
  assert.equal(runaway.error, undefined, "a run that hits its own cap is graded");
});

test("runner: an infra error is retried once in a fresh fixture, and its spend counts", async (t) => {
  let calls = 0;
  const roots = new Set();
  const driver = async ({ caseDef, fx }) => {
    roots.add(fx.root);
    if (caseDef.id === "answer-card" && (calls += 1) === 1)
      throw Object.assign(new InfraError("api blip"), { cost_usd: 0.5 });
    await stubs.good({ caseDef, fx });
    return { cost_usd: 1 };
  };
  const { report, exitCode } = await runEval(runnerOptions(t, { driver, k: 1 }));
  assert.equal(exitCode, 0);
  assert.equal(report.complete, true);
  assert.deepEqual(report.cases["answer-card"], ["pass"]);
  assert.equal(report.cost_usd, 4.5);
  assert.equal(roots.size, 5);
});

test("runner: a second infra error stops the run, so nothing more is spent", async (t) => {
  const seen = [];
  const driver = async ({ caseDef, fx }) => {
    seen.push(caseDef.id);
    if (caseDef.id === "onboard-repo") throw new InfraError("sandbox would not start");
    await stubs.good({ caseDef, fx });
    return { cost_usd: 1 };
  };
  const { report } = await runEval(runnerOptions(t, { driver, k: 3 }));
  assert.deepEqual(seen, ["answer-card", "onboard-repo", "onboard-repo"]);
  assert.deepEqual(report.cases["onboard-repo"], ["error"]);
  assert.deepEqual(report.cases["recover-error"], []);
  assert.equal(report.complete, false);
  assert.match(
    report.reason,
    /infra error in onboard-repo run 1 \(after a retry\): sandbox would not start/,
  );
});

test("runner: the driver is told how much budget is left", async (t) => {
  const left = [];
  const driver = async ({ caseDef, fx, budgetLeft }) => {
    left.push(budgetLeft);
    await stubs.good({ caseDef, fx });
    return { cost_usd: 1.5 };
  };
  await runEval(runnerOptions(t, { driver, k: 1, budget: 10 }));
  assert.deepEqual(left, [10, 8.5, 7, 5.5]);
});

test("runner: the judge's rubric verdicts are reported beside the script grade and never change it", async (t) => {
  const judged = [];
  const judge = async ({ caseDef, turns, replies }) => {
    judged.push([caseDef.id, turns.length, replies.length]);
    const verdicts = Object.fromEntries(caseDef.rubric.map((r) => [r.id, "fail"]));
    return {
      verdicts,
      why: Object.fromEntries(caseDef.rubric.map((r) => [r.id, "it did not say so"])),
      cost_usd: 0.25,
    };
  };
  const { report, exitCode, reportPath } = await runEval(
    runnerOptions(t, { driver: stubs.good, judge, k: 1 }),
  );
  assert.equal(exitCode, 0, "rubric fails leave the script grade green");
  assert.deepEqual(report.cases["answer-card"], ["pass"]);
  assert.deepEqual(report.rubric["answer-card"][0]["names-story"], "fail");
  assert.equal(report.cost_usd, 1);
  assert.deepEqual(
    judged.find(([id]) => id === "answer-card"),
    ["answer-card", 2, 2],
  );
  assert.match(
    readFileSync(reportPath, "utf8"),
    /## Rubric[\s\S]*answer-card run 1 names-story: it did not say so/,
  );
});

test("runner: a judge that throws marks the rubric as error and the run goes on", async (t) => {
  const judge = async () => {
    throw new Error("judge down");
  };
  const { report, exitCode } = await runEval(runnerOptions(t, { driver: stubs.good, judge, k: 1 }));
  assert.equal(exitCode, 0);
  assert.equal(report.complete, true);
  assert.deepEqual(report.rubric["onboard-repo"], [{ "says-setup-started": "error" }]);
});

test("runner: a failed judge's spend counts, and the judge is told how much budget is left", async (t) => {
  const left = [];
  const judge = async ({ budgetLeft }) => {
    left.push(budgetLeft);
    throw Object.assign(new Error("judge: no verdict"), { cost_usd: 0.25 });
  };
  const driver = async ({ caseDef, fx }) => {
    await stubs.good({ caseDef, fx });
    return { cost_usd: 1 };
  };
  const { report } = await runEval(runnerOptions(t, { driver, judge, k: 1, budget: 10 }));
  assert.equal(report.cost_usd, 5);
  assert.deepEqual(left, [9, 7.75, 6.5, 5.25]);
});

test("runner: the judge is skipped once the budget is spent", async (t) => {
  let judged = 0;
  const judge = async () => {
    judged += 1;
    return { verdicts: {}, cost_usd: 0 };
  };
  const driver = async ({ caseDef, fx }) => {
    await stubs.good({ caseDef, fx });
    return { cost_usd: 1 };
  };
  const { report, reportPath } = await runEval(
    runnerOptions(t, { driver, judge, k: 1, budget: 1 }),
  );
  assert.equal(judged, 0);
  const [first] = Object.keys(report.rubric).filter((id) => report.rubric[id].length);
  assert.ok(Object.values(report.rubric[first][0]).every((v) => v === "error"));
  assert.match(readFileSync(reportPath, "utf8"), /the judge was skipped: no budget left/);
});

test("judge: asks for each rubric item with the transcript, and reads the structured verdicts", async (t) => {
  const caseDef = caseOf("start-sprint-lead");
  const fake = fakeClaude(t, [
    ok(0.03, {
      structured_output: {
        verdicts: [
          { id: "says-lead-started", pass: true, why: "it says so" },
          { id: "says-already-running", pass: false, why: "it started another" },
        ],
      },
    }),
  ]);
  const out = await claudeJudge({ bin: fake.bin })({
    caseDef,
    turns: [
      { index: 1, text: "start sprint 1" },
      { index: 2, text: "start sprint 1" },
    ],
    replies: [
      { turn: 1, text: "Started the sprint 1 lead." },
      { turn: 2, text: "Started it again." },
    ],
  });
  assert.deepEqual(out.verdicts, { "says-lead-started": "pass", "says-already-running": "fail" });
  assert.equal(out.why["says-already-running"], "it started another");
  assert.equal(out.cost_usd, 0.03);
  const [{ argv }] = fake.invocations();
  const prompt = argv.at(-1);
  assert.match(prompt, /says-already-running/);
  assert.match(prompt, /Started it again\./);
  assert.equal(argv[argv.indexOf("--tools") + 1], "", "the judge gets no tools");
  assert.ok(JSON.parse(argv[argv.indexOf("--json-schema") + 1]).properties.verdicts);
  assert.equal(argv[argv.indexOf("--max-budget-usd") + 1], "0.5");
  const missing = fakeClaude(t, [ok(0.01, { structured_output: { verdicts: [] } })]);
  await assert.rejects(
    claudeJudge({ bin: missing.bin })({ caseDef, turns: [], replies: [] }),
    (e) => /no verdict for says-lead-started/.test(e.message) && e.cost_usd === 0.01,
  );
});

test("judge: its cap is what the runner has left, at most $0.50, and a result-less run is charged it", async (t) => {
  const caseDef = caseOf("start-sprint-lead");
  const fake = fakeClaude(t, [{ exit: 1 }]);
  await assert.rejects(
    claudeJudge({ bin: fake.bin })({ caseDef, turns: [], replies: [], budgetLeft: 0.2 }),
    (e) => /no result/.test(e.message) && e.cost_usd === 0.2,
  );
  const [{ argv }] = fake.invocations();
  assert.equal(argv[argv.indexOf("--max-budget-usd") + 1], "0.2");
});

test("judge: runs in an empty temp dir, removed after, so no local settings load", async (t) => {
  const caseDef = caseOf("onboard-repo");
  const fake = fakeClaude(t, [
    ok(0.01, {
      structured_output: { verdicts: [{ id: "says-setup-started", pass: true, why: "ok" }] },
    }),
  ]);
  await claudeJudge({ bin: fake.bin })({ caseDef, turns: [], replies: [] });
  const [{ cwd, cwdEntries }] = fake.invocations();
  assert.notEqual(cwd, process.cwd());
  assert.deepEqual(cwdEntries, []);
  assert.equal(existsSync(cwd), false);
});

test("run.sh: the claude driver is accepted and its report records the driver and model", (t) => {
  const script = new URL("run.sh", evals).pathname;
  const fake = fakeClaude(t, [{ exit: 1 }]);
  const out = tmp(t);
  const logs = tmp(t);
  const r = spawnSync(
    "sh",
    [
      script,
      "foreman-claude",
      "--driver",
      "claude",
      "--model",
      "claude-sonnet-5-5",
      "--k",
      "1",
      "--out",
      out,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, FOREMAN_EVAL_CLAUDE: fake.bin, FOREMAN_EVAL_LOGS: logs },
    },
  );
  assert.equal(r.status, 1, r.stderr);
  assert.equal(readdirSync(logs).length, 2, "both attempts' transcripts land in FOREMAN_EVAL_LOGS");
  assert.match(r.stdout, /incomplete \(infra error in answer-card run 1 \(after a retry\)/);
  const [file] = readdirSync(out);
  const front = parseReport(readFileSync(path.join(out, file), "utf8"));
  assert.equal(front.driver, "claude");
  assert.equal(front.model, "claude-sonnet-5-5");
});

test("run.sh: SIGTERM ends the running claude and what it started", async (t) => {
  const script = new URL("run.sh", evals).pathname;
  const fake = fakeClaude(t, [{ ...ok(), steps: [{ grandchild: "free" }, { sleep: 20000 }] }]);
  const args = [script, "foreman-claude", "--driver", "claude", "--k", "1", "--out", tmp(t)];
  const env = { ...process.env, FOREMAN_EVAL_CLAUDE: fake.bin, FOREMAN_EVAL_LOGS: tmp(t) };
  const runner = spawn("sh", args, { env, stdio: "ignore" });
  const exited = new Promise((resolve) => runner.on("exit", resolve));
  for (const end = Date.now() + 10000; !fake.pids() && Date.now() < end; ) await sleep(50);
  const pids = fake.pids();
  assert.ok(pids, "the fake started its grandchild");
  runner.kill("SIGTERM");
  await exited;
  assert.ok(await gone(pids.fake), "the claude process was killed");
  assert.ok(await gone(pids.grandchild), "its grandchild was killed");
});
