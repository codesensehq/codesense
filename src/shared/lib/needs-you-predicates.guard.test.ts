// SPDX-License-Identifier: MIT
/**
 * One needs-you set: what waits on the person is derived once, by the host's needs-you
 * module, and every surface reads that set. Frontend and docs code that still says a
 * needs-you or permission predicate is in the shared allow-list with its exact hit count,
 * so a new file fails, a new predicate in a listed file fails, and a stale entry fails.
 * The list's length and the sum of its counts must equal their ceilings for the release
 * in progress in `tests/fixtures/allowlist-ceilings.json`, and no ceiling rises from one
 * release to the next. What counts as a predicate, and which files are test code, comes
 * from `tests/fixtures/needs-you-predicates.txt`, which the Rust guard
 * (`needs_you_predicates_guard.rs`) reads too, for the Rust entries.
 */
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(__dirname, "../../..");
const ALLOWLIST = "src-tauri/crates/codesense-guards/tests/needs_you_predicates_allowlist.txt";
const CEILINGS = "tests/fixtures/allowlist-ceilings.json";
const PATTERNS = "tests/fixtures/needs-you-predicates.txt";
const LIST = "needsYouPredicates";
const LIST_HITS = "needsYouPredicatesHits";

/** The rules in the shared patterns file, `<rule> <value>` per line, by rule. */
function parsePatterns(text: string): Map<string, string[]> {
  const rules = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const space = line.indexOf(" ");
    const [rule, value] = space < 0 ? [line, ""] : [line.slice(0, space), line.slice(space + 1)];
    rules.set(rule, [...(rules.get(rule) ?? []), value]);
  }
  return rules;
}

const rules = parsePatterns(readFileSync(resolve(repo, PATTERNS), "utf8"));
const rule = (name: string): string[] => rules.get(name) ?? [];

/** `NeedsYou` → `needs_you`. */
const snake = (stem: string): string => stem.replace(/(?!^)([A-Z])/g, "_$1").toLowerCase();

function predicateIdent(token: string): boolean {
  if (rule("ident").includes(token)) return true;
  return rule("prefix").some((prefix) => {
    if (!token.startsWith(prefix)) return false;
    const rest = token.slice(prefix.length);
    if (/^[A-Z]/.test(rest)) return rule("stem").some((stem) => rest.includes(stem));
    if (rest.startsWith("_")) return rule("stem").some((stem) => rest.includes(`_${snake(stem)}`));
    return false;
  });
}

function lineHits(line: string): boolean {
  const flat = line.replace(/\s+/g, "").replaceAll("'", '"');
  const arm =
    flat.includes("=>") &&
    rule("arm").some(
      (state) =>
        flat.includes(`${state}|`) || flat.includes(`|${state}`) || flat.includes(`${state}=>`),
    );
  return (
    arm ||
    rule("literal").some((literal) => flat.includes(literal)) ||
    line.split(/[^A-Za-z0-9_]/).some((token) => token !== "" && predicateIdent(token))
  );
}

function isTestFile(rel: string): boolean {
  const name = rel.split("/").pop() ?? rel;
  return (
    rule("test-name").includes(name) ||
    rule("test-name-suffix").some((suffix) => name.endsWith(suffix)) ||
    rule("test-name-part").some((part) => name.includes(part)) ||
    rule("test-dir").some((dir) => rel.includes(dir))
  );
}

function files(dir: string, exts: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(full, exts);
    const ext = entry.name.includes(".") ? entry.name.split(".").pop()! : "";
    return exts.includes(ext) ? [full] : [];
  });
}

/** `path → hit count` for every frontend and docs file whose code says a predicate. */
function hits(): Map<string, number> {
  const roots: [string, string[]][] = [
    ["src", ["ts", "tsx"]],
    ["codesense-docs", ["js", "mjs", "html"]],
  ];
  const out = new Map<string, number>();
  for (const [root, exts] of roots)
    for (const file of files(resolve(repo, root), exts)) {
      const rel = relative(repo, file).replaceAll("\\", "/");
      if (isTestFile(rel)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      if (lines.at(-1) === "") lines.pop();
      const count = lines.filter(lineHits).length;
      if (count > 0) out.set(rel, count);
    }
  return out;
}

/** `path → pinned hit count` for every allow-list entry. Lines are `<path> <count>`. */
function allowlist(): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of readFileSync(resolve(repo, ALLOWLIST), "utf8").split("\n")) {
    const line = raw.split("#")[0].trim();
    if (line === "") continue;
    const [path, count] = line.split(/\s+/);
    expect(Number.isInteger(Number(count)), `${path} has a hit count`).toBe(true);
    expect(out.has(path), `${path} is listed once`).toBe(false);
    out.set(path, Number(count));
  }
  return out;
}

