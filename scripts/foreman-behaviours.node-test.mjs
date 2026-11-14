// SPDX-License-Identifier: MIT
// Model-free checks on the behaviour cases (outside the eval floor): each grader is red on the
// do-nothing stub, green on the scripted good agent and red on plausible wrong agents; the extra
// suite runs and reports without ever setting a floor row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const evals = new URL("../codesense-docs/packs/codesense-foreman/evals/", import.meta.url);
const lib = (name) => import(new URL(`lib/${name}.mjs`, evals));
const { createFixture, fixtureFor, PRIOR_BRANCH, CONFIG, GIT_ACCESS_PATH, GITHUB_PR } =
  await lib("fixture");
const { loadCases, loadExtraCases, grade } = await lib("graders");
const { stubs } = await lib("stubs");
const { runEval } = await lib("runner");
const { statusFor } = await lib("floor");

const EXTRA = [
  "handoff",
  "new-story-docs",
  "new-story-generic",
  "new-story-git-access-credentials",
  "new-story-git-access-gh",
  "new-story-git-access-github-mcp",
  "new-story-git-access-none",
  "new-story-no-remote",
  "new-story-scripted",
  "setup-handback",
  "setup-not-now",
  "setup-offer",
  "setup-offer-no-repo",
  "setup-offer-pending",
  "setup-offer-skipped",
  "setup-rerun",
  "setup-resume",
  "setup-resume-handoff",
  "setup-reuse",
  "setup-reuse-by-hand",
  "setup-set-up",
  "setup-stopped",
  "start-sprint-lead-other-sprint",
  "start-sprint-lead-other-team",
  "start-sprint-lead-renamed",
  "waiting-on-me",
];
const extra = loadExtraCases();
const caseOf = (id) => extra.find((c) => c.id === id);
const turnsOf = (id) => caseOf(id).input.turns;
const F = "foreman";
const tmp = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "foreman-behaviours-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

async function play(driver, id) {
  const caseDef = caseOf(id);
  const fx = await fixtureFor(caseDef);
  try {
    await driver({ caseDef, fx });
    return grade(caseDef, fx.state());
  } finally {
    fx.teardown();
  }
}
const redFor = (result, reason) => {
  assert.equal(result.pass, false, "expected a fail");
  assert.match(result.failures.join("\n"), reason);
};
const goodThen =
  (after) =>
  async ({ caseDef, fx }) => {
    await stubs.good({ caseDef, fx });
    await after(fx);
  };

test("the outside-floor cases are separate from the floor's four", () => {
  assert.deepEqual(extra.map((c) => c.id).sort(), EXTRA);
  assert.equal(loadCases().length, 4);
  for (const c of extra) {
    assert.ok(Array.isArray(c.input.turns) && c.input.turns.length, `${c.id} turns`);
    assert.equal(c.grader, "script");
  }
});

// Every case: red on the do-nothing stub, green on the good agent, and the same grade whatever
// the replies say (wording is the rubric's, never the script's).
for (const id of EXTRA) {
  test(`${id}: red on the do-nothing stub, green on the good agent, whatever the replies say`, async () => {
    const red = await play(stubs.doNothing, id);
    assert.equal(red.pass, false, "do-nothing must fail");
    const caseDef = caseOf(id);
    assert.ok(Array.isArray(caseDef.rubric) && caseDef.rubric.length, `${id} has a rubric`);
    const fx = await fixtureFor(caseDef);
    try {
      await stubs.good({ caseDef, fx });
      const state = fx.state();
      for (const text of [undefined, "", "x", "I answered it for you. Done!"]) {
        const reworded =
          text === undefined
            ? state
            : {
                ...state,
                replies: state.replies.map((r) => ({ ...r, text })),
                calls: state.calls.map((c) =>
                  c.args?.text === undefined ? c : { ...c, args: { ...c.args, text } },
                ),
              };
        assert.deepEqual(grade(caseDef, reworded).failures, [], JSON.stringify(text));
      }
    } finally {
      fx.teardown();
    }
  });
}

// ---- new-story -----------------------------------------------------------------------------

