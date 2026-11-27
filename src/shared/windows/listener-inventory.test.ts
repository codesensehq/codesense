// SPDX-License-Identifier: MIT
/**
 * Every global Tauri listener goes through `listenScoped` with a row in
 * `listener-inventory.ts`. The scan reads imports and calls with the TypeScript
 * parser, not a regex, so an aliased or namespace import, a multi-line generic
 * call and a `listen` handed along by reference are all seen, and comments and
 * `.listen(` methods are not.
 *
 * Scope: every non-test `.ts`/`.tsx` file under `src/`, except `__test-utils__/`
 * and `src/app/mock/`.
 */
import { readFileSync } from "fs";
import { join, relative, resolve, sep } from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { sourceFiles } from "@/shared/lib/__test-utils__/copy-strings";

import { LISTENER_INVENTORY, type ListenerRow } from "./listener-inventory";

const SRC = resolve(__dirname, "../..");
const EVENT_MODULE = "@tauri-apps/api/event";
const HELPER = "shared/windows/listen-scoped.ts";

interface Site {
  file: string;
  event: string;
  scope: string | null;
  line: number;
}

interface Scan {
  sites: Site[];
  violations: string[];
}

/** The row key of a call's event argument: a literal, a constant, or `{…}` when built at run time. */
function eventKey(arg: ts.Expression | undefined, source: ts.SourceFile): string {
  if (!arg) return "{}";
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) {
    return `{${arg.head.text}${arg.templateSpans.map((span) => `*${span.literal.text}`).join("")}}`;
  }
  const text = arg.getText(source);
  return /^[A-Z][A-Z0-9_]*$/.test(text) ? text : `{${text}}`;
}

function isCallee(node: ts.Identifier): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

