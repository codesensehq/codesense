// SPDX-License-Identifier: MIT
/**
 * The app writes `app-state.json` in one place: `patchAppState` in
 * `app-state-write.ts`, which saves a key patch (`patch: true`) from `main` and
 * sends a satellite's allowed keys to `patch_app_state_keys`. A full write from
 * any other file would replace keys another window wrote. The scan reads calls
 * with the TypeScript parser, so a comment that names `saveAppState()` does not
 * count.
 *
 * Scope: every non-test `.ts`/`.tsx` file under `src/`, except `src/app/mock/`.
 */
import { readFileSync } from "fs";
import { relative, resolve, sep } from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { sourceFiles } from "./__test-utils__/copy-strings";

const SRC = resolve(__dirname, "../..");
const WRITER = "shared/lib/app-state-write.ts";

interface Call {
  file: string;
  line: number;
  name: string;
  args: string[];
}

function calls(file: string, text: string, names: Set<string>): Call[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: Call[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name !== null && names.has(name)) {
        hits.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          name,
          args: node.arguments.map((arg) => arg.getText(source)),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

const appFiles = () =>
  sourceFiles(SRC)
    .map((path) => relative(SRC, path).split(sep).join("/"))
    .filter((file) => !file.startsWith("app/mock/"))
    .map((file) => ({ file, text: readFileSync(resolve(SRC, file), "utf8") }));

describe("app-state writes go through patchAppState", () => {
  it("no file but app-state-write.ts calls saveAppState, and the one call there is a patch", () => {
    const hits = appFiles().flatMap(({ file, text }) =>
      calls(file, text, new Set(["saveAppState"])),
    );
    expect(hits.filter((hit) => hit.file !== WRITER).map((h) => `${h.file}:${h.line}`)).toEqual([]);
    const own = hits.filter((hit) => hit.file === WRITER);
    expect(own).toHaveLength(1);
    expect(own[0].args[1]).toBe("true");
  });

  it("patchAppState sits beside serializeAppStateWrite, and every caller uses the queue", () => {
    const writer = readFileSync(resolve(SRC, WRITER), "utf8");
    expect(writer).toMatch(/export function serializeAppStateWrite\(/);
    expect(writer).toMatch(/export async function patchAppState\(/);
    const callers = appFiles().filter(
      ({ file, text }) =>
        file !== WRITER && calls(file, text, new Set(["patchAppState"])).length > 0,
    );
    expect(callers.length).toBeGreaterThan(0);
    const unqueued = callers
      .filter(
        ({ file, text }) => calls(file, text, new Set(["serializeAppStateWrite"])).length === 0,
      )
      .map(({ file }) => file);
    expect(unqueued).toEqual([]);
  });

  it("catches a call, a method call and the patch flag, but not a comment", () => {
    const planted = [
      "// saveAppState(raw) in a comment is not a call",
      "await saveAppState(raw);",
      "void commands.saveAppState(raw, true);",
    ].join("\n");
    expect(
      calls("planted.ts", planted, new Set(["saveAppState"])).map((c) => [c.line, c.args]),
    ).toEqual([
      [2, ["raw"]],
      [3, ["raw", "true"]],
    ]);
  });
});
