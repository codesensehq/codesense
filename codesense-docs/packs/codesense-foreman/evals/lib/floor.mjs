// SPDX-License-Identifier: MIT
// The floor rule. A variant is keyed by runtime, model and spec_hash. Only complete reports with
// k >= 3 from a model driver count (a scripted stub's report never does); the latest decides;
// passed needs all four cases to pass in every run.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

export const CASE_IDS = ["onboard-repo", "start-sprint-lead", "answer-card", "recover-error"];
export const MIN_K = 3;

// The report's front block, or null for a file that has none (a README, a note).
export function parseReport(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? parse(m[1]) : null;
}

export function loadReports(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .flatMap((f) => {
      const front = parseReport(readFileSync(path.join(dir, f), "utf8"));
      return front && typeof front === "object" ? [{ ...front, file: f }] : [];
    });
}

const sameKey = (r, key) =>
  r.runtime === key.runtime && r.model === key.model && (r.spec_hash ?? null) === (key.spec_hash ?? null);
const fromModel = (r) => typeof r.driver === "string" && !r.driver.startsWith("stub:");
const dated = (r) => typeof r.at === "string" && !Number.isNaN(Date.parse(r.at));

// The report that decides a key's status, or undefined.
export function latestFor(reports, key) {
  return reports
    .filter((r) => sameKey(r, key) && fromModel(r) && dated(r) && r.complete === true && r.k >= MIN_K)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.file?.localeCompare(b.file ?? "") || 0)
    .at(-1);
}

export function statusFor(reports, key) {
  const latest = latestFor(reports, key);
  if (!latest) return "untested";
  const runs = CASE_IDS.map((id) => latest.cases?.[id] ?? []);
  const results = runs.flat();
  if (results.includes("fail")) return "failed";
  const complete = runs.every((r) => r.length >= MIN_K) && results.every((x) => x === "pass");
  return complete ? "passed" : "untested";
}
