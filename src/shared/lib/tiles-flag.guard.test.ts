// SPDX-License-Identifier: MIT
/**
 * The tiles release flag guards every tile path. Each file that writes a tile file or mounts
 * the tile host is listed in `tiles-flag-sites.json`, and each listed file must await
 * `tilesEnabled()` in code: a mention in a comment or a string doesn't count. With the flag off
 * the app is today's app and no tile code writes any file.
 *
 * The same list holds the Rust sites, one `{file, fn, what}` entry per gated function. This test
 * checks only their shape and never reads a `.rs` file; the cargo guard
 * `tiles_flag_sites_guard.rs` checks their code and that every gated Rust function is listed.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

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

/** The layout undo stack's entry points: only a flag-checked tile op may call them. */
const LAYOUT_UNDO_EXPORTS = ["recordLayoutChange", "undoLayoutChange", "redoLayoutChange"];

/** Whether the source names a layout undo export in code: a comment or a string doesn't count. */
function referencesLayoutUndo(file: string, text: string): boolean {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && LAYOUT_UNDO_EXPORTS.includes(node.text)) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The files outside the tiling kit that call the layout undo stack without being a listed site
 * that awaits `tilesEnabled()`. `files` maps src-relative paths (`src/...`) to their text.
 */
function unguardedLayoutUndoCallers(
  files: Record<string, string>,
  listed: ReadonlySet<string>,
): string[] {
  return Object.entries(files)
    .filter(([file]) => !file.startsWith("src/shared/tiling/") && !/\.test\.tsx?$/.test(file))
    .filter(([file, text]) => referencesLayoutUndo(file, text))
    .filter(([file, text]) => !listed.has(file) || !awaitsTilesEnabled(file, text))
    .map(([file]) => file);
}

/** Every non-test .ts/.tsx file under src/, by its `src/...` path. */
function sourceFiles(dir = join(ROOT, "src")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [relative(ROOT, full).split("\\").join("/")] : [];
  });
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
    const named = (entry as { file?: unknown }).file;
    if (typeof named === "string" && named.endsWith(".rs")) {
      problems.push(...rustSiteProblems(at, entry as Record<string, unknown>, keys, seen));
      return;
    }
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

/**
 * What is wrong with Rust entry `entry`: its shape only. Cargo checks its code, so the file is
 * never read here. `seen` holds the `file` + `fn` pairs listed so far.
 */
