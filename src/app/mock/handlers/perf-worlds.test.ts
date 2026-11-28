// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";
import { TEAM_CONTENT_PATH } from "../fixtures";
import { createMockBackend } from "../mock-backend";
import { resolveScenario } from "../scenario";
import type { DerivedPipelineTree } from "@/shared/lib/pipeline-graph/types";
import { isPerfWorld, NAV_5K_FILES, navTree5k } from "./perf-worlds";

/** Every file row the nav would draw for `tree`, depth first, and the folders holding them. */
function walk(tree: DerivedPipelineTree, depth = 0, out = { files: [] as string[], depths: [0] }) {
  for (const doc of tree.docs ?? []) out.files.push(doc.filePath);
  for (const story of tree.stories) out.files.push(story.filePath);
  for (const sub of tree.subEpics) {
    out.depths.push(depth + 1);
    walk(sub, depth + 1, out);
  }
  return out;
}

describe("perf worlds", () => {
  it("reads ?perf=tiles12 and ?perf=nav5k and nothing else", () => {
    expect(isPerfWorld("?perf=tiles12", "tiles12")).toBe(true);
    expect(isPerfWorld("?perf=nav5k", "nav5k")).toBe(true);
    expect(isPerfWorld("?perf=nav5k", "tiles12")).toBe(false);
    expect(isPerfWorld("?perf=tiles", "tiles12")).toBe(false);
    expect(isPerfWorld("", "nav5k")).toBe(false);
  });

  it("the nav tree holds exactly 5,000 file rows, unique, in nested folders", () => {
    const { files, depths } = walk(navTree5k("/root"));
    expect(NAV_5K_FILES).toBe(5_000);
    expect(files).toHaveLength(5_000);
    expect(new Set(files).size).toBe(5_000);
    expect(Math.max(...depths)).toBeGreaterThanOrEqual(2);
    expect(files.every((file) => file.startsWith("/root/"))).toBe(true);
    // The first and the last generated rows are the ones the spec looks for.
    expect(files[0]).toMatch(/\/file-00000\.md$/);
    expect(files.at(-1)).toMatch(/\/file-04999\.md$/);
  });
});

describe("the ?perf=nav5k backend", () => {
  const perf = globalThis as { __perf?: { start: unknown } };
  afterEach(() => delete perf.__perf);

  const scanner = (search: string) => {
    const router = createMockBackend(resolveScenario(search), search);
    return () =>
      router("scan_pipeline_tree", {
        teamContentPath: `${TEAM_CONTENT_PATH}/`,
      }) as Promise<DerivedPipelineTree>;
  };

  it("answers scan_pipeline_tree with the 5,000-file tree and stamps the start once", async () => {
    perf.__perf = { start: null };
    const scan = scanner("?perf=nav5k");
    const tree = await scan();
    expect(walk(tree).files).toHaveLength(5_000);
    expect(tree.absoluteDirPath).toBe(TEAM_CONTENT_PATH);
    const start = perf.__perf.start as { ms: number; endState: string };
    expect(start.endState).toBe("scan_pipeline_tree");
    expect(typeof start.ms).toBe("number");
    // A rescan (a file watcher's refresh) doesn't move the start the first paint is timed from.
    perf.__perf.start = null;
    await scan();
    expect(perf.__perf.start).toBeNull();
  });

  it("boots with the first area and its first group open, so a file row paints first", async () => {
    const search = "?perf=nav5k";
    const state = JSON.parse(
      String(await createMockBackend(resolveScenario(search), search)("load_app_state")),
    ) as { viewer: { statusNavExpandedPaths: Record<string, string[]> } };
    expect(Object.values(state.viewer.statusNavExpandedPaths)).toEqual([
      [`${TEAM_CONTENT_PATH}/area-01`, `${TEAM_CONTENT_PATH}/area-01/group-1`],
    ]);
  });

  it("leaves the default world's scan alone", async () => {
    perf.__perf = { start: null };
    expect(walk(await scanner("")()).files.length).toBeLessThan(5_000);
    expect(perf.__perf.start).toBeNull();
  });
});