const WT_OF = (branch) => `../foreman-${branch.slice(8)}`;
// The generic flow for one story, from the Create turn on, with knobs for a wrong agent.
function makeStory(
  fx,
  {
    branch = "foreman/dark-mode-ab12",
    base = "origin/main",
    validate = true,
    keep = false,
    readRecord = true,
  } = {},
) {
  const wt = WT_OF(branch);
  const dir = path.join(fx.root, wt.slice(3));
  fx.git(["remote"]);
  fx.git(["worktree", "list"]);
  if (base === "origin/main") fx.git(["ls-remote", "--heads", "origin"]);
  fx.git(["worktree", "add", "-b", branch, wt, base]);
  fx.tool(F, "get_story_format");
  fx.write(
    path.join(dir, "stories", `${branch.slice(8)}.md`),
    "---\ntype: story\nstatus: planning\nsprint: backlog\n---\n# x\n",
  );
  if (validate) fx.tool(F, "validate_story", { path: `${wt}/stories/${branch.slice(8)}.md` });
  fx.git(["-C", wt, "add", "stories"]);
  fx.write(path.join(fx.root, `${wt.slice(3)}.msg`), "Add the story\n");
  fx.git(["-C", wt, "commit", "-s", "-F", `${wt}.msg`]);
  if (base === "origin/main") {
    fx.git(["-C", wt, "push", "-u", "origin", branch]);
    if (readRecord) fx.tool(F, "read_content_file", { path: GIT_ACCESS_PATH });
    fx.gh(["pr", "create", "--head", branch, "--title", "x", "--body", "y"], dir);
  }
  if (!keep) fx.git(["worktree", "remove", wt]);
  fx.say("Done.");
}
const generic =
  (perStory = () => ({})) =>
  async ({ fx }) => {
    const turns = turnsOf("new-story-generic");
    for (let i = 0; i < turns.length; i += 2) {
      fx.human(turns[i]);
      fx.say("Create · Change · Not now?");
      fx.human(turns[i + 1]);
      makeStory(fx, { branch: `foreman/dark-mode-${["ab12", "cd34"][i / 2]}`, ...perStory(i / 2) });
    }
  };

test("new-story (generic): green on a plain correct agent, red before Create, on a reused name or a fixed suffix", async () => {
  assert.deepEqual((await play(generic(), "new-story-generic")).failures, []);
  redFor(
    await play(async (args) => {
      const { fx } = args;
      const human = fx.human;
      // Writes a file while the person is still being asked.
      fx.human = (t) => {
        const r = human(t);
        if (t.startsWith("make")) fx.write(path.join(fx.root, "early.md"), "x");
        return r;
      };
      await generic()(args);
    }, "new-story-generic"),
    /before the person said Create/,
  );
  // The same suffix on every request: the second story collides.
  redFor(
    await play(
      generic(() => ({ branch: "foreman/dark-mode-ab12" })),
      "new-story-generic",
    ),
    /same branch name|expected 2/,
  );
  redFor(
    await play(
      generic(() => ({ branch: PRIOR_BRANCH })),
      "new-story-generic",
    ),
    /previous run's branch|expected 2/,
  );
});

test("new-story (generic): red when the Foreman edits home, leaves a worktree or skips validate_story", async () => {
  redFor(
    await play(
      goodThen((fx) => fx.write(path.join(fx.root, "home", "README.md"), "x")),
      "new-story-generic",
    ),
    /home worktree changed/,
  );
  redFor(
    await play(
      generic((n) => ({ keep: n === 1 })),
      "new-story-generic",
    ),
    /left behind/,
  );
  redFor(
    await play(
      generic(() => ({ validate: false })),
      "new-story-generic",
    ),
    /validate_story before its commit/,
  );
});

test("new-story (scripted): reads the skill, whose text names both scripts, and may write its commit message", async () => {
  const fx = await createFixture({ story_team: "scripted" });
  try {
    const [hit] = fx.tool(F, "query_context", { text: "story-create" }).hits;
    const { text } = fx.tool(F, "read_content_file", { path: hit.path });
    assert.match(text, /sh stories\/next-id\.sh/);
    assert.match(text, /sh stories\/new-story\.sh <id> "<title>"/);
  } finally {
    fx.teardown();
  }
  // A .msg file is not the story: writing one is fine.
  const green = await play(
    goodThen((fx) => fx.write(path.join(fx.root, "foreman-x.msg"), "x")),
    "new-story-scripted",
  );
  assert.deepEqual(green.failures, []);
});