function rustSiteProblems(
  at: string,
  entry: Record<string, unknown>,
  keys: string[],
  seen: Set<string>,
): string[] {
  if (keys.join(",") !== "file,fn,what") {
    return [
      `${at}: a Rust entry must have exactly "file", "fn" and "what", has ${keys.join(", ")}`,
    ];
  }
  const { file, fn, what } = entry as { file: string; fn: unknown; what: unknown };
  const segments = file.split("/");
  const name = segments[segments.length - 1];
  const testFile =
    name.endsWith("_tests.rs") || name === "tests.rs" || segments.slice(0, -1).includes("tests");
  if (
    !/^src-tauri\/src\/.+\.rs$/.test(file) ||
    file.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    testFile
  ) {
    return [`${at}: "file" must be a non-test .rs path under src-tauri/src/`];
  }
  if (typeof fn !== "string" || fn.trim() === "") {
    return [`${at}: "fn" must name the gated function`];
  }
  if (typeof what !== "string" || what.trim() === "") {
    return [`${at}: "what" must say what the site writes or mounts`];
  }
  const key = `${file} ${fn}`;
  if (seen.has(key)) return [`${key}: listed twice`];
  seen.add(key);
  return [];
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

  it("checks a Rust entry's shape and never reads it", () => {
    const read = vi.fn(() => null);
    const good = { file: "src-tauri/src/groups/store.rs", fn: "GroupStore::commit", what: "x" };
    expect(
      siteProblems(
        [good, { file: "src-tauri/src/groups/store.rs", fn: "GroupStore::load", what: "x" }],
        read,
      ),
    ).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    const at = (file: string) => ({ file, fn: "f", what: "x" });
    expect(
      siteProblems(
        [
          { file: "src-tauri/src/a.rs", what: "x" },
          { file: "src-tauri/src/a.rs", fn: "", what: "x" },
          { file: "src-tauri/src/a.rs", fn: " ", what: "x" },
          { file: "src-tauri/src/a.rs", fn: "f", what: "x", extra: 1 },
          at("src-tauri/crates/x/src/a.rs"),
          at("src/a.rs"),
          at("src-tauri/src/../a.rs"),
          at("src-tauri/src/./a.rs"),
          at("src-tauri/src/a\\b.rs"),
          at("src-tauri/src/a_tests.rs"),
          at("src-tauri/src/groups/tests.rs"),
          at("src-tauri/src/tests/a.rs"),
          { file: "src-tauri/src/a.rs", fn: "f", what: "" },
          good,
          { file: "src/a.ts", fn: "f", what: "x" },
        ],
        read,
      ),
    ).toEqual([
      'entry 0: a Rust entry must have exactly "file", "fn" and "what", has file, what',
      'entry 1: "fn" must name the gated function',
      'entry 2: "fn" must name the gated function',
      'entry 3: a Rust entry must have exactly "file", "fn" and "what", has extra, file, fn, what',
      'entry 4: "file" must be a non-test .rs path under src-tauri/src/',
      'entry 5: "file" must be a non-test .rs path under src-tauri/src/',
      'entry 6: "file" must be a non-test .rs path under src-tauri/src/',
      'entry 7: "file" must be a non-test .rs path under src-tauri/src/',
      'entry 8: "file" must be a non-test .rs path under src-tauri/src/',
      'entry 9: "file" must be a non-test .rs path under src-tauri/src/',
      'entry 10: "file" must be a non-test .rs path under src-tauri/src/',
      'entry 11: "file" must be a non-test .rs path under src-tauri/src/',
      'entry 12: "what" must say what the site writes or mounts',
      'entry 14: must have exactly "file" and "what", has file, fn, what',
    ]);
    expect(read).not.toHaveBeenCalled();
    expect(siteProblems([good, good], read)).toEqual([
      "src-tauri/src/groups/store.rs GroupStore::commit: listed twice",
    ]);
  });
});

describe("the layout undo stack is called only from flag-checked tile ops", () => {
  it("no file outside the kit calls it unless listed and awaiting tilesEnabled()", () => {
    const list = JSON.parse(readFileSync(SITES, "utf8")) as { file: string }[];
    const files = Object.fromEntries(
      sourceFiles().map((file) => [file, readFileSync(join(ROOT, file), "utf8")]),
    );
    expect(unguardedLayoutUndoCallers(files, new Set(list.map((e) => e.file)))).toEqual([]);
  });

  it("fails an unlisted caller and a listed one that doesn't await the flag", () => {
    const files = {
      "src/features/viewer/ops/swap.ts": [
        'import { recordLayoutChange } from "@/shared/tiling";',
        "export function swap() { recordLayoutChange(a, b, by); }",
      ].join("\n"),
      "src/features/viewer/ops/undo-key.ts": [
        'import { undoLayoutChange } from "@/shared/tiling";',
        "export function run() { if (!tilesEnabled()) return; undoLayoutChange(now); }",
      ].join("\n"),
      "src/features/viewer/ops/redo-key.ts": [
        'import { redoLayoutChange } from "@/shared/tiling";',
        "export async function run() { if (!(await tilesEnabled())) return; redoLayoutChange(now); }",
      ].join("\n"),
      "src/features/viewer/ops/notes.ts": "// recordLayoutChange is called by the op itself\n",
      "src/shared/tiling/layout-undo.ts": "export function recordLayoutChange() {}",
      "src/features/viewer/ops/swap.test.ts": "recordLayoutChange(a, b, by);",
    };
    const listed = new Set([
      "src/features/viewer/ops/undo-key.ts",
      "src/features/viewer/ops/redo-key.ts",
    ]);
    expect(unguardedLayoutUndoCallers(files, listed)).toEqual([
      "src/features/viewer/ops/swap.ts",
      "src/features/viewer/ops/undo-key.ts",
    ]);
  });
});
