// SPDX-License-Identifier: MIT
/**
 * The copy a source file shows: every string literal, template literal and JSX
 * text, never a comment. Shared by the guards that scan app copy under `src/`.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import ts from "typescript";

const TEST_DIRS = ["__tests__", "mock", "fixtures"] as const;

/**
 * Every non-test `.ts`/`.tsx` file under `dir`. Directories named in `skipDirs` are skipped
 * anywhere in the tree; by default the test, mock and fixture dirs. A guard that must reach
 * those dirs passes its own list (often `[]`) and filters the paths it means to leave out.
 */
export function sourceFiles(dir: string, skipDirs: readonly string[] = TEST_DIRS): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return skipDirs.includes(name) ? [] : sourceFiles(path, skipDirs);
    }
    return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

/**
 * The strings in the file at `path` with their line numbers. A template's text
 * parts are joined by a space. `text` stands in for the file's contents.
 */
export function copyStrings(
  path: string,
  text: string = readFileSync(path, "utf8"),
): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    let copy: string | null = null;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isJsxText(node)
    ) {
      copy = node.text;
    } else if (ts.isTemplateExpression(node)) {
      copy = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" ");
    }
    if (copy !== null) {
      found.push({
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        text: copy,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
