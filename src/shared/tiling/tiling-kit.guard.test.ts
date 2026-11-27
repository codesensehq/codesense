// SPDX-License-Identifier: MIT
/**
 * The tiling kit is the one place the tree, the drag zones and their geometry are defined, and it
 * stays free of features and stores so any window, team or tile kind can use it. These
 * source-level guards fail if a second definition appears or the kit reaches out.
 */
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = resolve(__dirname, "../..");
const KIT = "shared/tiling/";

/** Every .ts/.tsx file under src/, as src-relative paths. */
function sourceFiles(dir: string = src): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [relative(src, full).split("\\").join("/")] : [];
  });
}

const isTest = (file: string) => /\.(test|spec)\.tsx?$|\.test-util\.tsx?$/.test(file);
const files = sourceFiles();
const read = (file: string) => readFileSync(resolve(src, file), "utf8");
const kitFiles = files.filter((f) => f.startsWith(KIT) && !isTest(f));

describe("tiling kit guard", () => {
  it("has kit sources to guard", () => {
    expect(kitFiles).toContain("shared/tiling/index.ts");
  });

  it.each(["MosaicNode", "EDGE_BANDS", "resolveZoneAt", "TileDropSide"])(
    "defines %s only in the kit",
    (name) => {
      // A declaration, not a name in an import or export list.
      const definition = new RegExp(
        `^\\s*(?:export\\s+)?(?:declare\\s+)?(?:type\\s+${name}\\s*[=<]|(?:interface|class|enum)\\s+${name}\\b|(?:const|let|var)\\s+${name}\\s*[:=]|function\\s+${name}\\s*[<(])`,
        "m",
      );
      const outside = files.filter((f) => !f.startsWith(KIT) && definition.test(read(f)));
      expect(outside).toEqual([]);
    },
  );

  it("draws the drop bands from EDGE_BANDS: no file outside the kit hard-codes a band fraction", () => {
    const offenders = files.filter((f) => {
      if (f.startsWith(KIT) || isTest(f)) return false;
      const text = read(f);
      // The top/bottom bands' shape as classes, or any fraction beside a drop band.
      if (/left-1\/4\s+right-1\/4/.test(text)) return true;
      return (
        text.includes("data-drop-side") && /\b[whxy]-1\/4\b|\b0?\.(25|75)\b|\b(25|75)%/.test(text)
      );
    });
    expect(offenders).toEqual([]);
  });

  it("imports nothing from features or stores", () => {
    const offenders = kitFiles.filter((f) =>
      /from\s+["'](?:@\/features\/|@\/shared\/stores\/|\.\.\/\.\.\/features\/|\.\.\/stores\/)/.test(
        read(f),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("never reads a team key", () => {
    const offenders = kitFiles.filter((f) => /\bteamKey\b|team-key/.test(read(f)));
    expect(offenders).toEqual([]);
  });
});
