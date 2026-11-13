// SPDX-License-Identifier: MIT
// The registry check: every row's `eval` must equal what the reports for its key say (a hand edit
// fails), and a `passed` row must carry the spec_hash the pack was built with.
// Standalone until the pack builder exists; the build runs it once there is one.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadReports, statusFor } from "./floor.mjs";

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
  for (const row of registry.variants ?? []) {
    const label = `${registry.agent} ${row.model}`;
    const computed = statusFor(all, row);
    if (row.eval !== computed) errors.push(`${label}: eval is "${row.eval}" but its reports say "${computed}"`);
    if (row.eval !== "untested" && !all.some((r) => r.file === row.report))
      errors.push(`${label}: report "${row.report}" does not exist`);
    if (row.eval === "passed" && (row.spec_hash ?? null) !== built)
      errors.push(`${label}: passed on spec_hash ${row.spec_hash} but the pack builds ${built}; re-run the eval or set the row to untested`);
  }
  return errors;
}
