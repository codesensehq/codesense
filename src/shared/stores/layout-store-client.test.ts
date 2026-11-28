// SPDX-License-Identifier: MIT
import { readFileSync } from "fs";
import { resolve } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyKitOp, KIT_OP_FAILED } from "@/shared/tiling/apply-kit-op";
import type { KitOp } from "@/shared/tiling/kit-op";
import {
  parseMosaicNode,
  serializeMosaicNode,
  setNodeSizes,
  type MosaicNode,
} from "@/shared/tiling/mosaic-tree";

const commands = vi.hoisted(() => ({
  groupRead: vi.fn(),
  groupCommit: vi.fn(),
}));
const flag = vi.hoisted(() => ({ on: true }));

vi.mock("@/tauri/commands", () => commands);
vi.mock("@/shared/lib/tiles-enabled", () => ({ tilesEnabled: () => Promise.resolve(flag.on) }));

import {
  buildOps,
  flushGroupCommits,
  hydrateLayouts,
  layoutFileRef,
  resetLayoutClientForTests,
  savedRoot,
  saveLayout,
  type LayoutSlices,
  type LayoutTarget,
} from "./layout-store-client";

const leaf = (id: string): MosaicNode => ({ kind: "leaf", id });
const split = (
  axis: "row" | "column",
  children: MosaicNode[],
  sizes = children.map(() => 100 / children.length),
): MosaicNode => ({ kind: "split", axis, children, sizes });

const TEAM = "acme:app";
const FG: LayoutTarget = { kind: "foreground", teamKey: TEAM, railKey: null };
const GRID: LayoutTarget = { kind: "tabGrid", workspaceKey: `${TEAM}|ws-1` };
const TREE = split("row", [leaf("ws-a"), split("column", [leaf("ws-b"), leaf("ws-c")])], [40, 60]);

/** A tree of twelve tiles: three rows of four. */
const TWELVE = split(
  "column",
  [0, 1, 2].map((r) =>
    split(
      "row",
      [0, 1, 2, 3].map((c) => leaf(`ws-${r}-${c}`)),
    ),
  ),
);

function applyAll(root: MosaicNode | null, ops: KitOp[]): MosaicNode | null {
  let at = root;
  for (const op of ops) {
    const next = applyKitOp(at, op);
    if (next === KIT_OP_FAILED) throw new Error(`${op.op} failed`);
    at = next;
  }
  return at;
}

const saved = (root: MosaicNode | null) => JSON.stringify(serializeMosaicNode(root));
const wire = (root: MosaicNode | null) => serializeMosaicNode(root);
const commitOps = (call: number) => commands.groupCommit.mock.calls[call][3] as KitOp[];

