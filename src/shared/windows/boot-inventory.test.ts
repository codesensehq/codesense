// SPDX-License-Identifier: MIT
/**
 * `boot-inventory.ts` and `App.tsx` stay in step: every hook `App` calls, every
 * inline `useEffect` (by its `// boot: <id>` marker) and every module-scope
 * statement is a row, and every row is still there. The scan reads `App.tsx` with
 * the TypeScript parser. A satellite mounts exactly the `run` and `read-only` rows,
 * and nothing `satellite-root.tsx` imports reaches `App.tsx` or a `skip` row.
 */
import { render } from "@testing-library/react";
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, relative, resolve, sep } from "path";
import { createElement } from "react";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BOOT_EXPORTS, BOOT_ROWS, SATELLITE_ROWS, type BootRow } from "./boot-inventory";

const SRC = resolve(__dirname, "../..");
const APP = resolve(SRC, "app/App.tsx");
const SATELLITE_ROOT = resolve(SRC, "shared/windows/satellite-root.tsx");

const REACT_HOOKS = new Set([
  "useCallback",
  "useContext",
  "useDeferredValue",
  "useEffect",
  "useId",
  "useLayoutEffect",
  "useMemo",
  "useReducer",
  "useRef",
  "useState",
  "useSyncExternalStore",
  "useTransition",
]);
const STORE_SELECTOR = /^use\w*Store$/;
const MARKER = /^\/\/ boot: ([\w-]+)\s*$/;

interface Scan {
  hooks: string[];
  effects: string[];
  unmarked: number[];
  modules: string[];
  unknownModules: string[];
}

const parse = (file: string, text: string) =>
  ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

/** The hooks called in `node`, outside any nested function (a selector's arrow). */
function hookCalls(node: ts.Node, into: string[]): void {
  if (ts.isFunctionLike(node)) return;
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const name = node.expression.text;
    if (/^use[A-Z]/.test(name) && !REACT_HOOKS.has(name) && !STORE_SELECTOR.test(name))
      into.push(name);
  }
  ts.forEachChild(node, (child) => hookCalls(child, into));
}

function isUseEffect(statement: ts.Statement): boolean {
  return (
    ts.isExpressionStatement(statement) &&
    ts.isCallExpression(statement.expression) &&
    ts.isIdentifier(statement.expression.expression) &&
    statement.expression.expression.text === "useEffect"
  );
}

function scanApp(text: string): Scan {
  const source = parse("App.tsx", text);
  const scan: Scan = { hooks: [], effects: [], unmarked: [], modules: [], unknownModules: [] };
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === "App") {
      for (const inner of statement.body?.statements ?? []) {
        if (isUseEffect(inner)) {
          const comments = ts.getLeadingCommentRanges(text, inner.getFullStart()) ?? [];
          const marker = comments
            .map((range) => MARKER.exec(text.slice(range.pos, range.end))?.[1])
            .find((id) => id !== undefined);
          if (marker) scan.effects.push(marker);
          else scan.unmarked.push(source.getLineAndCharacterOfPosition(inner.getStart()).line + 1);
        } else if (!ts.isReturnStatement(inner) && !ts.isIfStatement(inner)) {
          hookCalls(inner, scan.hooks);
        }
      }
      continue;
    }
    if (ts.isImportDeclaration(statement)) {
      if (!statement.importClause && ts.isStringLiteral(statement.moduleSpecifier)) {
        scan.modules.push(statement.moduleSpecifier.text.split("/").pop()!);
      }
      continue;
    }
    if (ts.isExpressionStatement(statement)) {
      const call = statement.expression;
      if (ts.isCallExpression(call) && ts.isIdentifier(call.expression))
        scan.modules.push(call.expression.text);
      else scan.unknownModules.push(statement.getText(source));
      continue;
    }
    if (ts.isIfStatement(statement)) {
      if (/import\.meta\.env\.MODE === "webdriver"/.test(statement.expression.getText(source)))
        scan.modules.push("webdriver-e2e-controls");
      else scan.unknownModules.push(statement.expression.getText(source));
    }
  }
  return scan;
}

/** What is wrong between `App.tsx`'s text and `rows`: empty when they agree. */
function inventoryProblems(text: string, rows: readonly BootRow[]): string[] {
  const scan = scanApp(text);
  const problems: string[] = [];
  const byKind = (kind: BootRow["kind"]) =>
    new Set(rows.filter((r) => r.kind === kind).map((r) => r.id));
  const check = (kind: BootRow["kind"], found: string[]) => {
    const known = byKind(kind);
    for (const id of found) if (!known.has(id)) problems.push(`unclassified ${kind}: ${id}`);
    for (const id of known) if (!found.includes(id)) problems.push(`stale ${kind} row: ${id}`);
  };
  check("hook", scan.hooks);
  check("effect", scan.effects);
  check("module", scan.modules);
  for (const line of scan.unmarked) problems.push(`unmarked useEffect at App.tsx:${line}`);
  for (const text of scan.unknownModules) problems.push(`module statement with no row: ${text}`);
  const ids = rows.map((r) => r.id);
  for (const id of new Set(ids))
    if (ids.indexOf(id) !== ids.lastIndexOf(id)) problems.push(`duplicate row: ${id}`);
  return problems;
}

