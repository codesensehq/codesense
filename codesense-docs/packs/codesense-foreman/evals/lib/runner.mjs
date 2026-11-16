// SPDX-License-Identifier: MIT
// Runs each case k times in fresh fixtures, grades it and writes the report. Drivers are
// pluggable: the stubs run in CI at $0; `claude` (claude-driver.mjs) records the model runs.
//
// Driver contract: `driver({ caseDef, fx, budgetLeft })` plays `caseDef.input.turns` through `fx.human`, logs
// every Foreman tool call through `fx.tool("foreman", name, args)` with the real MCP argument
// names (a CodeSense tool by its bare name, any other MCP tool by its full `mcp__<server>__<tool>`
// name, as GITHUB_PR), runs the agent's shell through the fixture so graders see it (`fx.git(argv, cwd)` for
// git, logged as a `git` record without the leading "git"; `fx.run(file, argv, cwd)` for a
// team script; `fx.gh(argv, cwd)` for gh; `fx.write(file, text)` for a file write, logged as
// `write_file`), and returns `{ cost_usd, tokens, session? }`. It throws InfraError
// (with what it spent as `cost_usd`) when the sandbox or the API fails: the runner retries that
// run once in a fresh fixture, and a second one stops the report. Any other throw is a fail.
//
// An optional `judge({ caseDef, turns, replies, budgetLeft })` returns `{ verdicts, why, cost_usd }`
// for the case's rubric, and throws with what it spent as `cost_usd`. Its verdicts go in the
// report's `rubric`, beside the script grade, never in it.
import console from "node:console";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { claudeDriver, killGroups } from "./claude-driver.mjs";
import { InfraError } from "./errors.mjs";
import { TMP_PREFIX, fixtureFor } from "./fixture.mjs";
import { CASE_IDS, packDir, runtimeOf } from "./floor.mjs";
import { grade, loadCases, loadExtraCases } from "./graders.mjs";
import { claudeJudge } from "./judge.mjs";
import { stubs } from "./stubs.mjs";

export const BUDGET_USD = 12;

export { InfraError };
// The floor's four cases, or the behaviour cases outside it.
const SUITES = ["floor", "extra"];

export async function runEval({ variant, model, k = 3, driver, driverName, judge, out, budget = BUDGET_USD, date = new Date(), suite = "floor" }) {
  // The name decides whether the report can ever count (floor.mjs), so there is no default.
  if (typeof driverName !== "string" || !driverName) throw new Error("runEval needs a driverName");
  const specHash = parse(readFileSync(path.join(packDir, "pack.yml"), "utf8")).spec_hash?.[variant] ?? null;
  if (!SUITES.includes(suite)) throw new Error(`unknown suite ${suite}`);
  const cases = suite === "floor" ? loadCases() : loadExtraCases();
  const ids = cases.map((c) => c.id).sort();
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error(`the ${suite} suite needs cases with unique ids, got ${ids.join(", ") || "none"}`);
  if (suite === "floor" && JSON.stringify(ids) !== JSON.stringify([...CASE_IDS].sort()))
    throw new Error(`case files ${ids.join(", ")} do not match the floor's ${CASE_IDS.join(", ")}`);
  const results = Object.fromEntries(cases.map((c) => [c.id, []]));
  const rubric = Object.fromEntries(cases.filter((c) => c.rubric?.length).map((c) => [c.id, []]));
  const notes = [];
  const rubricNotes = [];
  const runs = [];
  let cost = 0;
  let tokens = 0;
  let reason = "";
  let complete = true;

  // One attempt in a fresh fixture: the script verdict and the judge's, or a thrown InfraError.
  const attempt = async (caseDef, run) => {
    let fx;
    try {
      try {
        fx = await fixtureFor(caseDef);
      } catch (error) {
        throw new InfraError(`fixture: ${error.message}`);
      }
      const spent = (await driver({ caseDef, fx, budgetLeft: budget - cost })) ?? {};
      const runCost = Number(spent.cost_usd ?? 0);
      if (!Number.isFinite(runCost) || runCost < 0) throw new InfraError(`driver reported cost ${spent.cost_usd}`);
      cost += runCost;
      tokens += Number(spent.tokens ?? 0) || 0;
      const state = fx.state();
      const verdict = grade(caseDef, state);
      results[caseDef.id].push(verdict.pass ? "pass" : "fail");
      runs.push({ case: caseDef.id, run, result: verdict.pass ? "pass" : "fail", session: spent.session ?? null });
      if (!verdict.pass) notes.push(`${caseDef.id} run ${run}: ${verdict.failures.join("; ")}`);
      if (judge && rubric[caseDef.id]) {
        const errored = (why) => {
          rubric[caseDef.id].push(Object.fromEntries(caseDef.rubric.map((r) => [r.id, "error"])));
          rubricNotes.push(`${caseDef.id} run ${run}: ${why}`);
        };
        if (!(budget - cost > 0)) errored("the judge was skipped: no budget left");
        else
          try {
            const judged = await judge({ caseDef, turns: state.turns, replies: state.replies, budgetLeft: budget - cost });
            cost += Number(judged.cost_usd) || 0;
            rubric[caseDef.id].push(judged.verdicts);
            for (const [id, v] of Object.entries(judged.verdicts))
              if (v !== "pass") rubricNotes.push(`${caseDef.id} run ${run} ${id}: ${judged.why?.[id] ?? v}`);
          } catch (error) {
            cost += Number(error.cost_usd) || 0;
            errored(`the judge failed: ${error.message}`);
          }
      }
    } finally {
      fx?.teardown();
    }
  };

  outer: for (let run = 1; run <= k; run += 1) {
    for (const caseDef of cases) {
      if (cost >= budget) {
        complete = false;
        reason = `budget: stopped at $${cost.toFixed(2)} of $${budget}`;
        break outer;
      }
      // An infra error gets one retry; a second stops the report, so nothing more is spent.
      for (let tries = 1; ; tries += 1) {
        try {
          await attempt(caseDef, run);
          break;
        } catch (error) {
          if (!(error instanceof InfraError)) {
            results[caseDef.id].push("fail");
            notes.push(`${caseDef.id} run ${run}: threw ${error.message}`);
            break;
          }
          cost += Number(error.cost_usd) || 0;
          if (tries < 2 && cost < budget) continue;
          results[caseDef.id].push("error");
          runs.push({ case: caseDef.id, run, result: "error", session: null });
          complete = false;
          reason = `infra error in ${caseDef.id} run ${run}${tries > 1 ? " (after a retry)" : ""}: ${error.message}`;
          break outer;
        }
      }
    }
  }
  if (complete && cost > budget) {
    complete = false;
    reason = `budget: spent $${cost.toFixed(2)} of $${budget}`;
  }

  const report = {
    variant,
    runtime: runtimeOf(variant),
    model,
    spec_hash: specHash,
    // Only the floor suite can set a row; the outside-floor cases are run and reported.
    suite,
    driver: driverName,
    k,
    budget_usd: budget,
    complete,
    reason,
    at: date.toISOString(),
    cost_usd: cost,
    tokens,
    cases: results,
    ...(judge ? { rubric } : {}),
  };
  mkdirSync(out, { recursive: true });
  const stem = path.join(out, `${variant}-${report.at.slice(0, 10)}`);
  let reportPath = `${stem}.md`;
  for (let n = 2; existsSync(reportPath); n += 1) reportPath = `${stem}-${n}.md`;
  const section = (title, lines) => (lines.length ? `\n## ${title}\n\n${lines.map((n) => `- ${n}`).join("\n")}\n` : "");
  const body = section("Failures", notes) + section("Rubric", rubricNotes);
  writeFileSync(reportPath, `---\n${stringify(report)}---\n\n# ${variant} eval, ${report.at}\n${body}`);
  const allPass = ids.every((id) => results[id]?.length && results[id].every((r) => r === "pass"));
  return { exitCode: complete && allPass ? 0 : 1, report, reportPath, runs };
}

