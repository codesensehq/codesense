// SPDX-License-Identifier: MIT
/**
 * Group files belong to the Rust group store (`src-tauri/src/groups/store.rs`), the one writer
 * of `config/groups/<id>.json`. Two guards keep it that way on the TS side:
 *
 * - no TS code writes a path under `groups/`: no file write, `fs` call or Tauri fs call whose
 *   arguments hold a `groups/` path;
 * - no new layout key enters `app-state.json`: the keys the viewer prefs persist and the keys
 *   the Rust side writes under `viewer` that hold a layout (a tree, splits, sizes or groups) are
 *   the ones listed here, kept until their layouts move to group files.
 */
import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");

/** The calls that write, create, move or remove a file. */
const WRITERS = new Set([
  "writeTextFile",
  "writeFile",
  "writeFileSync",
  "writeBinaryFile",
  "appendFile",
  "appendFileSync",
  "mkdir",
  "mkdirSync",
  "create",
  "rename",
  "renameSync",
  "copyFile",
  "copyFileSync",
  "remove",
  "rm",
  "rmSync",
  "unlink",
  "unlinkSync",
  "truncate",
  "open",
]);

/** The modules whose every call touches the file system. */
const FS_OBJECTS = new Set(["fs", "fsp", "fsPromises", "tauriFs"]);

const GROUP_PATH = /(^|[/\\])groups[/\\]|config\/groups/;

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Whether a node holds a string or template part naming a path under `groups/`. */
function holdsGroupPath(node: ts.Node): boolean {
  if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) {
    if (GROUP_PATH.test(node.text)) return true;
  }
  if (ts.isTemplateTail(node) && GROUP_PATH.test(node.text)) return true;
  return ts.forEachChild(node, (child) => (holdsGroupPath(child) ? true : undefined)) ?? false;
}