const appText = () => readFileSync(APP, "utf8");
const row = (id: string) => BOOT_ROWS.find((r) => r.id === id);

describe("the boot inventory", () => {
  it("classifies every initializer in App.tsx, and every row is still there", () => {
    expect(inventoryProblems(appText(), BOOT_ROWS)).toEqual([]);
  });

  it("fails on an unclassified hook", () => {
    const seeded = appText().replace(
      "  useMcpActions();",
      "  useMcpActions();\n  useBrandNewThing();",
    );
    expect(inventoryProblems(seeded, BOOT_ROWS)).toEqual(["unclassified hook: useBrandNewThing"]);
  });

  it("fails on a stale row", () => {
    const rows = [...BOOT_ROWS, { id: "useGone", kind: "hook", class: "skip", why: "-" } as const];
    expect(inventoryProblems(appText(), rows)).toEqual(["stale hook row: useGone"]);
  });

  it("fails on an unmarked inline useEffect", () => {
    const seeded = appText().replace(
      "  useMcpActions();",
      "  useMcpActions();\n  useEffect(() => {}, []);",
    );
    expect(inventoryProblems(seeded, BOOT_ROWS)).toEqual([
      expect.stringMatching(/^unmarked useEffect at App\.tsx:\d+$/),
    ]);
  });

  it("fails on a marker with no row", () => {
    const seeded = appText().replace("// boot: external-links", "// boot: no-such-row");
    expect(inventoryProblems(seeded, BOOT_ROWS)).toEqual([
      "unclassified effect: no-such-row",
      "stale effect row: external-links",
    ]);
  });

  it("fails on a module-level registration with no row", () => {
    const seeded = appText().replace(
      "registerVirtualTabs();",
      "registerVirtualTabs();\nregisterNewTab();",
    );
    expect(inventoryProblems(seeded, BOOT_ROWS)).toEqual(["unclassified module: registerNewTab"]);
  });

  it("gives every run and read-only row a shared export, and no skip row one", () => {
    const shared = BOOT_ROWS.filter((r) => r.class !== "skip").map((r) => r.id);
    expect(Object.keys(BOOT_EXPORTS).sort()).toEqual([...shared].sort());
    for (const id of shared) expect(typeof BOOT_EXPORTS[id], id).toBe("function");
  });

  it("lists the run and read-only rows as SATELLITE_ROWS, in App's order", () => {
    expect(SATELLITE_ROWS).toEqual(BOOT_ROWS.filter((r) => r.class !== "skip"));
    expect(Object.isFrozen(SATELLITE_ROWS)).toBe(true);
  });

  it("classifies the rows the boot depends on", () => {
    expect(row("useBootLoad")?.class).toBe("read-only");
    expect(appText()).toMatch(/useBootLoad\(\);/);
    expect(readFileSync(resolve(SRC, "shared/windows/boot-inventory.ts"), "utf8")).toMatch(
      /loadPlatformCaps\(\)/,
    );
    expect(row("usePrefsLive")?.class).toBe("read-only");
    for (const id of [
      "useTerminalLayoutRestore",
      "useTerminalStatusEvents",
      "useTerminalDisplayGc",
      "useTerminalDisplayWarm",
      "useMarkActiveSessionSeen",
      "registerVirtualTabs",
    ])
      expect(row(id)?.class, id).toBe("run");
    for (const id of [
      "useBackgroundModeNotification",
      "useWindowTitle",
      "useWorkspaceViewerSync",
      "useWarmPool",
      "useManagedSessionBridge",
      "useBackgroundSetupCap",
      "useBackgroundAgentLimit",
      "useQuitOnCloseSetting",
      "useTerminalServerMenuBarSetting",
      "useNeedsYouNotifications",
      "useAttentionAlerts",
      "useMoveWorkspaceSync",
      "useSourceRepoAttachment",
      "update-check",
      "viewer-restore",
      "close-flush",
      "boot-gate-watchdog",
      "webdriver-e2e-controls",
    ])
      expect(row(id)?.class, id).toBe("skip");
  });
});

describe("what satellite-root.tsx mounts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls exactly the SATELLITE_ROWS exports, hooks in order, the module rows once at import", async () => {
    const calls: string[] = [];
    for (const id of Object.keys(BOOT_EXPORTS)) {
      vi.spyOn(BOOT_EXPORTS, id).mockImplementation(() => {
        calls.push(id);
      });
    }
    const { SatelliteRoot } = await import("./satellite-root");
    const modules = SATELLITE_ROWS.filter((r) => r.kind === "module").map((r) => r.id);
    expect(calls).toEqual(modules);
    calls.length = 0;
    render(createElement(SatelliteRoot, { renderer: () => null }));
    expect(calls).toEqual(SATELLITE_ROWS.filter((r) => r.kind === "hook").map((r) => r.id));
  }, 60_000);
});

