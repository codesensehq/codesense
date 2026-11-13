// SPDX-License-Identifier: MIT
// The floor rule. A variant is keyed by runtime, model and spec_hash. Only complete reports with
// k >= 3 count; the latest decides; passed needs all four cases to pass in every run.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

export const CASE_IDS = ["onboard-repo", "start-sprint-lead", "answer-card", "recover-error"];
export const MIN_K = 3;

export function parseReport(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) throw new Error("report has no front block");
  return parse(m[1]);
}

export function loadReports(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ ...parseReport(readFileSync(path.join(dir, f), "utf8")), file: f }));
}

const sameKey = (r, key) =>
  r.runtime === key.runtime && r.model === key.model && (r.spec_hash ?? null) === (key.spec_hash ?? null);

export function statusFor(reports, key) {
  const counted = reports
    .filter((r) => sameKey(r, key) && r.complete === true && r.k >= MIN_K)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const latest = counted.at(-1);
  if (!latest) return "untested";
  const runs = CASE_IDS.map((id) => latest.cases?.[id] ?? []);
  const results = runs.flat();
  if (results.includes("fail")) return "failed";
  const complete = runs.every((r) => r.length >= MIN_K) && results.every((x) => x === "pass");
  return complete ? "passed" : "untested";
}