const DRIVERS = { "stub:good": stubs.good, "stub:do-nothing": stubs.doNothing, claude: "model" };
const FLAGS = ["driver", "k", "model", "budget", "out", "suite"];
const USAGE = "usage: run.sh <variant> --driver <claude|stub:good|stub:do-nothing> [--suite floor|extra] [--k N] [--model M] [--budget USD, at most 12] [--out DIR]";

const refuse = (message) => (console.error(message), 2);

async function main(argv) {
  const [variant, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i].replace(/^--/, "");
    if (!rest[i].startsWith("--") || !FLAGS.includes(name) || rest[i + 1] === undefined) return refuse(USAGE);
    flags[name] = rest[i + 1];
  }
  const registry = parse(readFileSync(path.join(packDir, "variants.yml"), "utf8"));
  if (!variant || variant.startsWith("--")) return refuse(USAGE);
  if (variant !== registry.agent) return refuse(`unknown variant ${variant}; this pack has ${registry.agent}`);
  if (!DRIVERS[flags.driver]) return refuse(`no driver: pass --driver ${Object.keys(DRIVERS).join(" or ")}`);
  const real = flags.driver === "claude";
  const model = flags.model ?? registry.models?.find((m) => m.default)?.model;
  if (!registry.models?.some((m) => m.model === model)) return refuse(`unknown model ${model}`);
  const k = Number(flags.k ?? 3);
  const budget = Number(flags.budget ?? BUDGET_USD);
  if (!Number.isInteger(k) || k < 1) return refuse("--k must be a whole number of at least 1");
  if (!(budget > 0 && budget <= BUDGET_USD)) return refuse(`--budget must be more than 0 and at most ${BUDGET_USD}`);
  // A stub's report is never evidence, so by default it goes to a temp dir, not evals/reports.
  const out = flags.out ?? (real ? path.join(packDir, "evals", "reports") : mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}-stub-`)));
  // FOREMAN_EVAL_CLAUDE names another CLI binary (the tests use a fake one).
  const bin = process.env.FOREMAN_EVAL_CLAUDE || "claude";
  // Transcripts stay on this machine, never in the repo: in FOREMAN_EVAL_LOGS when set.
  const logDir = real ? process.env.FOREMAN_EVAL_LOGS || mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}-logs-`)) : undefined;
  // Each CLI runs in its own process group, outside the terminal's: end them with the runner.
  if (real) {
    process.on("exit", killGroups);
    for (const [signal, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ])
      process.once(signal, () => process.exit(code));
  }
  const driver = real ? claudeDriver({ model, bin, logDir }) : DRIVERS[flags.driver];
  const judge = real ? claudeJudge({ bin }) : undefined;
  const suite = flags.suite ?? "floor";
  if (!SUITES.includes(suite)) return refuse(`--suite must be one of ${SUITES.join(", ")}`);
  const { exitCode, reportPath, report, runs } = await runEval({ variant, model, driver, driverName: flags.driver, judge, k, budget, out, suite });
  console.log(`${reportPath}: ${report.complete ? "complete" : `incomplete (${report.reason})`}`);
  if (real) {
    console.log(`spent $${report.cost_usd.toFixed(2)}, ${report.tokens} tokens; transcripts in ${logDir}`);
    for (const r of runs) console.log(`  ${r.case} run ${r.run}: ${r.result}${r.session ? ` (session ${r.session})` : ""}`);
  }
  return exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