// --- the import graph -------------------------------------------------------

const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = resolve(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
  else return null;
  for (const extension of EXTENSIONS) {
    const path = base + extension;
    if (existsSync(path) && statSync(path).isFile() && /\.tsx?$/.test(path)) return path;
  }
  return null;
}

interface Import {
  path: string;
  names: string[];
}

/** A file's static, non-type imports and re-exports, with the names each takes. */
function importsOf(file: string): Import[] {
  const source = parse(file, readFileSync(file, "utf8"));
  const out: Import[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const names: string[] = [];
      if (clause?.name) names.push("default");
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.push("*");
      if (bindings && ts.isNamedImports(bindings))
        for (const e of bindings.elements)
          if (!e.isTypeOnly) names.push((e.propertyName ?? e.name).text);
      const path = resolveImport(file, statement.moduleSpecifier.text);
      if (path) out.push({ path, names });
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly || !statement.moduleSpecifier) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const clause = statement.exportClause;
      const names =
        clause && ts.isNamedExports(clause)
          ? clause.elements.map((e) => (e.propertyName ?? e.name).text)
          : ["*"];
      const path = resolveImport(file, statement.moduleSpecifier.text);
      if (path) out.push({ path, names });
    }
  }
  return out;
}

/** Where App.tsx imports each name from. */
function appImports(): Map<string, string> {
  const where = new Map<string, string>();
  for (const { path, names } of importsOf(APP)) for (const name of names) where.set(name, path);
  return where;
}

/** The functions a skip effect starts, which a satellite must not import. */
const SKIP_EFFECT_ENTRIES: Record<string, string[]> = {
  "machine-memory": ["startMachineMemory"],
  "update-check": ["startUpdateCheck"],
  "navigation-capture": ["installUserNavigationCapture"],
  "close-flush": ["flushBeforeQuit"],
  "quit-flush": ["flushBeforeQuit"],
  watcher: ["registerWorkspaceWatchBridge"],
};

/** Every chain from `root` to a forbidden import: App.tsx, or a skip row's export. */
function forbiddenChains(
  root: string,
  forbidden: { path: string; name: string }[],
  read: (file: string) => Import[] = importsOf,
): string[] {
  const parent = new Map<string, string>();
  const seen = new Set([root]);
  const queue = [root];
  const chains: string[] = [];
  const chain = (file: string) => {
    const files = [file];
    for (let at = file; parent.has(at); ) files.push((at = parent.get(at)!));
    return files
      .reverse()
      .map((f) => relative(SRC, f).split(sep).join("/"))
      .join(" -> ");
  };
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const { path, names } of read(file)) {
      if (path === APP) chains.push(`App.tsx <- ${chain(file)}`);
      for (const bad of forbidden)
        if (bad.path === path && (names.includes(bad.name) || names.includes("*")))
          chains.push(`${bad.name} <- ${chain(file)}`);
      if (!seen.has(path)) {
        seen.add(path);
        parent.set(path, file);
        queue.push(path);
      }
    }
  }
  return chains;
}

function skipExports(): { path: string; name: string }[] {
  const where = appImports();
  const names = BOOT_ROWS.filter((r) => r.class === "skip").flatMap((r) =>
    r.kind === "hook" ? [r.id] : (SKIP_EFFECT_ENTRIES[r.id] ?? []),
  );
  return names.flatMap((name) => {
    const path = where.get(name);
    return path ? [{ path, name }] : [];
  });
}

describe("what satellite-root.tsx imports", () => {
  it("reaches neither App.tsx nor any skip row's export", () => {
    const forbidden = skipExports();
    // Every skip hook row resolves to the module App imports it from.
    const hookRows = BOOT_ROWS.filter((r) => r.class === "skip" && r.kind === "hook");
    expect(forbidden.filter((f) => hookRows.some((r) => r.id === f.name))).toHaveLength(
      hookRows.length,
    );
    expect(forbiddenChains(SATELLITE_ROOT, forbidden)).toEqual([]);
  }, 60_000);

  it("fails on a planted import of a skip row's export or of App.tsx", () => {
    const where = appImports();
    const root = resolve(SRC, "shared/windows/planted-root.ts");
    const middle = resolve(SRC, "shared/windows/planted-middle.ts");
    const graph = new Map<string, Import[]>([
      [root, [{ path: middle, names: ["x"] }]],
      [
        middle,
        [
          { path: where.get("useWindowTitle")!, names: ["useWindowTitle"] },
          { path: APP, names: ["default"] },
        ],
      ],
    ]);
    expect(forbiddenChains(root, skipExports(), (file) => graph.get(file) ?? [])).toEqual([
      "useWindowTitle <- shared/windows/planted-root.ts -> shared/windows/planted-middle.ts",
      "App.tsx <- shared/windows/planted-root.ts -> shared/windows/planted-middle.ts",
    ]);
  });
});
