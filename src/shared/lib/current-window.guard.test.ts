// SPDX-License-Identifier: MIT
/**
 * The app takes its window, webview and webview-window handles only through
 * `current-window.ts`, so a second window never acts through a handle it did
 * not mean. The scan reads calls with the TypeScript parser, so a comment that
 * names `getCurrentWindow()` does not count.
 *
 * Scope: every non-test `.ts`/`.tsx` file under `src/`, except `src/app/mock/`,
 * `current-window.ts` itself and the webdriver-only `src/app/e2e-*-control.ts`.
 */
import { readFileSync } from "fs";
import { relative, resolve, sep } from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { sourceFiles } from "./__test-utils__/copy-strings";

const SRC = resolve(__dirname, "../..");
const HANDLES = new Set(["getCurrentWindow", "getCurrentWebview", "getCurrentWebviewWindow"]);
const ALLOWED = (file: string) =>
  file === "shared/lib/current-window.ts" || /^app\/e2e-[^/]*-control\.ts$/.test(file);

function handleCalls(file: string, text: string): string[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name !== null && HANDLES.has(name)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        hits.push(`${file}:${line}: ${name}()`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe("window handles come from current-window.ts", () => {
  it("no other app file calls getCurrentWindow, getCurrentWebview or getCurrentWebviewWindow", () => {
    const hits = sourceFiles(SRC)
      .map((path) => relative(SRC, path).split(sep).join("/"))
      .filter((file) => !file.startsWith("app/mock/") && !ALLOWED(file))
      .flatMap((file) => handleCalls(file, readFileSync(resolve(SRC, file), "utf8")));
    expect(hits).toEqual([]);
  });

  it("catches each of the three forms, but not a comment", () => {
    const planted = [
      "// getCurrentWindow() in a comment is not a call",
      "getCurrentWindow().setTitle(title);",
      "const view = getCurrentWebview();",
      "void api.getCurrentWebviewWindow().listen('x', () => {});",
    ].join("\n");
    expect(handleCalls("planted.ts", planted)).toEqual([
      "planted.ts:2: getCurrentWindow()",
      "planted.ts:3: getCurrentWebview()",
      "planted.ts:4: getCurrentWebviewWindow()",
    ]);
  });
});
