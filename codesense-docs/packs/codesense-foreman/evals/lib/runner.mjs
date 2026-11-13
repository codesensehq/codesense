// SPDX-License-Identifier: MIT
// Runs each case k times in fresh fixtures, grades it and writes the report. Drivers are
// pluggable: the stubs run in CI at $0; the real model driver belongs to the recorded-runs task.
//
// Driver contract: `driver({ caseDef, fx })` plays `caseDef.input.turns` through `fx.human`, logs
// every Foreman tool call through `fx.tool("foreman", name, args)` with the real MCP argument
// names, runs git and gh with `fx.env`, and returns `{ cost_usd, tokens }`. It throws InfraError
// when the sandbox or the API fails; any other throw grades the run as a fail.
import console from "node:console";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { createFixture } from "./fixture.mjs";
import { CASE_IDS } from "./floor.mjs";
import { grade, loadCases } from "./graders.mjs";
import { stubs } from "./stubs.mjs";

const packDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BUDGET_USD = 12;

export class InfraError extends Error {}

export async function runEval({ variant, model, k = 3, driver, driverName, out, budget = BUDGET_USD, date = new Date() }) {
  const specHash = parse(readFileSync(path.join(packDir, "pack.yml"), "utf8")).spec_hash?.[variant] ?? null;
  const cases = loadCases();
  const ids = cases.map((c) => c.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...CASE_IDS].sort()))
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
          fx = await createFixture({ failFirstPr: caseDef.fixture?.fail_first_pr === true });
        } catch (error) {
          throw new InfraError(`fixture: ${error.message}`);
        }
        const spent = (await driver({ caseDef, fx })) ?? {};
        cost += spent.cost_usd ?? 0;
        tokens += spent.tokens ?? 0;
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
    runtime: variant.replace(/^foreman-/, ""),
    model,
    spec_hash: specHash,
    driver: driverName ?? "model",
    k,
    complete,
    reason,
    at: date.toISOString(),
    cost_usd: cost,
    tokens,
    cases: results,
  };
  mkdirSync(out, { recursive: true });
  let reportPath = path.join(out, `${variant}-${report.at.slice(0, 10)}.md`);
  for (let n = 2; existsSync(reportPath); n += 1) reportPath = path.join(out, `${variant}-${report.at.slice(0, 10)}-${n}.md`);
  const body = notes.length ? `\n## Failures\n\n${notes.map((n) => `- ${n}`).join("\n")}\n` : "";
  writeFileSync(reportPath, `---\n${stringify(report)}---\n\n# ${variant} eval, ${report.at}\n${body}`);
  const allPass = CASE_IDS.every((id) => results[id]?.length && results[id].every((r) => r === "pass"));
  return { exitCode: complete && allPass ? 0 : 1, report, reportPath };
}

const DRIVERS = { "stub:good": stubs.good, "stub:do-nothing": stubs.doNothing };
const USAGE = "usage: run.sh <variant> --driver <stub:good|stub:do-nothing> [--k N] [--model M] [--budget USD] [--out DIR]";

async function main(argv) {
  const [variant, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith("--") || rest[i + 1] === undefined) return console.error(USAGE) ?? 2;
    flags[rest[i].slice(2)] = rest[i + 1];
  }
  const registry = parse(readFileSync(path.join(packDir, "variants.yml"), "utf8"));
  if (!variant || variant.startsWith("--")) return console.error(USAGE) ?? 2;
  if (variant !== registry.agent) return console.error(`unknown variant ${variant}; this pack has ${registry.agent}`) ?? 2;
  const driver = DRIVERS[flags.driver];
  if (!driver) {
    console.error("no driver: pass --driver stub:good or stub:do-nothing. Real model runs are recorded by a separate task.");
    return 2;
  }
  const model = flags.model ?? registry.models?.find((m) => m.default)?.model;
  if (!registry.models?.some((m) => m.model === model)) return console.error(`unknown model ${model}`) ?? 2;
  const k = Number(flags.k ?? 3);
  const budget = Number(flags.budget ?? BUDGET_USD);
  if (!Number.isInteger(k) || k < 1) return console.error("--k must be a whole number of at least 1") ?? 2;
  if (!(budget > 0)) return console.error("--budget must be a positive number") ?? 2;
  // A stub's report is never evidence, so by default it goes to a temp dir, not evals/reports.
  const out = flags.out ?? mkdtempSync(path.join(os.tmpdir(), "foreman-eval-stub-"));
  const { exitCode, reportPath, report } = await runEval({ variant, model, driver, driverName: flags.driver, k, budget, out });
  console.log(`${reportPath}: ${report.complete ? "complete" : `incomplete (${report.reason})`}`);
  return exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