/** The writes in `text` whose arguments name a path under `groups/`, as `line: call`. */
function groupWrites(file: string, text: string): string[] {
  const source = parse(file, text);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      const onFs =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        FS_OBJECTS.has(callee.expression.text);
      if (name && (WRITERS.has(name) || onFs) && node.arguments.some(holdsGroupPath)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push(`${line + 1}: ${node.getText().slice(0, 80)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "__tests__") sources(path, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec|stories)\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/** The layout keys `app-state.json` holds today, each until its layout moves to group files. */
const LAYOUT_KEYS = [
  "customGroupsByTeam",
  "foregroundLayout",
  "foregroundLayoutByRail",
  "rightPaneLayout",
  "rightPaneRatio",
  "rightPaneSplitRatio",
  "terminalTabGridSizes",
  "terminalViewerFocus",
  "terminalViewerGrid",
  "trayBaseOrderByTeam",
  "workspaceGroupVersionsByTeam",
  "workspaceOrderByTeam",
];

/** A key that names a layout: a tree, a split, sizes, a grid, an order or a group. */
const LAYOUT_WORD = /layout|group|split|ratio|size|grid|tree|arrangement|mosaic|tile|order/i;

/** The top-level keys of the object `serializedViewerPrefs` returns. */
function persistedViewerKeys(text: string): string[] {
  const source = parse("viewer-store.ts", text);
  const keys: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "serializedViewerPrefs") {
      const returned = (n: ts.Node) => {
        if (ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(n.expression)) {
          for (const property of n.expression.properties) {
            if (
              property.name &&
              (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
            ) {
              keys.push(property.name.text);
            }
          }
        }
        if (!ts.isFunctionLike(n) || n === node) ts.forEachChild(n, returned);
      };
      returned(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return keys;
}

/** The keys Rust code writes under `viewer` in `app-state.json` (`["viewer"]["key"] = …`). */
function rustViewerWrites(text: string): string[] {
  return [...text.matchAll(/\["viewer"\]\s*\[\s*"([A-Za-z0-9_]+)"\s*\]\s*=[^=]/g)].map((m) => m[1]);
}

function rustSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "target" && entry.name !== "tests") rustSources(path, out);
    } else if (entry.name.endsWith(".rs") && !entry.name.endsWith("_tests.rs")) {
      out.push(path);
    }
  }
  return out;
}

/** Rust source with its `#[cfg(test)]` modules cut (a test may write any key). */
function withoutTests(text: string): string {
  const at = text.search(/#\[cfg\(test\)\]\s*(pub(\([^)]*\))?\s+)?mod\s+\w+\s*\{/);
  return at === -1 ? text : text.slice(0, at);
}

function rustKeys(): string[] {
  return rustSources(join(ROOT, "src-tauri/src")).flatMap((file) =>
    rustViewerWrites(withoutTests(readFileSync(file, "utf8"))),
  );
}

function newLayoutKeys(keys: string[]): string[] {
  return [...new Set(keys)].filter((k) => LAYOUT_WORD.test(k) && !LAYOUT_KEYS.includes(k)).sort();
}

describe("group files", () => {
  it("no TS code writes a path under groups/", () => {
    const found = sources(join(ROOT, "src")).flatMap((file) =>
      groupWrites(file, readFileSync(file, "utf8")).map((w) => `${relative(ROOT, file)}:${w}`),
    );
    expect(found, "group files are written by the Rust group store only").toEqual([]);
  });

  it("catches planted writes", () => {
    const planted = [
      `writeTextFile("orgs/a/b/config/groups/main.json", "{}");`,
      "await writeFile(`${root}/config/groups/${id}.json`, text);",
      `fs.writeFileSync(join(dir, "groups/x.json"), "");`,
      `await remove(\`\${dir}/groups/\${id}.json\`);`,
      `fs.rmSync(path.join(base, "config/groups"), { recursive: true });`,
    ];
    for (const text of planted) expect(groupWrites("p.ts", text), text).not.toEqual([]);
    const fine = [
      `writeTextFile("workspace-groups.json", "{}");`,
      `const label = "groups/";`,
      `readTextFile("config/groups/main.json");`,
      `writeFile(path, "{}"); // config/groups/`,
    ];
    for (const text of fine) expect(groupWrites("p.ts", text), text).toEqual([]);
  });
});

describe("app-state.json layout keys", () => {
  it("the viewer prefs persist no new layout key", () => {
    const text = readFileSync(join(ROOT, "src/shared/stores/viewer-store.ts"), "utf8");
    const keys = persistedViewerKeys(text);
    expect(keys.length, "serializedViewerPrefs was found and read").toBeGreaterThan(10);
    expect(
      newLayoutKeys(keys),
      "a layout is saved through the group store, not app-state.json",
    ).toEqual([]);
  });

  it("the Rust side writes no new layout key under viewer", () => {
    expect(rustKeys(), "the group save still writes its keys").toContain("customGroupsByTeam");
    expect(newLayoutKeys(rustKeys()), "a layout is saved through the group store").toEqual([]);
  });

  it("every listed key is still persisted, so a moved one leaves the list", () => {
    const text = readFileSync(join(ROOT, "src/shared/stores/viewer-store.ts"), "utf8");
    const persisted = new Set([...persistedViewerKeys(text), ...rustKeys()]);
    expect(LAYOUT_KEYS.filter((k) => !persisted.has(k))).toEqual([]);
  });

  it("catches a planted layout key", () => {
    const ts = `function serializedViewerPrefs(s) { const x = () => ({ inner: 1 }); return { foregroundLayout: 1, tileGroupTree: 2, theme: 3 }; }`;
    expect(persistedViewerKeys(ts)).toEqual(["foregroundLayout", "tileGroupTree", "theme"]);
    expect(newLayoutKeys(persistedViewerKeys(ts))).toEqual(["tileGroupTree"]);
    const rust = `app_state["viewer"]["savedSplitSizes"] = json!(1); if a["viewer"]["x"] == b {}`;
    expect(rustViewerWrites(rust)).toEqual(["savedSplitSizes"]);
    expect(newLayoutKeys(rustViewerWrites(rust))).toEqual(["savedSplitSizes"]);
  });
});