/** The listener sites in one file, and what breaks the rules. `file` is relative to `src/`. */
function scanFile(file: string, text: string): Scan {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const at = (node: ts.Node) =>
    `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const sites: Site[] = [];
  const violations: string[] = [];
  const isHelper = file === HELPER;
  const rawListen = new Set<string>();

  for (const statement of source.statements) {
    const fromEvent =
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === EVENT_MODULE;
    if (!fromEvent) continue;
    if (ts.isExportDeclaration(statement)) {
      if (!statement.isTypeOnly) violations.push(`${at(statement)}: re-exports ${EVENT_MODULE}`);
      continue;
    }
    const clause = (statement as ts.ImportDeclaration).importClause;
    if (!clause || clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      violations.push(`${at(statement)}: namespace import of ${EVENT_MODULE}`);
    } else if (bindings) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly || (element.propertyName ?? element.name).text !== "listen")
          continue;
        if (isHelper) rawListen.add(element.name.text);
        else violations.push(`${at(element)}: imports listen from ${EVENT_MODULE}`);
      }
    }
  }

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      ts.isStringLiteral(node.arguments[0] ?? node) &&
      (node.arguments[0] as ts.StringLiteral).text === EVENT_MODULE
    ) {
      violations.push(`${at(node)}: dynamic import of ${EVENT_MODULE}`);
    }
    if (ts.isIdentifier(node) && rawListen.has(node.text) && !ts.isImportSpecifier(node.parent)) {
      if (!isCallee(node)) violations.push(`${at(node)}: listen passed by reference`);
    }
    if (ts.isIdentifier(node) && node.text === "listenScoped") {
      const parent = node.parent;
      const declared = isHelper && ts.isFunctionDeclaration(parent) && parent.name === node;
      if (isCallee(node)) {
        const call = parent as ts.CallExpression;
        const scope = call.arguments[1];
        sites.push({
          file,
          event: eventKey(call.arguments[0], source),
          scope: scope && ts.isStringLiteral(scope) ? scope.text : null,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        });
      } else if (!ts.isImportSpecifier(parent) && !declared) {
        violations.push(`${at(node)}: listenScoped passed by reference`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { sites, violations };
}

/** Each site against its `{file, event}` row, then each row against the sites. */
function checkInventory(sites: Site[], rows: readonly ListenerRow[]): string[] {
  const keyOf = (file: string, event: string) => `${file} ${event}`;
  const byKey = new Map(rows.map((row) => [keyOf(row.file, row.event), row]));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const site of sites) {
    const key = keyOf(site.file, site.event);
    const row = byKey.get(key);
    seen.add(key);
    if (!row) problems.push(`${site.file}:${site.line}: ${site.event} has no inventory row`);
    else if (site.scope !== row.scope) {
      problems.push(
        `${site.file}:${site.line}: ${site.event} is registered ${site.scope ?? "with a computed scope"}, its row says ${row.scope}`,
      );
    }
  }
  for (const row of rows) {
    if (!seen.has(keyOf(row.file, row.event))) {
      problems.push(`${row.file}: ${row.event} has a row but no listenScoped call`);
    }
  }
  return problems;
}

function scanSrc(): Scan {
  const files = sourceFiles(SRC)
    .map((path) => relative(SRC, path).split(sep).join("/"))
    .filter((file) => !file.split("/").includes("__test-utils__") && !file.startsWith("app/mock/"));
  const scans = files.map((file) => scanFile(file, readFileSync(join(SRC, file), "utf8")));
  return {
    sites: scans.flatMap((scan) => scan.sites),
    violations: scans.flatMap((scan) => scan.violations),
  };
}

describe("every global listener registers through listenScoped with an inventory row", () => {
  const scan = scanSrc();

  it("no file outside listen-scoped.ts imports listen from @tauri-apps/api/event", () => {
    expect(scan.violations).toEqual([]);
  });

  it("every listenScoped call has a row with its scope, and every row has a call", () => {
    expect(checkInventory(scan.sites, LISTENER_INVENTORY)).toEqual([]);
  });

  it("holds one row per site", () => {
    const keys = LISTENER_INVENTORY.map((row) => `${row.file} ${row.event}`);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it("classes the rows the story names", () => {
    const scopeOf = (file: string, event: string) =>
      LISTENER_INVENTORY.find((row) => row.file === file && row.event === event)?.scope;
    expect(
      scopeOf("shared/lib/context-query/subscribe-context.ts", "CONTEXT_INDEX_CHANGED_EVENT"),
    ).toBe("every-window");
    expect(scopeOf("app/App.tsx", "CONTEXT_FILE_CHANGE_EVENT")).toBe("main-only");
    expect(scopeOf("app/App.tsx", "app:quit-flush")).toBe("main-only");
    expect(scopeOf("features/dashboard/lib/live-hub.ts", "{event}")).toBe("every-window");
    expect(scopeOf("shared/hooks/use-mcp-actions.ts", "mcp:set-viewer-state")).toBe("main-only");
    expect(
      scopeOf("features/shell/right-pane/panes/use-register-pane-panels.ts", "PANE_OPEN_EVENT"),
    ).toBe("main-only");
    expect(scopeOf("shared/hooks/use-terminal-activity.ts", "TERMINAL_LAYOUT_RESYNC_EVENT")).toBe(
      "every-window",
    );
    expect(
      scopeOf("features/org/hooks/use-org-registry-sync.ts", "ORG_REGISTRY_CHANGED_EVENT"),
    ).toBe("every-window");
    expect(scopeOf("shared/terminal/terminal-manager.ts", "{channel}")).toBe("owning-window");
  });

  describe("seeded fixtures", () => {
    it("fails a raw import of listen", () => {
      const planted = 'import { listen } from "@tauri-apps/api/event";\nlisten("x", () => {});\n';
      expect(scanFile("planted.ts", planted).violations).toEqual([
        "planted.ts:1: imports listen from @tauri-apps/api/event",
      ]);
    });

    it("fails an aliased, a namespace and a dynamic import", () => {
      const planted = [
        'import { emit, listen as on, type UnlistenFn } from "@tauri-apps/api/event";',
        'import * as events from "@tauri-apps/api/event";',
        'const late = import("@tauri-apps/api/event");',
      ].join("\n");
      expect(scanFile("planted.ts", planted).violations).toEqual([
        "planted.ts:1: imports listen from @tauri-apps/api/event",
        "planted.ts:2: namespace import of @tauri-apps/api/event",
        "planted.ts:3: dynamic import of @tauri-apps/api/event",
      ]);
    });

    it("fails a multi-line generic call with no row, and one whose scope differs", () => {
      const planted = [
        'import { listenScoped } from "@/shared/windows/listen-scoped";',
        "listenScoped<{",
        "  teamKey: string;",
        '}>("planted:event", "every-window", () => {});',
        'listenScoped(PLANTED_EVENT, "main-only", () => {});',
      ].join("\n");
      const { sites, violations } = scanFile("planted.ts", planted);
      expect(violations).toEqual([]);
      const rows: ListenerRow[] = [
        { file: "planted.ts", event: "PLANTED_EVENT", scope: "every-window", why: "" },
        { file: "planted.ts", event: "GONE_EVENT", scope: "every-window", why: "" },
      ];
      expect(checkInventory(sites, rows)).toEqual([
        "planted.ts:2: planted:event has no inventory row",
        "planted.ts:5: PLANTED_EVENT is registered main-only, its row says every-window",
        "planted.ts: GONE_EVENT has a row but no listenScoped call",
      ]);
    });

    it("fails listenScoped passed by reference, and keys run-time names", () => {
      const planted = [
        'import { listenScoped } from "@/shared/windows/listen-scoped";',
        "const deps = { listen: listenScoped };",
        'listenScoped(`run-${id}`, "every-window", () => {});',
        'listenScoped(name, "every-window", () => {});',
        "// listen(CONTEXT_FILE_CHANGE_EVENT) in a comment is not a call",
        'manager.listen("x", () => {});',
      ].join("\n");
      const { sites, violations } = scanFile("planted.ts", planted);
      expect(violations).toEqual(["planted.ts:2: listenScoped passed by reference"]);
      expect(sites.map((site) => site.event)).toEqual(["{run-*}", "{name}"]);
    });

    it("allows type-only imports and emit", () => {
      const planted = [
        'import type { UnlistenFn } from "@tauri-apps/api/event";',
        'import { emit, type Event } from "@tauri-apps/api/event";',
      ].join("\n");
      expect(scanFile("planted.ts", planted).violations).toEqual([]);
    });
  });
});
