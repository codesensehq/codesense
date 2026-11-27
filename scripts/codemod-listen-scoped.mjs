// SPDX-License-Identifier: MIT
// Usage: node scripts/codemod-listen-scoped.mjs [--root <repo>] [--check]
//
// Moves each raw `listen` call from "@tauri-apps/api/event" onto `listenScoped`, with the scope its
// row in `src/shared/windows/listener-inventory.ts` names. Rerun it after a rebase that brings in
// new raw `listen` calls, instead of hand-merging them; run `prettier --write` on the touched
// files after. A call with no inventory row is reported and left alone: add the row first. `--check`
// prints what would change and exits 1 if anything would. A `listen` handed along by reference, and
// the live hub's injected `listen`, are not calls: change those by hand.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const EVENT_MODULE = "@tauri-apps/api/event";
const HELPER_IMPORT = "@/shared/windows/listen-scoped";
const HELPER_FILE = "shared/windows/listen-scoped.ts";
const INVENTORY_FILE = "shared/windows/listener-inventory.ts";

/** The row key of a call's event argument, as `listener-inventory.test.ts` computes it. */
export function eventKey(arg, source) {
  if (!arg) return "{}";
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) {
    return `{${arg.head.text}${arg.templateSpans.map((span) => `*${span.literal.text}`).join("")}}`;
  }
  const text = arg.getText(source);
  return /^[A-Z][A-Z0-9_]*$/.test(text) ? text : `{${text}}`;
}

function parse(file, text) {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** `file\0event` -> scope, read from the inventory's object literals. */
export function readInventory(text) {
  const rows = new Map();
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const fields = {};
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isStringLiteralLike(prop.initializer)) {
          fields[prop.name.getText()] = prop.initializer.text;
        }
      }
      if (fields.file && fields.event && fields.scope) {
        rows.set(`${fields.file}\0${fields.event}`, fields.scope);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(INVENTORY_FILE, text));
  return rows;
}

/** The rewritten text of one file (`file` relative to `src/`), and the calls it had no row for. */
export function rewrite(file, text, rows) {
  const source = parse(file, text);
  const names = new Set();
  const edits = [];
  let eventImport = null;
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== EVENT_MODULE ||
      statement.importClause?.isTypeOnly ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    const kept = [];
    const keptTypes = [];
    for (const element of statement.importClause.namedBindings.elements) {
      if (!element.isTypeOnly && (element.propertyName ?? element.name).text === "listen") {
        names.add(element.name.text);
      } else {
        kept.push(element.getText(source));
        keptTypes.push(element.isTypeOnly ? element.getText(source).replace(/^type\s+/, "") : null);
      }
    }
    if (names.size > 0 && eventImport === null) eventImport = { statement, kept, keptTypes };
  }
  if (!eventImport) return { text, missing: [] };

  const missing = [];
  let rewritten = 0;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      names.has(node.expression.text)
    ) {
      const key = eventKey(node.arguments[0], source);
      const scope = rows.get(`${file}\0${key}`);
      if (!scope || node.arguments.length === 0) {
        missing.push(`${file}: ${key} has no inventory row`);
      } else {
        const first = node.arguments[0];
        edits.push({
          at: node.expression.getStart(source),
          end: node.expression.getEnd(),
          text: "listenScoped",
        });
        edits.push({ at: first.getEnd(), end: first.getEnd(), text: `, ${JSON.stringify(scope)}` });
        rewritten += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (rewritten === 0) return { text, missing };

  const { statement, kept, keptTypes } = eventImport;
  const onlyTypes = kept.length > 0 && keptTypes.every((name) => name !== null);
  const helper = `import { listenScoped } from "${HELPER_IMPORT}";`;
  const original = statement.getText(source);
  edits.push({
    at: statement.getStart(source),
    end: statement.getEnd(),
    text:
      kept.length === 0
        ? helper
        : onlyTypes
          ? `import type { ${keptTypes.join(", ")} } from "${EVENT_MODULE}";\n${helper}`
          : `${original.replace(/\{[^}]*\}/s, `{ ${kept.join(", ")} }`)}\n${helper}`,
  });
  // The inserted comma goes after the first argument; applying from the end keeps offsets valid.
  edits.sort((a, b) => b.at - a.at || b.end - a.end);
  let out = text;
  for (const edit of edits) out = out.slice(0, edit.at) + edit.text + out.slice(edit.end);
  return { text: out, missing };
}

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules" && name !== "__test-utils__") sourceFiles(path, out);
    } else if (
      /\.tsx?$/.test(name) &&
      !/\.(test|spec)\.tsx?$/.test(name) &&
      !name.endsWith(".d.ts")
    ) {
      out.push(path);
    }
  }
  return out;
}

export function run(root, { check = false } = {}) {
  const src = join(root, "src");
  const rows = readInventory(readFileSync(join(src, INVENTORY_FILE), "utf8"));
  const changed = [];
  const missing = [];
  for (const path of sourceFiles(src)) {
    const file = relative(src, path).split(sep).join("/");
    if (file === HELPER_FILE || file.startsWith("app/mock/")) continue;
    const before = readFileSync(path, "utf8");
    const result = rewrite(file, before, rows);
    missing.push(...result.missing);
    if (result.text !== before) {
      changed.push(file);
      if (!check) writeFileSync(path, result.text);
    }
  }
  return { changed, missing };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootAt = args.indexOf("--root");
  const root = resolve(rootAt >= 0 ? args[rootAt + 1] : process.cwd());
  const { changed, missing } = run(root, { check: args.includes("--check") });
  for (const file of changed)
    console.log(`${args.includes("--check") ? "would change" : "changed"} ${file}`);
  for (const line of missing) console.error(line);
  console.log(
    `${changed.length} file(s)${missing.length ? `, ${missing.length} call(s) with no row` : ""}`,
  );
  process.exit(missing.length || (args.includes("--check") && changed.length) ? 1 : 0);
}
