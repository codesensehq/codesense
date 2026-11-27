// SPDX-License-Identifier: MIT
/**
 * The tiles release flag guards every tile path. Each file that writes a tile file or mounts
 * the tile host is listed in `tiles-flag-sites.json`, and each listed file must await
 * `tilesEnabled()` in code: a mention in a comment or a string doesn't count. With the flag off
 * the app is today's app and no tile code writes any file.
 */
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const SITES = join(ROOT, "src/shared/lib/tiles-flag-sites.json");

/**
 * Whether the source awaits `tilesEnabled()` (or chains `.then` on it). The call returns a
 * Promise, so a bare `if (!tilesEnabled())` is always false and guards nothing. Comments and
 * strings are not calls.
 */
function awaitsTilesEnabled(file: string, text: string): boolean {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let found = false;
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  const isCall = (node: ts.Node): boolean =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "tilesEnabled";
  const visit = (node: ts.Node) => {
    if (ts.isAwaitExpression(node) && isCall(unwrap(node.expression))) found = true;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "then" &&
      isCall(unwrap(node.expression.expression))
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * What is wrong with the list: its format, then each site that is missing or doesn't await the
 * flag. `read` returns a listed file's text, or null when it doesn't exist.
 */
function siteProblems(list: unknown, read: (file: string) => string | null): string[] {
  if (!Array.isArray(list)) return ["the list must be a JSON array"];
  const problems: string[] = [];
  const seen = new Set<string>();
  list.forEach((entry: unknown, i) => {
    const at = `entry ${i}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push(`${at}: must be an object with "file" and "what"`);
      return;
    }
    const keys = Object.keys(entry).sort();
    if (keys.join(",") !== "file,what") {
      problems.push(`${at}: must have exactly "file" and "what", has ${keys.join(", ")}`);
      return;
    }
    const { file, what } = entry as { file: unknown; what: unknown };
    if (typeof file !== "string" || !/^src\/.+\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) {
      problems.push(`${at}: "file" must be a non-test .ts or .tsx path under src/`);
      return;
    }
    if (typeof what !== "string" || what.trim() === "") {
      problems.push(`${at}: "what" must say what the site writes or mounts`);
      return;
    }
    if (seen.has(file)) {
      problems.push(`${file}: listed twice`);
      return;
    }
    seen.add(file);
    const text = read(file);
    if (text === null) problems.push(`${file}: listed but missing`);
    else if (!awaitsTilesEnabled(file, text))
      problems.push(`${file}: doesn't await tilesEnabled()`);
  });
  return problems;
}

function readSite(file: string): string | null {
  const path = join(ROOT, file);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

describe("every tile writer and the tile host check the tiles flag", () => {
  it("the list exists and every listed site awaits tilesEnabled()", () => {
    expect(existsSync(SITES)).toBe(true);
    const list: unknown = JSON.parse(readFileSync(SITES, "utf8"));
    expect(siteProblems(list, readSite)).toEqual([]);
  });

  it("fails a listed site that only mentions the flag, or calls it without awaiting", () => {
    const planted: Record<string, string> = {
      "src/planted-writer.ts": [
        "// tilesEnabled() is checked by the caller",
        'const note = "tilesEnabled()";',
        "export const write = () => saveTile(note);",
      ].join("\n"),
      "src/planted-sync.ts": "export function write() { if (!tilesEnabled()) return; }",
      "src/planted-then.ts":
        "export const write = () => tilesEnabled().then((on) => on && save());",
      "src/planted-host.tsx": [
        'import { tilesEnabled } from "@/shared/lib/tiles-enabled";',
        "export async function mount() { if (!(await tilesEnabled())) return; }",
      ].join("\n"),
    };
    const list = [
      { file: "src/planted-writer.ts", what: "writes a tile file" },
      { file: "src/planted-host.tsx", what: "mounts the tile host" },
      { file: "src/planted-sync.ts", what: "writes a tile file" },
      { file: "src/planted-then.ts", what: "writes a tile file" },
    ];
    expect(siteProblems(list, (file) => planted[file] ?? null)).toEqual([
      "src/planted-writer.ts: doesn't await tilesEnabled()",
      "src/planted-sync.ts: doesn't await tilesEnabled()",
    ]);
  });

  it("checks the list's format", () => {
    const none = () => null;
    expect(siteProblems({ sites: [] }, none)).toEqual(["the list must be a JSON array"]);
    expect(
      siteProblems(
        [
          "src/a.ts",
          { file: "src/a.ts" },
          { file: "src/a.ts", what: "x", extra: 1 },
          { file: "lib/a.ts", what: "x" },
          { file: "src/a.test.ts", what: "x" },
          { file: "src/a.ts", what: " " },
          { file: "src/gone.ts", what: "writes a tile file" },
        ],
        none,
      ),
    ).toEqual([
      'entry 0: must be an object with "file" and "what"',
      'entry 1: must have exactly "file" and "what", has file',
      'entry 2: must have exactly "file" and "what", has extra, file, what',
      'entry 3: "file" must be a non-test .ts or .tsx path under src/',
      'entry 4: "file" must be a non-test .ts or .tsx path under src/',
      'entry 5: "what" must say what the site writes or mounts',
      "src/gone.ts: listed but missing",
    ]);
  });
});
