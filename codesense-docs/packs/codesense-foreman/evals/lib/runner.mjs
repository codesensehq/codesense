// SPDX-License-Identifier: MIT
// Runs each case k times in fresh fixtures, grades it and writes the report. Drivers are
// pluggable: the stubs run in CI at $0; the real model driver belongs to the recorded-runs task.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { createFixture } from "./fixture.mjs";
import { CASE_IDS } from "./floor.mjs";
import { grade, loadCases } from "./graders.mjs";
import { stubs } from "./stubs.mjs";

const packDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BUDGET_USD = 12;

export class InfraError extends Error {}

export async function runEval({ variant, model, k = 3, driver, out, budget = BUDGET_USD, date = new Date() }) {
  const specHash = parse(readFileSync(path.join(packDir, "pack.yml"), "utf8")).spec_hash?.[variant] ?? null;
  const cases = loadCases();
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
        fx = await createFixture({ failFirstPr: caseDef.id === "recover-error" });
        const spent = (await driver({ caseDef, fx })) ?? {};
        cost += spent.cost_usd ?? 0;
        tokens += spent.tokens ?? 0;
        const verdict = grade(caseDef, fx.state());
        results[caseDef.id].push(verdict.pass ? "pass" : "fail");
        if (!verdict.pass) notes.push(`${caseDef.id} run ${run}: ${verdict.failures.join("; ")}`);
      } catch (error) {
        results[caseDef.id].push("error");
        complete = false;
        reason ||= `infra error in ${caseDef.id} run ${run}: ${error.message}`;
      } finally {
        fx?.teardown();
      }
    }
  }

  const report = {
    variant,
    runtime: variant.replace(/^foreman-/, ""),
    model,
    spec_hash: specHash,
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

async function main(argv) {
  const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const variant = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true);
  const driver = DRIVERS[opt("--driver")];
  if (!variant) return console.error("usage: run.sh <variant> --driver <stub:good|stub:do-nothing> [--k N]") ?? 2;
  if (!driver) {
    console.error("no driver: pass --driver stub:good or stub:do-nothing. Real model runs are recorded by a separate task.");
    return 2;
  }
  const registry = parse(readFileSync(path.join(packDir, "variants.yml"), "utf8"));
  const model = opt("--model", registry.models?.find((m) => m.default)?.model);
  const { exitCode, reportPath, report } = await runEval({
    variant,
    model,
    driver,
    k: Number(opt("--k", 3)),
    budget: Number(opt("--budget", BUDGET_USD)),
    out: opt("--out", path.join(packDir, "evals", "reports")),
  });
  console.log(`${reportPath}: ${report.complete ? "complete" : `incomplete (${report.reason})`}`);
  return exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