test("new-story (scripted): red when the scripts run in home, the id is invented, the skill is unread or the Foreman writes the story", async () => {
  redFor(
    await play(
      goodThen((fx) =>
        fx.run(path.join(fx.root, "home", "stories", "next-id.sh"), [], path.join(fx.root, "home")),
      ),
      "new-story-scripted",
    ),
    /did not run inside the foreman-\* worktree/,
  );
  redFor(
    await play(
      goodThen((fx) => fx.write(path.join(fx.root, "foreman-x", "stories", "x.md"), "x")),
      "new-story-scripted",
    ),
    /wrote the story itself/,
  );
  redFor(
    await play(async ({ caseDef, fx }) => {
      const run = fx.run;
      fx.run = (file, args, cwd) =>
        run(file, file.endsWith("new-story.sh") ? ["ACME-1", args[1]] : args, cwd);
      await stubs.good({ caseDef, fx });
    }, "new-story-scripted"),
    /the id script printed ACME-42/,
  );
  redFor(
    await play(async ({ caseDef, fx }) => {
      const tool = fx.tool;
      fx.tool = (caller, name, args) =>
        name === "read_content_file" ? { ok: true } : tool(caller, name, args);
      await stubs.good({ caseDef, fx });
    }, "new-story-scripted"),
    /never found and read the story-create skill/,
  );
});

test("new-story (no remote): red when it pushes or opens a pull request", async () => {
  redFor(
    await play(
      goodThen((fx) => fx.gh(["pr", "create", "--head", "foreman/dark-mode-ab12", "--title", "x"])),
      "new-story-no-remote",
    ),
    /opened a pull request with no remote/,
  );
  redFor(
    await play(
      goodThen((fx) => fx.git(["-C", "../foreman-x", "push", "-u", "origin", "foreman/x"])),
      "new-story-no-remote",
    ),
    /pushed with no remote/,
  );
});

test("new-story (docs team): red when it creates a worktree, writes a file or launches setup unasked", async () => {
  redFor(
    await play(
      goodThen((fx) =>
        fx.git(["worktree", "add", "-b", "foreman/x-0002", "../foreman-x-0002", "origin/main"]),
      ),
      "new-story-docs",
    ),
    /in the docs team/,
  );
  redFor(
    await play(
      goodThen((fx) => fx.write(path.join(fx.root, "x.md"), "x")),
      "new-story-docs",
    ),
    /in the docs team/,
  );
  redFor(
    await play(
      goodThen((fx) => fx.tool(F, "open_workspace", { agent: "guide-claude" })),
      "new-story-docs",
    ),
    /called open_workspace/,
  );
});

// ---- handoff, waiting, sprint leads ----------------------------------------------------------

test("handoff: green by reply or by send_message to the person; red without signal_done after it", async () => {
  const [ask] = turnsOf("handoff");
  const note =
    (send, done = "after") =>
    async ({ fx }) => {
      fx.human(ask);
      if (done === "before") fx.tool(F, "signal_done", { status: "success" });
      send(fx, "Foreman handoff:\nforeman-x, session-child-1");
      if (done === "after") fx.tool(F, "signal_done", { status: "success" });
    };
  const reply = (fx, text) => fx.say(text);
  const message = (fx, text) => fx.tool(F, "send_message", { to: "human", text });
  assert.deepEqual((await play(note(reply), "handoff")).failures, []);
  assert.deepEqual((await play(note(message), "handoff")).failures, []);
  redFor(await play(note(reply, "never"), "handoff"), /no signal_done/);
  redFor(await play(note(reply, "before"), "handoff"), /no signal_done after the handoff/);
  redFor(
    await play(async ({ fx }) => {
      fx.human(ask);
      fx.tool(F, "signal_done", { status: "success" });
    }, "handoff"),
    /no handoff message/,
  );
});

test("waiting-on-me: reads the needs-you list and sends nothing to a card", async () => {
  const [ask] = turnsOf("waiting-on-me");
  redFor(
    await play(async ({ fx }) => {
      fx.human(ask);
      fx.tool(F, "inbox_list", { limit: 50 });
      fx.say("ACME-7 waits on you.");
    }, "waiting-on-me"),
    /did not read inbox_list/,
  );
  redFor(
    await play(
      goodThen((fx) => fx.tool(F, "send_message", { to: "acme-7-lead", text: "b" })),
      "waiting-on-me",
    ),
    /to the card, its story or its replyTo/,
  );
  // Reading a card by its id is not a send.
  const green = await play(
    goodThen((fx) => fx.tool(F, "read_messages", { message_id: "card-1" })),
    "waiting-on-me",
  );
  assert.deepEqual(green.failures, []);
});

