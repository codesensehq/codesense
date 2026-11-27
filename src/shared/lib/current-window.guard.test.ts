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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative, resolve, sep } from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { sourceFiles } from "./__test-utils__/copy-strings";

const SRC = resolve(__dirname, "../..");
const TAURI_MODULES = new Set([
  "@tauri-apps/api",
  "@tauri-apps/api/window",
  "@tauri-apps/api/webview",
  "@tauri-apps/api/webviewWindow",
]);
const HANDLE_FUNCTIONS = new Set([
  "getCurrentWindow",
  "getCurrentWebview",
  "getCurrentWebviewWindow",
  "getAllWindows",
  "getAllWebviews",
  "getAllWebviewWindows",
]);
const HANDLE_CLASSES = new Set(["Window", "Webview", "WebviewWindow"]);
const HANDLE_STATICS = new Set(["getCurrent", "getAll", "getByLabel"]);
const ALLOWED = (file: string) =>
  file === "shared/lib/current-window.ts" || /^app\/e2e-[^/]*-control\.ts$/.test(file);

/** The text of an identifier or the last name of a property access, else null. */
function lastName(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return null;
}

function handleUses(file: string, text: string): string[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  // The local name of each handle function or class imported from a Tauri module, by what it is.
  const imported = new Map<string, string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !TAURI_MODULES.has(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      imported.set(element.name.text, (element.propertyName ?? element.name).text);
    }
  }
  const hits: string[] = [];
  const hit = (node: ts.Node, what: string) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    hits.push(`${file}:${line}: ${what}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent)) {
      const name = imported.get(node.text);
      const member = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
      if (name !== undefined && !member && HANDLE_FUNCTIONS.has(name)) hit(node, `${name}`);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (HANDLE_FUNCTIONS.has(name)) hit(node, `${name}`);
      const receiver = lastName(node.expression);
      const cls = receiver === null ? undefined : (imported.get(receiver) ?? receiver);
      if (HANDLE_STATICS.has(name) && cls !== undefined && HANDLE_CLASSES.has(cls)) {
        hit(node, `${cls}.${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe("window handles come from current-window.ts", () => {
  it("no other app file takes a window, webview or webview-window handle", () => {
    const hits = sourceFiles(SRC, [])
      .map((path) => relative(SRC, path).split(sep).join("/"))
      .filter((file) => !file.startsWith("app/mock/") && !ALLOWED(file))
      .flatMap((file) => handleUses(file, readFileSync(resolve(SRC, file), "utf8")));
    expect(hits).toEqual([]);
  });

  it("scans mock-named, fixtures and __tests__ directories outside src/app/mock/", () => {
    const dir = mkdtempSync(join(tmpdir(), "handles-"));
    for (const name of ["mock", "fixtures", "__tests__"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "a.ts"), "");
    }
    try {
      const names = (skip?: readonly string[]) =>
        sourceFiles(dir, skip)
          .map((path) => relative(dir, path).split(sep).join("/"))
          .sort();
      expect(names()).toEqual([]);
      expect(names([])).toEqual(["__tests__/a.ts", "fixtures/a.ts", "mock/a.ts"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("catches each handle form, aliased or not, but not a comment", () => {
    const planted = [
      'import { getCurrentWindow, getCurrentWebview as view } from "@tauri-apps/api/window";',
      'import { Window as W, WebviewWindow } from "@tauri-apps/api/webviewWindow";',
      'import { getAllWindows as all } from "@tauri-apps/api/window";',
      "// getCurrentWindow() in a comment is not a call",
      "getCurrentWindow().setTitle(title);",
      "const handle = view();",
      "void api.getCurrentWebviewWindow().listen('x', () => {});",
      "const w = W.getCurrent();",
      "const found = WebviewWindow.getByLabel('main');",
      "const every = all();",
      "const pass = getCurrentWindow;",
      "const other = Thing.getCurrent();",
    ].join("\n");
    expect(handleUses("planted.ts", planted)).toEqual([
      "planted.ts:5: getCurrentWindow",
      "planted.ts:6: getCurrentWebview",
      "planted.ts:7: getCurrentWebviewWindow",
      "planted.ts:8: Window.getCurrent",
      "planted.ts:9: WebviewWindow.getByLabel",
      "planted.ts:10: getAllWindows",
      "planted.ts:11: getCurrentWindow",
    ]);
  });
});
