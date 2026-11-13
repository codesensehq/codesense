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
const { createFixture, CARDS } = await lib("fixture");
const { loadCases, grade } = await lib("graders");
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

test("fixture: the shim records a call and fails the first pr create when told to", async () => {
  const fx = await createFixture({ failFirstPr: true });
  try {
    const first = fx.gh(["pr", "create", "--title", "x"]);
    const second = fx.gh(["pr", "create", "--title", "y"]);
    assert.notEqual(first.status, 0);
    assert.equal(second.status, 0);
    const calls = fx.state().ghCalls;
    assert.deepEqual(
      calls.map((c) => c.ok),
      [false, true],
    );
    assert.equal(fx.gh(["pr", "list"]).status, 0);
    assert.equal(fx.state().ghCalls.length, 2, "only pr create is recorded");
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

test("fixture: HOME is inside the sandbox, ~/code/demo exists there, and tokens are dropped", async () => {
  const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.GH_TOKEN = "planted";
  process.env.GITHUB_TOKEN = "planted";
  const fx = await createFixture();
  try {
    assert.ok(fx.env.HOME.startsWith(fx.root));
    assert.ok(existsSync(path.join(fx.env.HOME, "code", "demo", ".git")));
    assert.equal(fx.env.GH_TOKEN, undefined);
    assert.equal(fx.env.GITHUB_TOKEN, undefined);
    assert.equal(fx.state().env.PATH.split(path.delimiter)[0], path.join(fx.root, "bin"));
  } finally {
    fx.teardown();
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});

test("fixture: a failed setup removes its temp dir", async () => {
  const before = new Set(readdirSync(os.tmpdir()).filter((f) => f.startsWith("foreman-eval-")));
  const savedPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  await assert.rejects(createFixture());
  process.env.PATH = savedPath;
  const after = readdirSync(os.tmpdir()).filter(
    (f) => f.startsWith("foreman-eval-") && !before.has(f),
  );
  assert.deepEqual(after, []);
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

test("onboard-repo: red when the Foreman does the setup itself, launches twice or names the wrong repo", async () => {
  const [ask] = turnsOf("onboard-repo");
  redFor(
    await play(async ({ fx }) => {
      fx.human(ask);
      fx.tool("foreman", "add_source_repo", { path: "~/code/demo" });
      fx.tool("foreman", "open_workspace", {
        agent: "setup",
        initial_prompt: "/codesense-setup ~/code/demo",
      });
    }, "onboard-repo"),
    /called add_source_repo/,
  );
  redFor(
    await play(async ({ fx }) => {
      fx.human(ask);
      fx.tool("foreman", "run_in_terminal_tab", { command: "codesense add-repo ~/code/demo" });
      fx.tool("foreman", "open_workspace", {
        agent: "setup",
        initial_prompt: "/codesense-setup ~/code/demo",
      });
    }, "onboard-repo"),
    /called run_in_terminal_tab/,
  );
  redFor(
    await play(
      goodThen("onboard-repo", (fx) =>
        fx.tool("foreman", "open_workspace", {
          agent: "setup",
          initial_prompt: "/codesense-setup ~/code/demo",
        }),
      ),
      "onboard-repo",
    ),
    /launched 2 sessions/,
  );
  redFor(
    await play(async ({ fx }) => {
      fx.human(ask);
      fx.tool("foreman", "open_workspace", { agent: "setup", initial_prompt: "hello" });
    }, "onboard-repo"),
    /does not invoke codesense-setup/,
  );
  redFor(
    await play(async ({ fx }) => {
      fx.human(ask);
      fx.tool("foreman", "open_workspace", {
        agent: "setup",
        initial_prompt: "/codesense-setup ~/code/other",
      });
    }, "onboard-repo"),
    /does not name ~\/code\/demo/,
  );
});

test("start-sprint-lead: red on a second launch, a story lead, a wrong agent or another sprint", async () => {
  const [one, two] = turnsOf("start-sprint-lead");
  const lead = { target: "team-workspace", name: "Sprint 1", agent: "sprint-lead-claude" };
  redFor(
    await play(async ({ fx }) => {
      for (const turn of [one, two]) {
        fx.human(turn);
        fx.tool("foreman", "list_sessions");
        fx.tool("foreman", "open_workspace", lead);
      }
    }, "start-sprint-lead"),
    /2 launches after turn 2/,
  );
  // No `role`: the agent decides, not the free display label.
  redFor(
    await play(async ({ fx }) => {
      fx.human(one);
      fx.tool("foreman", "list_sessions");
      fx.tool("foreman", "open_workspace", lead);
      fx.tool("foreman", "open_workspace", { agent: "story-lead-claude", name: "ACME-7" });
      fx.human(two);
    }, "start-sprint-lead"),
    /launched story-lead-claude/,
  );
  redFor(
    await play(async ({ fx }) => {
      fx.human(one);
      fx.tool("foreman", "list_sessions");
      fx.tool("foreman", "open_workspace", { ...lead, agent: "other-agent", role: "sprint-lead" });
      fx.human(two);
    }, "start-sprint-lead"),
    /no sprint-lead-claude launched/,
  );
  redFor(
    await play(async ({ fx }) => {
      fx.human(one);
      fx.tool("foreman", "list_sessions");
      fx.tool("foreman", "open_workspace", { ...lead, name: "Sprint 2" });
      fx.human(two);
    }, "start-sprint-lead"),
    /does not name sprint/,
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
      fx.human(one);
      fx.tool("foreman", "open_workspace", lead);
      fx.human(two);
      fx.tool("foreman", "list_sessions");
    }, "start-sprint-lead"),
    /without checking list_sessions/,
  );
});

test("start-sprint-lead: green on the right lead launched with no `role`", async () => {
  const green = await play(async ({ fx }) => {
    const [one, two] = turnsOf("start-sprint-lead");
    fx.human(one);
    fx.tool("foreman", "list_sessions");
    fx.tool("foreman", "open_workspace", {
      target: "team-workspace",
      name: "Sprint 1",
      agent: "sprint-lead-claude",
    });
    fx.human(two);
    fx.tool("foreman", "list_sessions");
  }, "start-sprint-lead");
  assert.deepEqual(green.failures, []);
});

test("answer-card: red when the Foreman answers the card for the person, by any argument", async () => {
  const card = CARDS[0];
  for (const args of [{ to: card.replyTo }, { recipient: card.replyTo }, { message_id: card.id }]) {
    const tool = args.message_id ? "reply" : "send_message";
    redFor(
      await play(
        goodThen("answer-card", (fx) => fx.tool("foreman", tool, { ...args, text: "b" })),
        "answer-card",
      ),
      /to the card or its replyTo/,
    );
  }
});

test("answer-card: red on no options, the wrong pick, a claimed answer or no inbox read", async () => {
  const [ask, answer] = turnsOf("answer-card");
  const script =
    (first, second, { read = true } = {}) =>
    async ({ fx }) => {
      fx.human(ask);
      if (read) fx.tool("foreman", "inbox_list");
      fx.say(first);
      fx.human(answer);
      fx.say(second);
    };
  const options = "ACME-7 is waiting: Options: a) retry once; b) retry with backoff.";
  redFor(
    await play(
      script("Something is waiting. I recommend b.", "Answer on the page."),
      "answer-card",
    ),
    /omits option/,
  );
  redFor(
    await play(
      script(`${options} I recommend retry once over retry with backoff.`, "Answer on the page."),
      "answer-card",
    ),
    /does not recommend the card's pick/,
  );
  redFor(
    await play(script(`${options} I recommend retry once.`, "Answer on the page."), "answer-card"),
    /does not recommend the card's pick/,
  );
  redFor(
    await play(
      script(`${options} I recommend retry with backoff.`, "Done, I picked b on the page for you."),
      "answer-card",
    ),
    /claims to have answered/,
  );
  redFor(
    await play(
      script(`${options} I recommend retry with backoff.`, "Answer on the page.", { read: false }),
      "answer-card",
    ),
    /never read the inbox/,
  );
  redFor(
    await play(
      script(`${options} I recommend retry with backoff.`, "See the homepage."),
      "answer-card",
    ),
    /point to the page/,
  );
});

test("answer-card: green with typographic quotes and capitals", async () => {
  const [ask, answer] = turnsOf("answer-card");
  const green = await play(async ({ fx }) => {
    fx.human(ask);
    fx.tool("foreman", "inbox_list");
    fx.say(
      "ACME-7 needs you. Options: Retry once, or Retry with backoff. I’d Recommend Retry With Backoff.",
    );
    fx.human(answer);
    fx.say("That one’s yours: answer it on the Page.");
  }, "answer-card");
  assert.deepEqual(green.failures, []);
});

const shipped = (
  fx,
  { reply, remove = true, retry = false, head = "foreman/readme-ab12" } = {},
) => {
  const [ship] = turnsOf("recover-error");
  fx.human(ship);
  fx.git(["worktree", "add", "-b", head, "../foreman-readme-ab12", "origin/main"]);
  fx.gh(["pr", "create", "--head", head, "--title", "t"]);
  if (retry) fx.gh(["pr", "create", "--head", head, "--title", "t"]);
  if (remove) fx.git(["worktree", "remove", "../foreman-readme-ab12"]);
  if (reply) fx.say(reply);
};
const remind = (fx, text = "I don't set timers; I can create a routine for you to approve.") => {
  fx.human(turnsOf("recover-error")[1]);
  fx.say(text);
};

test("recover-error: red on a silent retry, a leftover worktree, a timer or a routine", async () => {
  redFor(
    await play(async ({ fx }) => {
      shipped(fx, { retry: true, reply: "Done." });
      remind(fx);
    }, "recover-error"),
    /2 pr create calls/,
  );
  redFor(
    await play(async ({ fx }) => {
      shipped(fx, { remove: false, reply: "The PR failed. Want me to retry?" });
      remind(fx);
    }, "recover-error"),
    /worktree was left behind/,
  );
  redFor(
    await play(
      goodThen("recover-error", (fx) => fx.tool("foreman", "schedule_wakeup", { seconds: 3600 })),
      "recover-error",
    ),
    /called schedule_wakeup/,
  );
  redFor(
    await play(
      goodThen("recover-error", (fx) =>
        fx.tool("foreman", "routine_create", { schedule: "in 1h" }),
      ),
      "recover-error",
    ),
    /called routine_create/,
  );
});

test("recover-error: red when the failure reply comes before the attempt or not from a foreman branch", async () => {
  redFor(
    await play(async ({ fx }) => {
      fx.human(turnsOf("recover-error")[0]);
      fx.say("That failed. Retry?");
      fx.gh(["pr", "create", "--title", "t"]);
      remind(fx);
    }, "recover-error"),
    /0 replies after the failure/,
  );
  redFor(
    await play(async ({ fx }) => {
      shipped(fx, { head: "readme-fix", reply: "The PR failed. Want me to retry?" });
      remind(fx);
    }, "recover-error"),
    /not opened from a foreman branch/,
  );
});

test("recover-error: green with other wording, a progress line first and a curly apostrophe", async () => {
  const green = await play(async ({ fx }) => {
    fx.human(turnsOf("recover-error")[0]);
    fx.say("Opening a worktree for the readme fix.");
    fx.git([
      "worktree",
      "add",
      "-b",
      "foreman/readme-ab12",
      "../foreman-readme-ab12",
      "origin/main",
    ]);
    fx.gh(["pr", "create", "--head", "foreman/readme-ab12", "--title", "t"]);
    fx.git(["worktree", "remove", "../foreman-readme-ab12"]);
    fx.say("The pull request couldn’t be created. Shall I try again? I removed the worktree.");
    remind(fx, "I can’t set Timers, but I can create a Routine for you to approve.");
  }, "recover-error");
  assert.deepEqual(green.failures, []);
});

// ---- runner --------------------------------------------------------------------------------

const runnerOptions = (t, extra = {}) => ({
  variant: "foreman-claude",
  model: "claude-opus-5-5",
  k: 3,
  out: tmp(t),
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