/** Lets the client's queued steps run. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function emptyState(): LayoutSlices {
  return {
    workspaces: { [TEAM]: [] },
    foregroundLayout: {},
    foregroundLayoutByRail: {},
    tabGridLayout: {},
  } as unknown as LayoutSlices;
}

beforeEach(() => {
  flag.on = true;
  resetLayoutClientForTests();
  commands.groupRead.mockReset().mockResolvedValue({ rev: 3, tree: wire(TREE) });
  let rev = 3;
  commands.groupCommit.mockReset().mockImplementation(async () => ({ rev: ++rev }));
});

afterEach(async () => {
  await flushGroupCommits();
  vi.useRealTimers();
});

describe("the group file a layout lives in", () => {
  it("names the file both sides name, from the one shared table", async () => {
    const rows = JSON.parse(
      readFileSync(resolve(__dirname, "../../../tests/fixtures/group-file-ids.json"), "utf8"),
    ) as { target: LayoutTarget; org: string; file: unknown }[];
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      expect(await layoutFileRef(row.target)).toEqual({ org: row.org, file: row.file });
    }
  });

  it("keeps a flat layout and the ungrouped rail in two files", async () => {
    const flat = await layoutFileRef(FG);
    const ungrouped = await layoutFileRef({ ...FG, railKey: "" });
    expect(flat.file.id).toMatch(/^fg-[0-9a-f]{32}$/);
    expect(flat.file.id).not.toBe(ungrouped.file.id);
  });
});

describe("the ops that build a tree", () => {
  it("build every tree the kit holds, sizes included", () => {
    for (const tree of [
      leaf("ws-a"),
      TREE,
      TWELVE,
      split("row", [leaf("x"), leaf("y")], [25, 75]),
    ]) {
      expect(saved(applyAll(null, buildOps(tree)))).toBe(saved(tree));
    }
    expect(buildOps(null)).toEqual([]);
  });
});

describe("saving a layout", () => {
  it("sends only group_commit, with the gesture's op on the rev it read", async () => {
    const next = applyAll(TREE, [{ op: "swap", a: "ws-a", b: "ws-c" }]);
    saveLayout(FG, next, { op: "swap", a: "ws-a", b: "ws-c" });
    await flushGroupCommits();
    expect(commands.groupRead).toHaveBeenCalledTimes(1);
    expect(commands.groupCommit).toHaveBeenCalledTimes(1);
    const [org, file, baseRev, ops] = commands.groupCommit.mock.calls[0];
    expect(org).toBe("acme");
    expect(file).toEqual((await layoutFileRef(FG)).file);
    expect(baseRev).toBe(3);
    expect(ops).toEqual([{ op: "swap", a: "ws-a", b: "ws-c" }]);
  });

  it("builds a layout with no group file yet from nothing", async () => {
    commands.groupRead.mockResolvedValue(null);
    commands.groupCommit.mockResolvedValue({ rev: 1 });
    saveLayout(FG, TREE, { op: "close", leafId: "ws-d" });
    await flushGroupCommits();
    const [, , baseRev, ops] = commands.groupCommit.mock.calls[0];
    expect(baseRev).toBe(0);
    expect(saved(applyAll(null, ops))).toBe(saved(TREE));
  });

  it("sends nothing for a layout the file already holds", async () => {
    saveLayout(FG, TREE);
    await flushGroupCommits();
    expect(commands.groupCommit).not.toHaveBeenCalled();
  });

  it("with the tiles flag off, reads and writes no group file", async () => {
    flag.on = false;
    saveLayout(FG, applyAll(TREE, [{ op: "close", leafId: "ws-a" }]), {
      op: "close",
      leafId: "ws-a",
    });
    const state = emptyState();
    const set = vi.fn();
    await hydrateLayouts(state, set);
    await flushGroupCommits();
    expect(commands.groupRead).not.toHaveBeenCalled();
    expect(commands.groupCommit).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});

describe("a drag of resize steps", () => {
  /** Reads the files holding `tree` first: their ids are a digest, which no fake timer
   *  advances. */
  async function readFirst(tree: MosaicNode) {
    vi.useRealTimers();
    resetLayoutClientForTests();
    commands.groupRead.mockResolvedValue({ rev: 3, tree: wire(tree) });
    const state = {
      ...emptyState(),
      tabGridLayout: { [`${TEAM}|ws-1`]: { preset: "grid", root: tree } },
    } as unknown as LayoutSlices;
    await hydrateLayouts(state, () => {});
    commands.groupRead.mockClear();
    vi.useFakeTimers();
  }

  beforeEach(() => readFirst(TREE));

  /** `steps` resizes of the split at `path`, each saved as the drag sends it. */
  function drag(target: LayoutTarget, tree: MosaicNode, path: number[], steps: number) {
    let at = tree;
    for (let i = 1; i <= steps; i++) {
      const sizes = path.length === 0 && tree === TWELVE ? [30 + i, 30, 40 - i] : [40 + i, 60 - i];
      at = setNodeSizes(at, path, sizes);
      saveLayout(target, at, { op: "resize", path, sizes });
    }
    return at;
  }

  it("sends one group_commit per 100 ms window, the last sizes winning", async () => {
    drag(FG, TREE, [], 12);
    await settle();
    expect(commands.groupCommit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(commands.groupCommit).toHaveBeenCalledTimes(1);
    expect(commitOps(0)).toEqual([{ op: "resize", path: [], sizes: [52, 48] }]);
    drag(FG, setNodeSizes(TREE, [], [52, 48]), [], 3);
    await vi.advanceTimersByTimeAsync(100);
    expect(commands.groupCommit).toHaveBeenCalledTimes(2);
    expect(commitOps(1)).toEqual([{ op: "resize", path: [], sizes: [43, 57] }]);
  });

  it("on a twelve-tile tree, one group_commit per window", async () => {
    await readFirst(TWELVE);
    drag(FG, TWELVE, [], 30);
    await vi.advanceTimersByTimeAsync(100);
    expect(commands.groupCommit).toHaveBeenCalledTimes(1);
    expect(commitOps(0)).toEqual([{ op: "resize", path: [], sizes: [60, 30, 10] }]);
  });

  it("flushGroupCommits sends the pending commit at once and resolves after the reply", async () => {
    let answer: (reply: unknown) => void = () => {};
    commands.groupCommit.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    drag(GRID, TREE, [1], 5);
    await settle();
    let done = false;
    const flushed = flushGroupCommits(GRID).then(() => (done = true));
    await settle();
    expect(commands.groupCommit).toHaveBeenCalledTimes(1);
    expect(commitOps(0)).toEqual([{ op: "resize", path: [1], sizes: [45, 55] }]);
    expect(done).toBe(false);
    answer({ rev: 4 });
    await flushed;
    expect(done).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(commands.groupCommit).toHaveBeenCalledTimes(1);
  });

  it("flushGroupCommits with a conflict resolves after the reload and the replay", async () => {
    commands.groupCommit
      .mockResolvedValueOnce({ conflict: { currentRevision: 5 } })
      .mockResolvedValueOnce({ rev: 6 });
    drag(FG, TREE, [], 2);
    await settle();
    commands.groupRead.mockResolvedValue({ rev: 5, tree: wire(TREE) });
    await flushGroupCommits();
    expect(commands.groupCommit).toHaveBeenCalledTimes(2);
    expect(commands.groupCommit.mock.calls[1][2]).toBe(5);
    expect(commitOps(1)).toEqual(commitOps(0));
  });

  it("flushGroupCommits with nothing pending resolves with no call", async () => {
    await flushGroupCommits();
    expect(commands.groupRead).not.toHaveBeenCalled();
    expect(commands.groupCommit).not.toHaveBeenCalled();
  });
});

