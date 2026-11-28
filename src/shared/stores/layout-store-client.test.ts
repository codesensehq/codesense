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
/** The host's live hub, with only its native `watch`: a frame subscription would throw. Each
 *  watch is kept so a test can hand it a view. */
const hub = vi.hoisted(() => {
  type Watch = {
    topic: string;
    viewKey: string;
    callback: (snapshot: {
      topic: string;
      viewKey: string;
      rev: number;
      snapshot: unknown[];
    }) => void;
    stopped: boolean;
  };
  const watches: Watch[] = [];
  const watch = vi.fn((topic: string, viewKey: string, callback: Watch["callback"]) => {
    const w: Watch = { topic, viewKey, callback, stopped: false };
    watches.push(w);
    return () => {
      w.stopped = true;
    };
  });
  return { watches, watch };
});

vi.mock("@/tauri/commands", () => commands);
vi.mock("@/shared/lib/tiles-enabled", () => ({ tilesEnabled: () => Promise.resolve(flag.on) }));
vi.mock("@/features/dashboard/lib/live-hub", () => ({ liveHub: { watch: hub.watch } }));

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
  hub.watches.length = 0;
  hub.watch.mockClear();
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
    expect(hub.watch).not.toHaveBeenCalled();
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

/** Hands every live watch on `topic` and `viewKey` the view holding `rows`. */
async function deliver(topic: string, viewKey: string, rows: unknown[]) {
  const live = hub.watches.filter((w) => !w.stopped && w.topic === topic && w.viewKey === viewKey);
  expect(live).toHaveLength(1);
  live[0].callback({ topic, viewKey, rev: 1, snapshot: rows });
  await settle();
}

/** The `group` view's row for `fileId` holding `root` at `rev`, as the host publishes it. */
const groupRow = (fileId: string, rev: number, root: MosaicNode | null) => ({
  id: fileId,
  file: { version: 2, owner: "group", rev, root: wire(root) },
  dropped: [],
});

describe("a group delta", () => {
  const NEXT = setNodeSizes(TREE, [], [70, 30]);

  /** Hydrates FG and GRID into a store; returns it, its setter and FG's file id. */
  async function hydrated() {
    const state = {
      ...emptyState(),
      tabGridLayout: { [`${TEAM}|ws-1`]: { preset: "grid", root: TREE } },
    } as unknown as LayoutSlices;
    const set = vi.fn((update: (s: LayoutSlices) => Partial<LayoutSlices>) =>
      Object.assign(state, update(state)),
    );
    await hydrateLayouts(state, set);
    await settle();
    set.mockClear();
    return { state, set, fg: (await layoutFileRef(FG)).file.id };
  }

  it("subscribes the host once per shown file and once per org, the only subscriber", async () => {
    const { state, set } = await hydrated();
    await hydrateLayouts(state, set);
    saveLayout(FG, applyAll(TREE, [{ op: "swap", a: "ws-a", b: "ws-c" }]), {
      op: "swap",
      a: "ws-a",
      b: "ws-c",
    });
    await flushGroupCommits();
    const fg = (await layoutFileRef(FG)).file.id;
    const grid = (await layoutFileRef(GRID)).file.id;
    expect(hub.watches.map((w) => `${w.topic} ${w.viewKey}`).sort()).toEqual(
      [`group acme:${fg}`, `group acme:${grid}`, "groups acme"].sort(),
    );
  });

  it("from another writer reaches the shown layout, and the next commit builds on it", async () => {
    const { state, fg } = await hydrated();
    await deliver("group", `acme:${fg}`, [groupRow(fg, 4, NEXT)]);
    expect(saved(state.foregroundLayout[TEAM].root)).toBe(saved(NEXT));
    commands.groupCommit.mockResolvedValue({ rev: 5 });
    saveLayout(FG, applyAll(NEXT, [{ op: "swap", a: "ws-a", b: "ws-c" }]), {
      op: "swap",
      a: "ws-a",
      b: "ws-c",
    });
    await flushGroupCommits();
    expect(commands.groupCommit.mock.calls[0][2]).toBe(4);
    expect(commands.groupRead).toHaveBeenCalledTimes(2);
  });

  it("at or below the rev the window holds changes nothing", async () => {
    const { set, fg } = await hydrated();
    await deliver("group", `acme:${fg}`, [groupRow(fg, 3, NEXT)]);
    expect(set).not.toHaveBeenCalled();
  });

  it("of the window's own commit re-reads nothing and leaves the store as it is", async () => {
    const { set, fg } = await hydrated();
    const next = applyAll(TREE, [{ op: "swap", a: "ws-a", b: "ws-c" }]);
    saveLayout(FG, next, { op: "swap", a: "ws-a", b: "ws-c" });
    await flushGroupCommits();
    await deliver("group", `acme:${fg}`, [groupRow(fg, 4, next)]);
    expect(set).not.toHaveBeenCalled();
    expect(commands.groupRead).toHaveBeenCalledTimes(2);
  });

  it("with the tree already shown leaves the store untouched", async () => {
    const { set, fg } = await hydrated();
    await deliver("group", `acme:${fg}`, [groupRow(fg, 4, TREE)]);
    expect(set).not.toHaveBeenCalled();
  });

  it("for one file leaves every other layout's slice as it was", async () => {
    const { state, fg } = await hydrated();
    const grid = state.tabGridLayout;
    await deliver("group", `acme:${fg}`, [groupRow(fg, 4, NEXT)]);
    expect(state.tabGridLayout).toBe(grid);
  });

  it("keeps a pending resize on top of the new head", async () => {
    vi.useFakeTimers();
    const { state, fg } = await hydrated();
    const step: KitOp = { op: "resize", path: [1], sizes: [20, 80] };
    saveLayout(FG, applyAll(TREE, [step]), step);
    await settle();
    await deliver("group", `acme:${fg}`, [groupRow(fg, 4, NEXT)]);
    expect(saved(state.foregroundLayout[TEAM].root)).toBe(saved(applyAll(NEXT, [step])));
    await vi.advanceTimersByTimeAsync(100);
    await flushGroupCommits();
    expect(commands.groupCommit.mock.calls[0][2]).toBe(4);
    expect(commitOps(0)).toEqual([step]);
  });

  it("removing the file re-reads the head and shows it", async () => {
    const { state, fg } = await hydrated();
    commands.groupRead.mockResolvedValue(null);
    await deliver("group", `acme:${fg}`, []);
    expect(commands.groupRead).toHaveBeenCalledTimes(3);
    expect(state.foregroundLayout[TEAM].root).toBeNull();
  });

  it("a groups row past the window's rev re-reads the head and shows it", async () => {
    const { state, fg } = await hydrated();
    commands.groupRead.mockResolvedValue({ rev: 5, tree: wire(NEXT) });
    await deliver("groups", "acme", [{ id: fg, owner: "group", rev: 5 }]);
    expect(commands.groupRead).toHaveBeenCalledTimes(3);
    expect(saved(state.foregroundLayout[TEAM].root)).toBe(saved(NEXT));
  });

  it("a groups row at the window's rev re-reads nothing", async () => {
    const { set, fg } = await hydrated();
    await deliver("groups", "acme", [{ id: fg, owner: "group", rev: 3 }]);
    expect(commands.groupRead).toHaveBeenCalledTimes(2);
    expect(set).not.toHaveBeenCalled();
  });

  it("resetting the client stops every watch", async () => {
    await hydrated();
    resetLayoutClientForTests();
    expect(hub.watches.every((w) => w.stopped)).toBe(true);
  });
});
