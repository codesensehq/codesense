// SPDX-License-Identifier: MIT
/**
 * One needs-you set: what waits on the person is derived once, by the host's needs-you
 * module, and every surface reads that set. Frontend and docs code that still says a
 * needs-you or permission predicate is in the shared allow-list with its exact hit count,
 * so a new file fails, a new predicate in a listed file fails, and a stale entry fails.
 * The list only shrinks, and its length is capped per release by
 * `tests/fixtures/allowlist-ceilings.json`. The Rust guard
 * (`needs_you_predicates_guard.rs`) applies the same rules to the Rust entries.
 */
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(__dirname, "../../..");
const ALLOWLIST = "src-tauri/crates/codesense-guards/tests/needs_you_predicates_allowlist.txt";
const CEILINGS = "tests/fixtures/allowlist-ceilings.json";
const LIST = "needsYouPredicates";

/** Literal text that compares or names a needs-you or permission state. */
const LITERALS = [
  '"needs-permission"',
  "'needs-permission'",
  '"needs-you"',
  "'needs-you'",
  '"needs_you"',
  "'needs_you'",
  '=== "needs"',
  '!== "needs"',
];
/** Identifiers that are a needs-you or permission predicate or its input. */
const IDENTS = new Set([
  "needsYouKind",
  "needs_you_kind",
  "NeedsPermission",
  "needsYouBySender",
  "needsMailBySender",
  "needsBySender",
  "ASK_USER_STATE",
  "kindOf",
]);
/** A function or hook named for what needs you (`isNeedsYouStatus`, `selectNeedsYouKind`). */
const PREFIXES = ["is", "has", "select", "get", "count", "use"];

function predicateIdent(token: string): boolean {
  if (IDENTS.has(token)) return true;
  return (
    token.includes("NeedsYou") &&
    PREFIXES.some((prefix) => token.startsWith(prefix) && /^[A-Z]/.test(token.slice(prefix.length)))
  );
}

function lineHits(line: string): boolean {
  return (
    LITERALS.some((literal) => line.includes(literal)) ||
    line.split(/[^A-Za-z0-9_]/).some((token) => token !== "" && predicateIdent(token))
  );
}

function isTestFile(rel: string): boolean {
  const name = rel.split("/").pop() ?? rel;
  return (
    name.includes(".test.") ||
    name.includes(".spec.") ||
    rel.includes("/tests/") ||
    rel.includes("/evals/")
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

/** Whether a list of `count` entries is within its ceiling for release `current`. */
function checkCeiling(file: Ceilings, list: string, current: string, count: number): string | null {
  const ceiling = file.ceilings[list]?.[current];
  if (ceiling === undefined) return `\`${list}\` has no ceiling for release \`${current}\``;
  return count > ceiling
    ? `\`${list}\` has ${count} entries, above release ${current}'s ceiling of ${ceiling}`
    : null;
}

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

  it("the allow-list stays within the ceiling for the current release", () => {
    const file = JSON.parse(readFileSync(resolve(repo, CEILINGS), "utf8")) as Ceilings;
    expect(checkCeiling(file, LIST, file.current, allowlist().size)).toBeNull();
  });

  it("the ceiling check follows the release it is given", () => {
    const file: Ceilings = {
      current: "R1",
      ceilings: { [LIST]: { R0: 3, R1: 2, R2: 0 }, other: { R0: 9 } },
    };
    expect(checkCeiling(file, LIST, "R0", 3)).toBeNull();
    expect(checkCeiling(file, LIST, "R0", 4)).toMatch(/above release R0's ceiling of 3/);
    expect(checkCeiling(file, LIST, "R2", 0)).toBeNull();
    expect(checkCeiling(file, LIST, "R2", 1)).not.toBeNull();
    expect(checkCeiling(file, LIST, "R9", 0)).toMatch(/no ceiling/);
    expect(checkCeiling(file, "other", "R1", 0)).toMatch(/no ceiling/);
  });

  it("matches predicates and leaves prose and look-alikes alone", () => {
    expect(lineHits("if (row.needsYouKind === null) return;")).toBe(true);
    expect(lineHits("const waiting = selectNeedsYouKind(state);")).toBe(true);
    expect(lineHits('if (state === "needs") return;')).toBe(true);
    expect(lineHits("kind: 'needs-you',")).toBe(true);
    expect(lineHits("const needsYouHandlers = {};")).toBe(false);
    expect(lineHits("// what needs you")).toBe(false);
    expect(lineHits("let NeedsPermissionish = 1;")).toBe(false);
  });
});