describe("a conflict", () => {
  async function hydrated() {
    const state = emptyState();
    const set = vi.fn((update: (s: LayoutSlices) => Partial<LayoutSlices>) =>
      Object.assign(state, update(state)),
    );
    await hydrateLayouts(state, set);
    set.mockClear();
    return { state, set };
  }

  it("without collided keys reloads the head and replays the op on it", async () => {
    const { state } = await hydrated();
    const head = split("row", [
      leaf("ws-a"),
      split("column", [leaf("ws-b"), leaf("ws-c")]),
      leaf("ws-d"),
    ]);
    commands.groupCommit
      .mockResolvedValueOnce({ conflict: { currentRevision: 7 } })
      .mockResolvedValueOnce({ rev: 8 });
    commands.groupRead.mockResolvedValue({ rev: 7, tree: wire(head) });
    const swap: KitOp = { op: "swap", a: "ws-a", b: "ws-b" };
    saveLayout(FG, applyAll(TREE, [swap]), swap);
    await flushGroupCommits();
    expect(commands.groupCommit).toHaveBeenCalledTimes(2);
    expect(commands.groupCommit.mock.calls[1][2]).toBe(7);
    expect(commitOps(1)).toEqual([swap]);
    expect(saved(state.foregroundLayout[TEAM].root)).toBe(saved(applyAll(head, [swap])));
  });

  it("with collided keys reloads the head and drops the op: no second group_commit", async () => {
    const { state } = await hydrated();
    const head = split("row", [leaf("ws-c"), leaf("ws-a")]);
    commands.groupCommit.mockResolvedValueOnce({
      conflict: { currentRevision: 9, collided: ["ws-c"] },
    });
    commands.groupRead.mockResolvedValue({ rev: 9, tree: wire(head) });
    const close: KitOp = { op: "close", leafId: "ws-c" };
    saveLayout(FG, applyAll(TREE, [close]), close);
    await flushGroupCommits();
    expect(commands.groupCommit).toHaveBeenCalledTimes(1);
    expect(saved(state.foregroundLayout[TEAM].root)).toBe(saved(head));
  });

  it("a reply past the next rev re-reads the head and shows it", async () => {
    const { state } = await hydrated();
    const head = split("row", [leaf("ws-c"), leaf("ws-a"), leaf("ws-b")]);
    commands.groupCommit.mockResolvedValueOnce({ rev: 6 });
    commands.groupRead.mockResolvedValue({ rev: 6, tree: wire(head) });
    const swap: KitOp = { op: "swap", a: "ws-a", b: "ws-c" };
    saveLayout(FG, applyAll(TREE, [swap]), swap);
    await flushGroupCommits();
    expect(saved(state.foregroundLayout[TEAM].root)).toBe(saved(head));
  });
});

