// SPDX-License-Identifier: MIT
// The registry check: every row's `eval`, `report` and `at` must equal what the reports for its
// key say (a hand edit fails), every model has a row, no key has two, and a `passed` row must
// carry the spec_hash the pack was built with.
// Standalone until the pack builder exists; the build runs it once there is one.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { latestFor, loadReports, statusFor } from "./floor.mjs";

const packDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function checkRegistry({
  variants = path.join(packDir, "variants.yml"),
  pack = path.join(packDir, "pack.yml"),
  reports = path.join(packDir, "evals", "reports"),
} = {}) {
  const registry = parse(readFileSync(variants, "utf8"));
  const built = parse(readFileSync(pack, "utf8")).spec_hash?.[registry.agent] ?? null;
  const all = loadReports(reports);
  const errors = [];
  const seen = new Set();
  const rows = registry.variants ?? [];
  for (const m of registry.models ?? [])
    if (!rows.some((r) => r.model === m.model)) errors.push(`${registry.agent} ${m.model}: no variants row`);
  const runtime = String(registry.agent).replace(/^foreman-/, "");
  for (const row of rows) {
    const label = `${registry.agent} ${row.runtime} ${row.model} ${row.spec_hash ?? "null"}`;
    const key = JSON.stringify([row.runtime, row.model, row.spec_hash ?? null]);
    if (seen.has(key)) errors.push(`${label}: duplicate row`);
    seen.add(key);
    if (!(registry.models ?? []).some((m) => m.model === row.model)) errors.push(`${label}: model is not in models`);
    if (row.runtime !== runtime) errors.push(`${label}: runtime is not ${runtime}`);
    const computed = statusFor(all, row);
    if (row.eval !== computed) errors.push(`${label}: eval is "${row.eval}" but its reports say "${computed}"`);
    const latest = latestFor(all, row);
    const report = latest?.file ?? null;
    const at = latest?.at ?? null;
    if ((row.report ?? null) !== report || (row.at ?? null) !== at)
      errors.push(`${label}: names report ${row.report ?? null} at ${row.at ?? null}, but the deciding report is ${report} at ${at}`);
    if (row.eval === "passed" && (row.spec_hash ?? null) !== built)
      errors.push(`${label}: passed on spec_hash ${row.spec_hash} but the pack builds ${built}; re-run the eval or set the row to untested`);
  }
  return errors;
}
