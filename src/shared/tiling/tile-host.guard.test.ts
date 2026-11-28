// SPDX-License-Identifier: MIT
/**
 * Source guards on the tile host's paths. A tile body mounts only through the host's one mount
 * site, keyed by its tile key; the host and its mount site never write the viewer's tabs; and
 * a body's frame document is set once.
 */
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = resolve(__dirname, "../..");
const MOUNT = "features/shell/components/tile-host-mount.tsx";
/** Mounts the host alone for the tile e2e specs, in `dev:mock` only. */
const HARNESS = "app/mock/tile-host-harness.tsx";
const HOST_FILES = ["shared/tiling/tile-host.tsx", "shared/tiling/tile-keep-alive.ts", MOUNT];

function sourceFiles(dir: string = src): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [relative(src, full).split("\\").join("/")] : [];
  });
}
const isTest = (file: string) => /\.(test|spec)\.tsx?$|\.test-util\.tsx?$/.test(file);
const read = (file: string) => readFileSync(resolve(src, file), "utf8");
/** The source with comments blanked, so a mention in prose is not code. */
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ");

describe("tile host guards", () => {
  it("the host is mounted only by its mount site (and the mock harness)", () => {
    const mounting = sourceFiles()
      .filter((file) => !isTest(file) && file !== "shared/tiling/tile-host.tsx")
      .filter((file) => /<TileHost\b/.test(code(file)));
    expect(mounting.sort()).toEqual([HARNESS, MOUNT].sort());
  });

  it("a body's React key is its tile key", () => {
    const host = code("shared/tiling/tile-host.tsx");
    expect(host).toMatch(/mounted\.map\(\(key\) => \(\s*<TileBody\s+key=\{key\}\s+tileKey=\{key\}/);
  });

  it.each(HOST_FILES)("%s never writes the viewer's tabs", (file) => {
    const text = code(file);
    expect(text).not.toMatch(/\bopenTabs\b|\bactiveTab\b/);
    // Reads go through the guarded store (`guardSatelliteItems`); nothing here writes it.
    expect(text).not.toMatch(/useViewerStore\.(setState|getState)\b/);
    expect(text).not.toMatch(/\b(openTab|closeTab|setActiveTab|openFile)\s*\(/);
  });

  it("a body's frame document is set once", () => {
    const mount = code(MOUNT);
    // The viewer reloads on a new refreshKey; the mount passes a constant.
    expect(mount).toMatch(/refreshKey=\{0\}/);
    expect(mount).not.toMatch(/\.src\s*=|\bsrc=\{/);
    expect(mount).not.toMatch(/location\.(reload|assign|replace)|contentWindow/);
  });
});