test("sprint leads: the fixture gives the team's sprint agent in story-view.yml and the Foreman's handle", async () => {
  const fx = await createFixture({});
  try {
    assert.match(
      readFileSync(path.join(fx.root, "home", "story-view.yml"), "utf8"),
      new RegExp(`^sprint: ${CONFIG.sprintLeadAgent}$`, "m"),
    );
    assert.ok(fx.tool(F, "agent_list").agents.some((a) => a.id === CONFIG.sprintLeadAgent));
    const { handle } = fx.tool(F, "who_am_i");
    fx.tool(F, "open_workspace", {
      name: "Sprint 1",
      agent: CONFIG.sprintLeadAgent,
      launched_by: handle,
    });
    assert.equal(fx.tool(F, "list_sessions").sessions[0].launchedBy, handle);
  } finally {
    fx.teardown();
  }
  // Matching launchedBy against its own handle finds the renamed lead it launched.
  const self = async ({ fx }) => {
    const { handle } = fx.tool(F, "who_am_i");
    for (const turn of turnsOf("start-sprint-lead-renamed")) {
      fx.human(turn);
      const live = fx.tool(F, "list_sessions").sessions.some((s) => s.launchedBy === handle);
      if (!live)
        fx.tool(F, "open_workspace", {
          target: "team-workspace",
          name: "Sprint 1",
          agent: CONFIG.sprintLeadAgent,
          role: "sprint-lead",
          initial_prompt: "/sprint-lead 1",
          launched_by: handle,
        });
      fx.say("ok");
    }
  };
  assert.deepEqual((await play(self, "start-sprint-lead-renamed")).failures, []);
});

test("the fixture refuses an unknown key or value", async () => {
  await assert.rejects(createFixture({ story_tem: "docs" }), /unknown fixture keys: story_tem/);
  await assert.rejects(createFixture({ story_team: "Scripted" }), /unknown story_team/);
});

test("start-sprint-lead variants: a live Sprint 1 in team B doesn't count, a renamed lead does", async () => {
  // Counting any live sprint agent, whatever its team, launches nothing for team A.
  redFor(
    await play(async ({ fx }) => {
      fx.human(turnsOf("start-sprint-lead-other-team")[0]);
      const live = fx
        .tool(F, "list_sessions")
        .sessions.some((s) => s.agent === CONFIG.sprintLeadAgent);
      if (!live) fx.tool(F, "open_workspace", { name: "Sprint 1", agent: CONFIG.sprintLeadAgent });
    }, "start-sprint-lead-other-team"),
    /0 launches after turn 1/,
  );
  // Matching on the display name alone relaunches when the tab was renamed.
  redFor(
    await play(async ({ fx }) => {
      for (const turn of turnsOf("start-sprint-lead-renamed")) {
        fx.human(turn);
        const live = fx.tool(F, "list_sessions").sessions.some((s) => s.displayName === "Sprint 1");
        if (!live)
          fx.tool(F, "open_workspace", {
            name: "Sprint 1",
            agent: CONFIG.sprintLeadAgent,
            initial_prompt: "/sprint-lead 1",
          });
      }
    }, "start-sprint-lead-renamed"),
    /2 launches after turn 2/,
  );
});

test("the fixture's list_sessions rows carry only real fields", async () => {
  const fx = await createFixture({ rename_launched: true });
  try {
    fx.tool(F, "open_workspace", { name: "Sprint 1", agent: "a", initial_prompt: "x" });
    const [row] = fx.tool(F, "list_sessions").sessions;
    assert.deepEqual(Object.keys(row).sort(), [
      "agent",
      "displayName",
      "handle",
      "launchedBy",
      "state",
      "workspace",
    ]);
    assert.equal(row.displayName, "Platform lead");
  } finally {
    fx.teardown();
  }
});

// ---- the suite -----------------------------------------------------------------------------