describe("hydrating", () => {
  it("seeds each layout that has a group file with its tree", async () => {
    commands.groupRead.mockImplementation(async (_org: string, file: { owner: string }) =>
      file.owner === "group" ? { rev: 3, tree: wire(TREE) } : null,
    );
    const state = {
      ...emptyState(),
      foregroundLayoutByRail: {
        [TEAM]: { "": { sizes: [], direction: "row", preset: "rows", root: null } },
      },
      tabGridLayout: { [`${TEAM}|ws-1`]: { preset: "grid", root: TREE } },
    } as unknown as LayoutSlices;
    const set = vi.fn((update: (s: LayoutSlices) => Partial<LayoutSlices>) =>
      Object.assign(state, update(state)),
    );
    await hydrateLayouts(state, set);
    expect(saved(state.foregroundLayout[TEAM].root)).toBe(saved(TREE));
    expect(state.foregroundLayout[TEAM].preset).toBe("custom");
    expect(saved(state.foregroundLayoutByRail[TEAM][""].root)).toBe(saved(TREE));
    expect(state.tabGridLayout[`${TEAM}|ws-1`]).toEqual({ preset: "grid", root: TREE });
  });
});

describe("one tree whichever way the flag goes", () => {
  const fixture = JSON.parse(
    readFileSync(resolve(__dirname, "../../../tests/fixtures/group-file-v2.json"), "utf8"),
  ) as { root: unknown };
  const tree = parseMosaicNode(fixture.root)!;
  /** `app-state.json`'s viewer section as a flag-off build saved it. */
  const appState = {
    terminalTabGridSizes: { [GRID.workspaceKey]: { preset: "grid", root: fixture.root } },
  };
  const stateWith = (root: MosaicNode) =>
    ({
      ...emptyState(),
      tabGridLayout: { [GRID.workspaceKey]: { preset: "grid", root } },
    }) as unknown as LayoutSlices;

  it("a flag-on write, a flag-off launch and a flag-on launch load the same tree", async () => {
    // A flag-on launch with no group file yet: the first save writes the tree.
    commands.groupRead.mockResolvedValue(null);
    let written: MosaicNode | null = null;
    commands.groupCommit.mockImplementation(async (_org, _file, baseRev: number, ops: KitOp[]) => {
      written = applyAll(null, ops);
      return { rev: baseRev + 1 };
    });
    await hydrateLayouts(stateWith(tree), () => {}, appState);
    saveLayout(GRID, tree);
    await flushGroupCommits();
    expect(saved(written)).toBe(saved(tree));
    // `app-state.json` keeps its launch root, byte for byte.
    const kept = savedRoot("tabGridLayout", GRID.workspaceKey, setNodeSizes(tree, [], [10, 90]));
    expect(JSON.stringify(kept)).toBe(JSON.stringify(fixture.root));

    // A flag-off launch reads that root from `app-state.json`.
    flag.on = false;
    resetLayoutClientForTests();
    const reads = commands.groupRead.mock.calls.length;
    const offState = stateWith(parseMosaicNode(kept)!);
    await hydrateLayouts(offState, () => {}, appState);
    expect(saved(offState.tabGridLayout[GRID.workspaceKey].root)).toBe(saved(tree));
    expect(commands.groupRead).toHaveBeenCalledTimes(reads);

    // A flag-on launch reads it from the group file.
    flag.on = true;
    resetLayoutClientForTests();
    commands.groupRead.mockResolvedValue({ rev: 1, tree: wire(written) });
    const onState = stateWith(setNodeSizes(tree, [], [10, 90]));
    await hydrateLayouts(onState, (update) => Object.assign(onState, update(onState)), appState);
    expect(saved(onState.tabGridLayout[GRID.workspaceKey].root)).toBe(saved(tree));
  });

  it("with the flag off, a persist saves the live root", async () => {
    flag.on = false;
    await hydrateLayouts(stateWith(tree), () => {}, appState);
    const live = setNodeSizes(tree, [], [10, 90]);
    expect(savedRoot("tabGridLayout", GRID.workspaceKey, live)).toEqual(serializeMosaicNode(live));
  });
});
