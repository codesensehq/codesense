// SPDX-License-Identifier: MIT
import { MOCK_ORG_SLUG, MOCK_TEAM_NAME, TEAM_CONTENT_PATH } from "../fixtures";
import type { HandlerRegistry } from "../mock-router";
import type { DerivedPipelineTree } from "@/shared/lib/pipeline-graph/types";

/**
 * The perf baseline's mock worlds (`tests/e2e-mock/perf-baseline.spec.ts`), each opt-in by query:
 * `?perf=tiles12` boots 12 workspaces tiled 4 × 3 in the workspace mosaic (seeded by
 * `terminal-layout.ts`), and `?perf=nav5k` answers `scan_pipeline_tree` with a team content tree of
 * exactly 5,000 file rows in nested folders.
 */
export type PerfWorld = "tiles12" | "nav5k";

export function isPerfWorld(search: string, world: PerfWorld): boolean {
  return new URLSearchParams(search).get("perf") === world;
}

/** The 12-tile world's workspaces: generic ones, each running one shell (`terminal-layout.ts`). */
export const PERF_TILES = Array.from({ length: 12 }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  const cwd = `${TEAM_CONTENT_PATH}/perf/tile-${n}`;
  return { id: `generic:${cwd}`, cwd, name: `tile-${n}`, session: `perf-tile-${n}` };
});

/** Lines of scrollback each tile's shell holds, so the scroll case has history to move through. */
const TILE_SCROLLBACK_LINES = 2_400;
const tileOutput = new Map<string, string>();

/** A tile shell's canned output (built once per session), or undefined for any other session. */
export function perfTileOutput(session: string): string | undefined {
  const tile = PERF_TILES.find((each) => each.session === session);
  if (!tile) return undefined;
  let text = tileOutput.get(session);
  if (text === undefined) {
    const lines = Array.from(
      { length: TILE_SCROLLBACK_LINES },
      (_, i) => `${tile.name} line ${String(i + 1).padStart(4, "0")}: ok`,
    );
    text = `${lines.join("\r\n")}\r\n\x1b[32m~/${tile.name}\x1b[0m $ `;
    tileOutput.set(session, text);
  }
  return text;
}

/** The nav tree's shape: top folders, the folders inside each, and the files in each of those. */
const NAV_AREAS = 10;
const NAV_GROUPS = 5;
const NAV_FILES_PER_GROUP = 100;
export const NAV_5K_FILES = NAV_AREAS * NAV_GROUPS * NAV_FILES_PER_GROUP;

const pad = (n: number, width: number) => String(n).padStart(width, "0");

function folder(root: string, dirPath: string, subEpics: DerivedPipelineTree[], docs: string[]) {
  return {
    dirPath,
    dirName: dirPath.split("/").pop() ?? "",
    absoluteDirPath: dirPath ? `${root}/${dirPath}` : root,
    orderError: null,
    mainDoc: null,
    stories: [],
    docs: docs.map((fileName) => ({ fileName, filePath: `${root}/${dirPath}/${fileName}` })),
    subEpics,
  } satisfies DerivedPipelineTree;
}

/** The 5,000-file team content: `area-NN/group-N/file-NNNNN.md`, numbered in tree order. */
export function navTree5k(root: string): DerivedPipelineTree {
  let next = 0;
  const areas = Array.from({ length: NAV_AREAS }, (_, a) => {
    const area = `area-${pad(a + 1, 2)}`;
    const groups = Array.from({ length: NAV_GROUPS }, (_, g) => {
      const files = Array.from({ length: NAV_FILES_PER_GROUP }, () => `file-${pad(next++, 5)}.md`);
      return folder(root, `${area}/group-${g + 1}`, [], files);
    });
    return folder(root, area, groups, []);
  });
  return folder(root, "", areas, []);
}

/** The spec's clock, when it is installed (`window.__perf`). */
type PerfClock = { start: { ms: number; endState: string } | null };

/**
 * `?perf=nav5k`: the team's scan answers the 5,000-file tree. Its first answer stamps the spec's
 * start clock, which the nav's first paint is timed from; a later rescan leaves it. The app state
 * is `base`'s (the demo's) with the first area and its first group open, so the nav's first paint
 * draws file rows.
 */
export function navPerfHandlers(base: HandlerRegistry): HandlerRegistry {
  const loadBase = base.load_app_state;
  let stamped = false;
  return {
    // Synchronous, as the demo's is: some readers parse the answer without awaiting it.
    load_app_state: (args) => {
      const state = JSON.parse(String(loadBase(args))) as { viewer: object };
      state.viewer = {
        ...state.viewer,
        statusNavExpandedPaths: {
          [`${MOCK_ORG_SLUG}:${MOCK_TEAM_NAME}`]: [
            `${TEAM_CONTENT_PATH}/area-01`,
            `${TEAM_CONTENT_PATH}/area-01/group-1`,
          ],
        },
      };
      return JSON.stringify(state);
    },
    scan_pipeline_tree: (args) => {
      const tree = navTree5k(String(args.teamContentPath).replace(/\/+$/, ""));
      const clock = (globalThis as { __perf?: PerfClock }).__perf;
      if (clock && !stamped) {
        stamped = true;
        clock.start = { ms: performance.now(), endState: "scan_pipeline_tree" };
      }
      return tree;
    },
  };
}