type Ceilings = { current: string; ceilings: Record<string, Record<string, number>> };

/** Whether `list` has exactly its ceiling for release `current`: above it a surface was
 *  added, below it a removal was not locked in by lowering the ceiling. */
function checkCeiling(file: Ceilings, list: string, current: string, count: number): string | null {
  const ceiling = file.ceilings[list]?.[current];
  if (ceiling === undefined) return `\`${list}\` has no ceiling for release \`${current}\``;
  if (count > ceiling)
    return `\`${list}\` is ${count}, above release ${current}'s ceiling of ${ceiling}: read the needs-you set instead`;
  if (count < ceiling)
    return `\`${list}\` is ${count}, below release ${current}'s ceiling of ${ceiling}: lower it to ${count} for ${current} and every later release`;
  return null;
}

/** Whether no ceiling of `list` is above the one before it, in release order. */
function checkNeverRising(file: Ceilings, list: string): string | null {
  const ceilings = Object.entries(file.ceilings[list] ?? {});
  for (let i = 1; i < ceilings.length; i++)
    if (ceilings[i][1] > ceilings[i - 1][1])
      return `\`${list}\` rises from ${ceilings[i - 1][1]} at ${ceilings[i - 1][0]} to ${ceilings[i][1]} at ${ceilings[i][0]}`;
  return null;
}

const ceilingsFile = (): Ceilings =>
  JSON.parse(readFileSync(resolve(repo, CEILINGS), "utf8")) as Ceilings;

describe("needs-you predicates stay in the owner and the allow-list", () => {
  it("frontend and docs code says a predicate only in listed files, as often as pinned", () => {
    const found = hits();
    const allowed = allowlist();
    const problems: string[] = [];
    for (const [path, count] of found) {
      const pinned = allowed.get(path);
      if (pinned === undefined)
        problems.push(`${path}: ${count} lines, not allow-listed; read the needs-you set instead`);
      else if (pinned !== count)
        problems.push(`${path}: ${count} lines, allow-list pins ${pinned}`);
    }
    for (const path of allowed.keys())
      if (!path.endsWith(".rs") && !found.has(path))
        problems.push(`${path}: allow-listed but says no predicate now; drop it`);
    expect(problems).toEqual([]);
  });

  it("the allow-list matches its ceilings for the current release", () => {
    const file = ceilingsFile();
    const allowed = allowlist();
    const total = [...allowed.values()].reduce((sum, count) => sum + count, 0);
    expect([
      checkCeiling(file, LIST, file.current, allowed.size),
      checkCeiling(file, LIST_HITS, file.current, total),
    ]).toEqual([null, null]);
  });

  it("the ceilings never rise in release order", () => {
    const file = ceilingsFile();
    expect([checkNeverRising(file, LIST), checkNeverRising(file, LIST_HITS)]).toEqual([null, null]);
  });

  it("the ceiling checks follow the release they are given", () => {
    const file: Ceilings = {
      current: "R1",
      ceilings: {
        [LIST]: { R0: 3, R1: 2, R2: 0 },
        [LIST_HITS]: { R0: 9, R1: 9 },
        other: { R0: 1, R1: 4 },
      },
    };
    expect(checkCeiling(file, LIST, "R0", 3)).toBeNull();
    expect(checkCeiling(file, LIST, "R0", 4)).toMatch(/above release R0's ceiling of 3/);
    expect(checkCeiling(file, LIST, "R0", 2)).toMatch(/below release R0's ceiling of 3/);
    expect(checkCeiling(file, LIST, "R2", 0)).toBeNull();
    expect(checkCeiling(file, LIST, "R2", 1)).not.toBeNull();
    expect(checkCeiling(file, LIST_HITS, "R1", 9)).toBeNull();
    expect(checkCeiling(file, LIST_HITS, "R2", 9)).toMatch(/no ceiling/);
    expect(checkCeiling(file, LIST, "R9", 0)).toMatch(/no ceiling/);
    expect(checkCeiling(file, "missing", "R0", 0)).toMatch(/no ceiling/);
    expect(checkNeverRising(file, LIST)).toBeNull();
    expect(checkNeverRising(file, LIST_HITS)).toBeNull();
    expect(checkNeverRising(file, "other")).toMatch(/rises from 1 at R0 to 4 at R1/);
  });

  it("flags each shared hit example and none of the misses", () => {
    expect(rule("hit").length).toBeGreaterThan(0);
    expect(rule("hit").filter((line) => !lineHits(line))).toEqual([]);
    expect(rule("miss").filter(lineHits)).toEqual([]);
  });
});