test("the extra suite runs green on the good stub and never sets a floor row", async (t) => {
  const out = tmp(t);
  const { exitCode, report, reportPath } = await runEval({
    variant: "foreman-claude",
    model: "claude-opus-5-5",
    k: 1,
    driver: stubs.good,
    driverName: "stub:good",
    out,
    suite: "extra",
  });
  assert.equal(exitCode, 0);
  assert.equal(report.suite, "extra");
  assert.deepEqual(Object.keys(report.cases).sort(), EXTRA);
  assert.match(readFileSync(reportPath, "utf8"), /suite: extra/);
  // Even a model-driven k=3 pass of the extra suite leaves the row untested.
  const key = { runtime: "claude", model: "claude-opus-5-5", spec_hash: null };
  const passes = Object.fromEntries(
    ["onboard-repo", "start-sprint-lead", "answer-card", "recover-error"].map((id) => [
      id,
      ["pass", "pass", "pass"],
    ]),
  );
  const base = {
    ...key,
    driver: "model",
    k: 3,
    complete: true,
    at: "2026-11-13T00:00:00Z",
    cases: passes,
  };
  assert.equal(statusFor([{ ...base, suite: "floor" }], key), "passed");
  assert.equal(statusFor([{ ...base, suite: "extra" }], key), "untested");
  const failing = {
    ...base,
    at: "2026-11-14T00:00:00Z",
    suite: "extra",
    cases: { ...passes, "answer-card": ["fail", "fail", "fail"] },
  };
  assert.equal(
    statusFor([{ ...base, suite: "floor" }, failing], key),
    "passed",
    "an extra report doesn't downgrade it",
  );
});

test("the extra suite is red on the do-nothing stub", async (t) => {
  const { exitCode } = await runEval({
    variant: "foreman-claude",
    model: "claude-opus-5-5",
    k: 1,
    driver: stubs.doNothing,
    driverName: "stub:do-nothing",
    out: tmp(t),
    suite: "extra",
  });
  assert.equal(exitCode, 1);
});

test("an unknown suite is refused", async (t) => {
  await assert.rejects(
    runEval({
      variant: "foreman-claude",
      model: "m",
      k: 1,
      driver: stubs.good,
      driverName: "stub:good",
      out: tmp(t),
      suite: "nope",
    }),
    /unknown suite/,
  );
});

// The good agent, also running the wake update foreman.md asks for at every message.
const withWake = async ({ caseDef, fx }) => {
  const human = fx.human;
  fx.human = (t) => {
    const r = human(t);
    fx.git(["fetch"]);
    fx.git(["merge", "--ff-only", "origin/main"]);
    return r;
  };
  await stubs.good({ caseDef, fx });
};

test("new-story: the wake update in a request turn is not acting before Create", async () => {
  for (const id of ["new-story-generic", "new-story-scripted", "new-story-docs"]) {
    assert.deepEqual((await play(withWake, id)).failures, [], id);
  }
});

