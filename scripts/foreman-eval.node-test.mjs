// SPDX-License-Identifier: MIT
// Model-free checks on the Foreman eval: the fixture, the four graders (red on a do-nothing
// stub, green on a scripted good agent), the runner, the floor rule and the registry check.
import { test } from "node:test";
import assert from "node:assert/strict";
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
import { parse, stringify } from "yaml";

const evals = new URL("../codesense-docs/packs/codesense-foreman/evals/", import.meta.url);
const lib = (name) => import(new URL(`lib/${name}.mjs`, evals));
const { createFixture } = await lib("fixture");
const { loadCases, grade } = await lib("graders");
const { stubs } = await lib("stubs");
const { runEval, InfraError } = await lib("runner");
const { statusFor, parseReport } = await lib("floor");
const { checkRegistry } = await lib("registry");

const CASES = ["onboard-repo", "start-sprint-lead", "answer-card", "recover-error"];
const cases = loadCases();
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "foreman-eval-test-"));

async function play(driver, id, fixtureOptions = {}) {
  const caseDef = cases.find((c) => c.id === id);
  const fx = await createFixture({ failFirstPr: id === "recover-error", ...fixtureOptions });
  try {
    await driver({ caseDef, fx });
    return grade(caseDef, fx.state());
  } finally {
    fx.teardown();
  }
}

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
    assert.equal(calls.length, 2);
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

