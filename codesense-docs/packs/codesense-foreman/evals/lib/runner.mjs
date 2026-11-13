// SPDX-License-Identifier: MIT
// Runs each case k times in fresh fixtures, grades it and writes the report. Drivers are
// pluggable: the stubs run in CI at $0; the real model driver belongs to the recorded-runs task.
//
// Driver contract: `driver({ caseDef, fx })` plays `caseDef.input.turns` through `fx.human`, logs
// every Foreman tool call through `fx.tool("foreman", name, args)` with the real MCP argument
// names, runs the agent's shell through the fixture so graders see it (`fx.git(argv, cwd)` for
// git, logged as a `git` record without the leading "git"; `fx.run(file, argv, cwd)` for a
// team script; `fx.gh(argv, cwd)` for gh; `fx.write(file, text)` for a file write, logged as
// `write_file`), and returns `{ cost_usd, tokens }`. It throws InfraError
// when the sandbox or the API fails; any other throw grades the run as a fail.
import console from "node:console";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { fixtureFor } from "./fixture.mjs";
import { CASE_IDS, packDir, runtimeOf } from "./floor.mjs";
import { grade, loadCases, loadExtraCases } from "./graders.mjs";
import { stubs } from "./stubs.mjs";

export const BUDGET_USD = 12;

export class InfraError extends Error {}

export async function runEval({ variant, model, k = 3, driver, driverName, out, budget = BUDGET_USD, date = new Date(), suite = "floor" }) {
  // The name decides whether the report can ever count (floor.mjs), so there is no default.
  if (typeof driverName !== "string" || !driverName) throw new Error("runEval needs a driverName");
  const specHash = parse(readFileSync(path.join(packDir, "pack.yml"), "utf8")).spec_hash?.[variant] ?? null;
  if (!["floor", "extra"].includes(suite)) throw new Error(`unknown suite ${suite}`);
  const cases = suite === "floor" ? loadCases() : loadExtraCases();
  const ids = cases.map((c) => c.id).sort();
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error(`the ${suite} suite needs cases with unique ids, got ${ids.join(", ") || "none"}`);
  if (suite === "floor" && JSON.stringify(ids) !== JSON.stringify([...CASE_IDS].sort()))
    throw new Error(`case files ${ids.join(", ")} do not match the floor's ${CASE_IDS.join(", ")}`);
  const results = Object.fromEntries(cases.map((c) => [c.id, []]));
  const notes = [];
  let cost = 0;
  let tokens = 0;
  let reason = "";
  let complete = true;

  outer: for (let run = 1; run <= k; run += 1) {
    for (const caseDef of cases) {
      if (cost >= budget) {
        complete = false;
        reason = `budget: stopped at $${cost.toFixed(2)} of $${budget}`;
        break outer;
      }
      let fx;
      try {
        try {
          fx = await fixtureFor(caseDef);
        } catch (error) {
          throw new InfraError(`fixture: ${error.message}`);
        }
        const spent = (await driver({ caseDef, fx })) ?? {};
        const runCost = Number(spent.cost_usd ?? 0);
        if (!Number.isFinite(runCost) || runCost < 0) throw new InfraError(`driver reported cost ${spent.cost_usd}`);
        cost += runCost;
        tokens += Number(spent.tokens ?? 0) || 0;
        const verdict = grade(caseDef, fx.state());
        results[caseDef.id].push(verdict.pass ? "pass" : "fail");
        if (!verdict.pass) notes.push(`${caseDef.id} run ${run}: ${verdict.failures.join("; ")}`);
      } catch (error) {
        if (error instanceof InfraError) {
          results[caseDef.id].push("error");
          complete = false;
          reason ||= `infra error in ${caseDef.id} run ${run}: ${error.message}`;
        } else {
          results[caseDef.id].push("fail");
          notes.push(`${caseDef.id} run ${run}: threw ${error.message}`);
        }
      } finally {
        fx?.teardown();
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
  };
  mkdirSync(out, { recursive: true });
  const stem = path.join(out, `${variant}-${report.at.slice(0, 10)}`);
  let reportPath = `${stem}.md`;
  for (let n = 2; existsSync(reportPath); n += 1) reportPath = `${stem}-${n}.md`;
  const body = notes.length ? `\n## Failures\n\n${notes.map((n) => `- ${n}`).join("\n")}\n` : "";
  writeFileSync(reportPath, `---\n${stringify(report)}---\n\n# ${variant} eval, ${report.at}\n${body}`);
  const allPass = (suite === "floor" ? CASE_IDS : ids).every((id) => results[id]?.length && results[id].every((r) => r === "pass"));
  return { exitCode: complete && allPass ? 0 : 1, report, reportPath };
}

const DRIVERS = { "stub:good": stubs.good, "stub:do-nothing": stubs.doNothing };
const FLAGS = ["driver", "k", "model", "budget", "out", "suite"];
const USAGE = "usage: run.sh <variant> --driver <stub:good|stub:do-nothing> [--suite floor|extra] [--k N] [--model M] [--budget USD, at most 12] [--out DIR]";

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
  const driver = DRIVERS[flags.driver];
  if (!driver)
    return refuse(`no driver: pass --driver ${Object.keys(DRIVERS).join(" or ")}. Real model runs are recorded by a separate task.`);
  const model = flags.model ?? registry.models?.find((m) => m.default)?.model;
  if (!registry.models?.some((m) => m.model === model)) return refuse(`unknown model ${model}`);
  const k = Number(flags.k ?? 3);
  const budget = Number(flags.budget ?? BUDGET_USD);
  if (!Number.isInteger(k) || k < 1) return refuse("--k must be a whole number of at least 1");
  if (!(budget > 0 && budget <= BUDGET_USD)) return refuse(`--budget must be more than 0 and at most ${BUDGET_USD}`);
  // A stub's report is never evidence, so by default it goes to a temp dir, not evals/reports.
  const out = flags.out ?? mkdtempSync(path.join(os.tmpdir(), "foreman-eval-stub-"));
  const suite = flags.suite ?? "floor";
  if (!["floor", "extra"].includes(suite)) return console.error("--suite must be floor or extra") ?? 2;
  const { exitCode, reportPath, report } = await runEval({ variant, model, driver, driverName: flags.driver, k, budget, out, suite });
  console.log(`${reportPath}: ${report.complete ? "complete" : `incomplete (${report.reason})`}`);
  return exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