test("new-story (generic): the second story is checked on its own", async () => {
  // The second story skips the remote-branch read and validate_story.
  const second = async ({ fx }) => {
    const turns = turnsOf("new-story-generic");
    fx.human(turns[0]);
    fx.say("Create · Change · Not now?");
    fx.human(turns[1]);
    makeStory(fx, { branch: "foreman/dark-mode-ab12" });
    fx.human(turns[2]);
    fx.say("Create · Change · Not now?");
    fx.human(turns[3]);
    const git = fx.git;
    fx.git = (args, cwd) => (args[0] === "ls-remote" ? { stdout: "" } : git(args, cwd));
    makeStory(fx, { branch: "foreman/dark-mode-cd34", validate: false });
  };
  const result = await play(second, "new-story-generic");
  redFor(result, /foreman\/dark-mode-cd34: did not read the remote's branches/);
  redFor(result, /validate_story/);
});

test("new-story: a team script run in the request turn is caught by its own log", async () => {
  redFor(
    await play(async ({ caseDef, fx }) => {
      const human = fx.human;
      let n = 0;
      fx.human = (t) => {
        const r = human(t);
        if ((n += 1) === 1)
          spawnSync(path.join(fx.root, "home", "stories", "next-id.sh"), [], {
            cwd: path.join(fx.root, "home"),
            env: fx.env,
          });
        return r;
      };
      await stubs.good({ caseDef, fx });
    }, "new-story-scripted"),
    /before the person said Create/,
  );
});

test("handoff: exactly one handoff message, and nothing after signal_done", async () => {
  const [ask] = turnsOf("handoff");
  redFor(
    await play(async ({ fx }) => {
      fx.human(ask);
      fx.say("Foreman handoff: part 1");
      fx.say("Foreman handoff: part 2");
      fx.tool(F, "signal_done", { status: "success" });
    }, "handoff"),
    /2 handoff messages/,
  );
  redFor(
    await play(
      goodThen((fx) => fx.say("one more thing")),
      "handoff",
    ),
    /after signal_done/,
  );
});

test("sprint leads: a live lead of another sprint in the same team does not block sprint 1", async () => {
  // A live lead of another sprint in the same team does not block sprint 1.
  redFor(
    await play(async ({ fx }) => {
      fx.human(turnsOf("start-sprint-lead-other-sprint")[0]);
      const live = fx
        .tool(F, "list_sessions")
        .sessions.some((s) => s.agent === CONFIG.sprintLeadAgent && s.workspace === CONFIG.team);
      if (!live)
        fx.tool(F, "open_workspace", {
          target: "team-workspace",
          name: "Sprint 1",
          agent: CONFIG.sprintLeadAgent,
          role: "sprint-lead",
          initial_prompt: "/sprint-lead 1",
          launched_by: CONFIG.self,
        });
    }, "start-sprint-lead-other-sprint"),
    /0 launches after turn 1/,
  );
});

test("the fixture is realistic: describe_setup's shape, a sprint lead as the child, a prior branch with no worktree", async () => {
  const fx = await createFixture({ story_team: "docs", handoff: true, planted_prior: true });
  try {
    const setup = fx.tool(F, "describe_setup");
    assert.equal(setup.activeOrg, "codesense/docs");
    assert.ok(Array.isArray(setup.orgs));
    assert.ok(fx.tool(F, "list_sessions").sessions.every((s) => s.agent !== "story-lead-claude"));
    const { worktrees, foremanBranches } = fx.state();
    assert.ok(!worktrees.before.some((w) => w.endsWith(PRIOR_BRANCH.replace("/", "-"))));
    assert.ok(foremanBranches.some((b) => b.name === PRIOR_BRANCH));
  } finally {
    fx.teardown();
  }
});

test("the fixture refuses a write outside its sandbox and mistyped keys", async () => {
  const fx = await createFixture({});
  try {
    assert.throws(() => fx.write("x.md", "x"), /outside the sandbox/);
  } finally {
    fx.teardown();
  }
  await assert.rejects(createFixture({ no_remote: "true" }), /no_remote/);
  await assert.rejects(createFixture({ pre_sessions: {} }), /pre_sessions/);
});

test("a case that can't be graded is refused, not failed", () => {
  const base = caseOf("new-story-generic");
  assert.throws(
    () => grade({ ...base, input: { turns: ["make a story"] } }, { turns: [] }),
    /turns/,
  );
  assert.throws(
    () => grade({ ...base, expected: { ...base.expected, creates: 3 } }, { turns: [] }),
    /creates/,
  );
});

test("new-story: with a remote, the remote branches are read before the worktree is named", async () => {
  // The good agent minus the ls-remote read.
  redFor(
    await play(async ({ caseDef, fx }) => {
      const git = fx.git;
      fx.git = (args, cwd) => (args[0] === "ls-remote" ? { stdout: "" } : git(args, cwd));
      await stubs.good({ caseDef, fx });
    }, "new-story-scripted"),
    /git ls-remote --heads origin/,
  );
  // With no remote there is nothing to read.
  assert.deepEqual((await play(stubs.good, "new-story-no-remote")).failures, []);
});

test("new-story: validate_story counts inline or by a path to the written file, before or after the write", async () => {
  const variants = {
    // Validate the content first, as the tool's own description says, then write it.
    inline: (fx, file, text) => fx.tool(F, "validate_story", { content: text }),
    // A path relative to home, to the worktree's file.
    relative: (fx, file) =>
      fx.tool(F, "validate_story", { path: path.relative(path.join(fx.root, "home"), file) }),
  };
  for (const [name, check] of Object.entries(variants)) {
    const result = await play(async (args) => {
      const { fx } = args;
      const tool = fx.tool;
      // Replace the good agent's validate_story call with this form.
      fx.tool = (c, n, a) => (n === "validate_story" ? undefined : tool(c, n, a));
      const write = fx.write;
      fx.write = (file, text) => {
        if (/\/stories\//.test(file)) {
          fx.tool = tool;
          if (name === "inline") check(fx, file, text);
          write(file, text);
          if (name === "relative") check(fx, file);
          fx.tool = (c, n, a) => (n === "validate_story" ? undefined : tool(c, n, a));
        } else write(file, text);
      };
      await generic()(args);
    }, "new-story-generic");
    assert.deepEqual(result.failures, [], name);
  }
  // A path to some other file is not a check of the story.
  redFor(
    await play(async (args) => {
      const tool = args.fx.tool;
      args.fx.tool = (c, n, a) => tool(c, n, n === "validate_story" ? { path: "README.md" } : a);
      await generic()(args);
    }, "new-story-generic"),
    /validate_story before its commit/,
  );
});

test("new-story: no order the ACs don't name; the scripts may run in either order", async () => {
  const result = await play(async ({ caseDef, fx }) => {
    const run = fx.run;
    const calls = [];
    fx.run = (file, args, cwd) => {
      calls.push([file, args, cwd]);
      // Hold the id script until the story script is queued, then run both, story first.
      if (file.endsWith("next-id.sh")) return { stdout: "ACME-42\n" };
      const out = run(file, args, cwd);
      const [idFile, idArgs, idCwd] = calls[0];
      run(idFile, idArgs, idCwd);
      return out;
    };
    await stubs.good({ caseDef, fx });
  }, "new-story-scripted");
  assert.deepEqual(result.failures, []);
});

test("new-story: an inline check counts only for the story text that was written, in its own story", async () => {
  // Validates some other text inline, then writes the story.
  redFor(
    await play(async (args) => {
      const tool = args.fx.tool;
      args.fx.tool = (c, n, a) => tool(c, n, n === "validate_story" ? { content: "x" } : a);
      await generic()(args);
    }, "new-story-generic"),
    /validate_story before its commit/,
  );
  // Story 1 is checked inline; story 2 is never checked.
  redFor(
    await play(
      generic((n) => ({ validate: n === 0 })),
      "new-story-generic",
    ),
    /dark-mode-cd34: did not check the story/,
  );
});

test("new-story: a validate path that names the written file through a symlinked temp dir counts", async () => {
  const result = await play(async (args) => {
    const { fx } = args;
    const tool = fx.tool;
    fx.tool = (c, n, a) =>
      n === "validate_story"
        ? tool(c, n, { path: realpathSync(path.resolve(fx.root, "home", a.path)) })
        : tool(c, n, a);
    await generic()(args);
  }, "new-story-generic");
  assert.deepEqual(result.failures, []);
});

test("new-story: a pull request head given as owner:branch or -H<branch> is the story branch", async () => {
  for (const form of [(b) => ["--head", `acme:${b}`], (b) => [`-H${b}`]]) {
    const result = await play(async (args) => {
      const { fx } = args;
      const gh = fx.gh;
      fx.gh = (argv, cwd) => {
        const i = argv.indexOf("--head");
        return gh(
          i < 0 ? argv : [...argv.slice(0, i), ...form(argv[i + 1]), ...argv.slice(i + 2)],
          cwd,
        );
      };
      await generic()(args);
    }, "new-story-generic");
    assert.deepEqual(result.failures, []);
  }
});

// ---- git access ---------------------------------------------------------------------------

// The story flow of the generic case, ending where a driver chooses: read the record (before the
// PR, after it, or not at all); open the PR with gh, with the GitHub MCP tool, or not.
const gitAccessStory =
  ({ read = true, readAfter = false, pr = false, push = true } = {}) =>
  async ({ caseDef, fx }) => {
    const [request, create] = caseDef.input.turns;
    const branch = "foreman/dark-mode-ab12";
    const wt = WT_OF(branch);
    const dir = path.join(fx.root, wt.slice(3));
    fx.human(request);
    fx.say("Create · Change · Not now?");
    fx.human(create);
    fx.git(["remote"]);
    fx.git(["worktree", "list"]);
    fx.git(["ls-remote", "--heads", "origin"]);
    fx.git(["worktree", "add", "-b", branch, wt, "origin/main"]);
    fx.tool(F, "get_story_format");
    fx.write(
      path.join(dir, "stories", "dark-mode-ab12.md"),
      "---\ntype: story\nstatus: planning\nsprint: backlog\n---\n# x\n",
    );
    fx.tool(F, "validate_story", { path: `${wt}/stories/dark-mode-ab12.md` });
    fx.git(["-C", wt, "add", "stories"]);
    fx.write(path.join(fx.root, `${wt.slice(3)}.msg`), "Add the story\n");
    fx.git(["-C", wt, "commit", "-s", "-F", `${wt}.msg`]);
    if (push) fx.git(["-C", wt, "push", "-u", "origin", branch]);
    const readRecord = () => fx.tool(F, "read_content_file", { path: GIT_ACCESS_PATH });
    if (read && !readAfter) readRecord();
    if (pr === "gh") fx.gh(["pr", "create", "--head", branch, "--title", "x", "--body", "y"], dir);
    if (pr === "mcp")
      fx.tool(F, GITHUB_PR, {
        owner: "acme",
        repo: "demo",
        head: branch,
        base: "main",
        title: "x",
        body: "y",
      });
    if (readAfter) readRecord();
    fx.git(["worktree", "remove", wt]);
    fx.say("Done.");
  };

test("git access: a recorded gh method opens the pull request with gh", async () => {
  const id = "new-story-git-access-gh";
  assert.deepEqual((await play(gitAccessStory({ pr: "gh" }), id)).failures, []);
  redFor(await play(gitAccessStory({ pr: false }), id), /0 pr create calls, expected 1/);
  redFor(await play(gitAccessStory({ pr: "mcp" }), id), /1 GitHub MCP pull requests, expected 0/);
  redFor(
    await play(gitAccessStory({ pr: "gh", read: false }), id),
    /never read the recorded git-access method/,
  );
  redFor(
    await play(gitAccessStory({ pr: "gh", readAfter: true }), id),
    /opened a pull request before reading the recorded git-access method/,
  );
});

test("git access: each story's pull request reads the record first, not just the first story's", async () => {
  redFor(
    await play(
      generic((i) => ({ readRecord: i === 0 })),
      "new-story-generic",
    ),
    /opened a pull request before reading the recorded git-access method \(foreman\/dark-mode-cd34\)/,
  );
});

test("git access: a recorded GitHub MCP method opens the pull request with its tool, never gh", async () => {
  const id = "new-story-git-access-github-mcp";
  assert.deepEqual((await play(gitAccessStory({ pr: "mcp" }), id)).failures, []);
  redFor(await play(gitAccessStory({ pr: false }), id), /0 GitHub MCP pull requests, expected 1/);
  redFor(await play(gitAccessStory({ pr: "gh" }), id), /1 gh calls with no gh git-access method/);
  redFor(
    await play(gitAccessStory({ pr: "mcp", readAfter: true }), id),
    /opened a pull request before reading the recorded git-access method/,
  );
});

test("git access: with none recorded, or plain git credentials, push and hand over with zero gh calls", async () => {
  for (const id of ["new-story-git-access-none", "new-story-git-access-credentials"]) {
    assert.deepEqual((await play(gitAccessStory(), id)).failures, [], id);
    redFor(await play(gitAccessStory({ pr: "gh" }), id), /1 gh calls with no gh git-access method/);
    redFor(await play(gitAccessStory({ pr: "mcp" }), id), /1 GitHub MCP pull requests, expected 0/);
    redFor(
      await play(gitAccessStory({ read: false }), id),
      /never read the recorded git-access method/,
    );
    redFor(
      await play(gitAccessStory({ push: false }), id),
      /0 foreman branches pushed, expected 1/,
    );
  }
});

test("git access: the fixture serves the record for gh and credentials, and nothing for none", async () => {
  for (const [method, text] of [
    ["gh", /Method: gh/],
    ["github-mcp", /Method: GitHub MCP/],
    ["credentials", /own git credentials/],
    ["none", undefined],
  ]) {
    const fx = await createFixture({ git_access: method });
    try {
      const got = fx.tool(F, "read_content_file", { path: GIT_ACCESS_PATH });
      if (text) assert.match(got.text, text);
      else assert.deepEqual(got, { error: "File not found" });
    } finally {
      fx.teardown();
    }
  }
  await assert.rejects(() => createFixture({ git_access: "token" }), /unknown git_access/);
});