test("fixture: the shim never reaches a real gh", async () => {
  const fx = await createFixture();
  try {
    const shim = readFileSync(path.join(fx.root, "bin", "gh"), "utf8");
    assert.doesNotMatch(shim, /\/usr\/(local\/)?bin\/gh/);
    assert.equal(fx.state().env.PATH.split(path.delimiter)[0], path.join(fx.root, "bin"));
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

test("onboard-repo: red when the Foreman does the setup itself or launches twice", async () => {
  const selfSetup = await play(async ({ fx }) => {
    fx.human("set me up with ~/code/demo");
    fx.tool("foreman", "add_source_repo", { path: "~/code/demo" });
    fx.tool("foreman", "open_workspace", { agent: "setup", initial_prompt: "/codesense-setup" });
  }, "onboard-repo");
  assert.equal(selfSetup.pass, false);
  const wrongPrompt = await play(async ({ fx }) => {
    fx.human("set me up with ~/code/demo");
    fx.tool("foreman", "open_workspace", { agent: "setup", initial_prompt: "hello" });
  }, "onboard-repo");
  assert.equal(wrongPrompt.pass, false);
});

test("start-sprint-lead: red on a second launch, a story lead or a wrong agent", async () => {
  const twice = await play(async ({ fx }) => {
    for (const turn of ["start sprint 1", "start sprint 1"]) {
      fx.human(turn);
      fx.tool("foreman", "open_workspace", { agent: "sprint-lead-claude", role: "sprint-lead" });
    }
  }, "start-sprint-lead");
  assert.equal(twice.pass, false);
  const storyLead = await play(async ({ fx }) => {
    fx.human("start sprint 1");
    fx.tool("foreman", "open_workspace", { agent: "sprint-lead-claude", role: "sprint-lead" });
    fx.tool("foreman", "open_workspace", { agent: "story-lead-claude", role: "story-lead" });
    fx.human("start sprint 1");
  }, "start-sprint-lead");
  assert.equal(storyLead.pass, false);
  const wrongAgent = await play(async ({ fx }) => {
    fx.human("start sprint 1");
    fx.tool("foreman", "open_workspace", { agent: "other-agent", role: "sprint-lead" });
    fx.human("start sprint 1");
  }, "start-sprint-lead");
  assert.equal(wrongAgent.pass, false);
});

test("answer-card: red when the Foreman answers the card for the person", async () => {
  const answered = await play(async ({ fx }) => {
    await stubs.good({ caseDef: cases.find((c) => c.id === "answer-card"), fx });
    fx.tool("foreman", "send_message", { to: fx.state().cards[0].replyTo, text: "b" });
  }, "answer-card");
  assert.equal(answered.pass, false);
  const noOptions = await play(async ({ fx }) => {
    fx.human("what's waiting on me?");
    fx.say("Something is waiting.");
    fx.human("answer it: option b");
    fx.say("Answer on the page.");
  }, "answer-card");
  assert.equal(noOptions.pass, false);
});

test("recover-error: red on a silent retry, a leftover worktree or a timer", async () => {
  const retried = await play(async ({ fx }) => {
    fx.human("ship the readme fix as a pull request");
    fx.git(["worktree", "add", "-b", "foreman/readme", path.join(fx.root, "foreman-readme-ab12")]);
    fx.gh(["pr", "create"]);
    fx.gh(["pr", "create"]);
    fx.git(["worktree", "remove", path.join(fx.root, "foreman-readme-ab12")]);
    fx.say("Done.");
  }, "recover-error");
  assert.equal(retried.pass, false);
  const leftover = await play(async ({ fx }) => {
    fx.human("ship the readme fix as a pull request");
    fx.git(["worktree", "add", "-b", "foreman/readme", path.join(fx.root, "foreman-readme-ab12")]);
    fx.gh(["pr", "create"]);
    fx.say("The PR failed. Want me to retry?");
    fx.human("remind me in an hour");
    fx.say("I don't set timers; I can create a routine for you to approve in its dashboard.");
  }, "recover-error");
  assert.equal(leftover.pass, false);
  const timer = await play(async ({ fx }) => {
    await stubs.good({ caseDef: cases.find((c) => c.id === "recover-error"), fx });
    fx.tool("foreman", "schedule_wakeup", { seconds: 3600 });
  }, "recover-error");
  assert.equal(timer.pass, false);
});

// ---- runner --------------------------------------------------------------------------------

function runnerOptions(extra = {}) {
  return { variant: "foreman-claude", model: "claude-opus-5-5", k: 3, out: tmp(), ...extra };
}

test("runner: the good stub writes a complete passing report with the front block", async () => {
  const opts = runnerOptions({ driver: stubs.good });
  const { exitCode, reportPath, report } = await runEval(opts);
  assert.equal(exitCode, 0);
  assert.equal(report.complete, true);
  assert.equal(report.k, 3);
  assert.equal(report.runtime, "claude");
  assert.equal(report.spec_hash, null);
  for (const id of CASES) assert.deepEqual(report.cases[id], ["pass", "pass", "pass"]);
  assert.match(path.basename(reportPath), /^foreman-claude-.*\.md$/);
  assert.deepEqual(parseReport(readFileSync(reportPath, "utf8")).cases, report.cases);
  rmSync(opts.out, { recursive: true });
});

test("runner: the do-nothing stub exits non-zero with every case failed", async () => {
  const opts = runnerOptions({ driver: stubs.doNothing, k: 1 });
  const { exitCode, report } = await runEval(opts);
  assert.notEqual(exitCode, 0);
  for (const id of CASES) assert.deepEqual(report.cases[id], ["fail"]);
  rmSync(opts.out, { recursive: true });
});

test("runner: an infra error is `error`, not `fail`, and the report is incomplete", async () => {
  const driver = async ({ caseDef, fx }) => {
    if (caseDef.id === "answer-card") throw new InfraError("sandbox would not start");
    return stubs.good({ caseDef, fx });
  };
  const opts = runnerOptions({ driver, k: 1 });
  const { exitCode, report } = await runEval(opts);
  assert.notEqual(exitCode, 0);
  assert.deepEqual(report.cases["answer-card"], ["error"]);
  assert.equal(report.complete, false);
  assert.match(report.reason, /sandbox would not start/);
  rmSync(opts.out, { recursive: true });
});

test("runner: stops once spend passes the budget and marks the report incomplete", async () => {
  const driver = async (args) => {
    await stubs.good(args);
    return { cost_usd: 5 };
  };
  const opts = runnerOptions({ driver, budget: 12 });
  const { report } = await runEval(opts);
  assert.equal(report.complete, false);
  assert.match(report.reason, /budget/);
  assert.ok(report.cost_usd >= 12 && report.cost_usd < 20);
  const ran = Object.values(report.cases).flat().length;
  assert.ok(ran < 12, `stopped early (ran ${ran} of 12)`);
  rmSync(opts.out, { recursive: true });
});

test("runner: a dry run is free", async () => {
  const opts = runnerOptions({ driver: stubs.good, k: 1 });
  const { report } = await runEval(opts);
  assert.equal(report.cost_usd, 0);
  rmSync(opts.out, { recursive: true });
});

test("run.sh: with no driver it refuses rather than pretend to run a model", () => {
  const script = new URL("run.sh", evals).pathname;
  const out = tmp();
  const none = spawnSync("sh", [script, "foreman-claude", "--out", out], { encoding: "utf8" });
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /driver/);
  const stub = spawnSync(
    "sh",
    [script, "foreman-claude", "--driver", "stub:good", "--k", "1", "--out", out],
    {
      encoding: "utf8",
    },
  );
  assert.equal(stub.status, 0, stub.stderr);
  assert.equal(readdirSync(out).length, 1);
  const red = spawnSync(
    "sh",
    [script, "foreman-claude", "--driver", "stub:do-nothing", "--k", "1", "--out", out],
    {
      encoding: "utf8",
    },
  );
  assert.notEqual(red.status, 0);
  rmSync(out, { recursive: true });
});

// ---- floor rule ----------------------------------------------------------------------------

const KEY = { runtime: "claude", model: "claude-opus-5-5", spec_hash: "abc" };
function report(over = {}) {
  const base = {
    ...KEY,
    variant: "foreman-claude",
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
  assert.equal(
    statusFor(
      [
        report(),
        withCase("answer-card", ["fail", "fail", "fail"], {
          complete: false,
          at: "2026-11-14T10:00:00Z",
        }),
      ],
      KEY,
    ),
    "passed",
  );
  assert.equal(statusFor([report({ complete: false })], KEY), "untested");
});
test("floor: k=1 is a screen and never sets status", () => {
  const cases = Object.fromEntries(CASES.map((id) => [id, ["pass"]]));
  assert.equal(statusFor([report({ k: 1, cases })], KEY), "untested");
});
test("floor: an older spec's pass does not carry to the current key", () => {
  assert.equal(statusFor([report({ spec_hash: "old" })], KEY), "untested");
});
test("floor: a newer fail after an older pass is failed, and the reverse is passed", () => {
  const fail = withCase("onboard-repo", ["fail", "pass", "pass"], { at: "2026-11-14T10:00:00Z" });
  assert.equal(statusFor([report(), fail], KEY), "failed");
  assert.equal(statusFor([fail, report({ at: "2026-11-15T10:00:00Z" })], KEY), "passed");
});
test("floor: a missing case is not a pass", () => {
  const partial = report();
  delete partial.cases["recover-error"];
  assert.equal(statusFor([partial], KEY), "untested");
});
test("floor: a model is its own key", () => {
  assert.equal(statusFor([report()], { ...KEY, model: "claude-sonnet-5-5" }), "untested");
});

// ---- registry check ------------------------------------------------------------------------

function setup({ rows, reports = [], built = "abc" }) {
  const dir = tmp();
  const reportDir = path.join(dir, "reports");
  const pack = path.join(dir, "pack.yml");
  const variants = path.join(dir, "variants.yml");
  writeFileSync(pack, stringify({ spec_hash: { "foreman-claude": built } }));
  writeFileSync(variants, stringify({ agent: "foreman-claude", variants: rows }));

  mkdirSync(reportDir);
  reports.forEach((r, i) =>
    writeFileSync(path.join(reportDir, `r${i}.md`), `---\n${stringify(r)}---\n`),
  );
  return { variants, pack, reports: reportDir, dir };
}
const row = (over = {}) => ({ ...KEY, eval: "untested", report: null, at: null, ...over });

test("registry: untested rows with no reports pass", () => {
  const p = setup({ rows: [row()] });
  assert.deepEqual(checkRegistry(p), []);
  rmSync(p.dir, { recursive: true });
});
test("registry: a planted passed with no report fails", () => {
  const p = setup({ rows: [row({ eval: "passed", report: "r0.md" })] });
  assert.match(checkRegistry(p).join("\n"), /passed.*untested|untested.*passed/);
  rmSync(p.dir, { recursive: true });
});
test("registry: a row naming an older pass when a newer complete fail exists fails", () => {
  const fail = withCase("answer-card", ["fail", "fail", "fail"], { at: "2026-11-14T10:00:00Z" });
  const p = setup({ rows: [row({ eval: "passed", report: "r0.md" })], reports: [report(), fail] });
  assert.match(checkRegistry(p).join("\n"), /failed/);
  rmSync(p.dir, { recursive: true });
});
test("registry: a matching passed row passes", () => {
  const p = setup({ rows: [row({ eval: "passed", report: "r0.md" })], reports: [report()] });
  assert.deepEqual(checkRegistry(p), []);
  rmSync(p.dir, { recursive: true });
});
test("registry: a changed spec with a stale passed row fails", () => {
  const p = setup({
    rows: [row({ eval: "passed", report: "r0.md" })],
    reports: [report()],
    built: "def",
  });
  assert.match(checkRegistry(p).join("\n"), /spec_hash/);
  rmSync(p.dir, { recursive: true });
});
test("registry: a row for another model with no reports cannot be passed", () => {
  const p = setup({
    rows: [row({ model: "claude-sonnet-5-5", eval: "passed", report: "r0.md" })],
    reports: [report()],
  });
  assert.match(checkRegistry(p).join("\n"), /claude-sonnet-5-5/);
  rmSync(p.dir, { recursive: true });
});

test("registry: the real pack passes its own check and the CLI exits 0", () => {
  assert.deepEqual(checkRegistry(), []);
  const script = new URL("check-registry.mjs", evals).pathname;
  assert.equal(spawnSync("node", [script], { encoding: "utf8" }).status, 0);
});
test("registry: the CLI exits non-zero on a bad registry", () => {
  const p = setup({ rows: [row({ eval: "passed", report: "r0.md" })] });
  const script = new URL("check-registry.mjs", evals).pathname;
  const r = spawnSync(
    "node",
    [script, "--variants", p.variants, "--pack", p.pack, "--reports", p.reports],
    { encoding: "utf8" },
  );
  assert.notEqual(r.status, 0);
  rmSync(p.dir, { recursive: true });
});
