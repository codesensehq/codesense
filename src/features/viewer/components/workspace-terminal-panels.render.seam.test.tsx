// SPDX-License-Identifier: MIT
/**
 * Seam test: the CLI workspace redraws only the tiles that changed. The real panel tree, the
 * real terminal manager and `ShellTerminalPanel`, the real `DndContext` and the real store; only
 * the Tauri boundary is faked. Each tile frame and each tab-grid cell reports to a frame probe (a
 * `React.Profiler` commit count and a mount count), which is the proof: the frame holds no terminal
 * state, so a `Terminal` constructor count stays flat even when every frame remounts.
 *
 * A second probe counts the store hooks, `useDraggable` and `useDroppable` per tile id and records
 * whether what each returns changed identity, so a frame that redraws names its cause.
 *
 * Profiler callbacks fire only in dev React: these are seam tests, never run on the packaged build.
 */
import { act, cleanup, fireEvent, render } from "@/test-utils";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  bus: null as unknown as import("@/shared/terminal/__test-utils__/fake-terminal-server").FakeEventBus,
  server:
    null as unknown as import("@/shared/terminal/__test-utils__/fake-terminal-server").FakeTerminalServer,
  created: 0,
  /** hook name → workspace id → how many times the value a hook returned differed from its last. */
  changes: {} as Record<string, Record<string, number>>,
  /** hook name → workspace id → what it returned last. */
  last: {} as Record<string, Record<string, unknown[]>>,
}));

/** Record what `hook` returned for `workspaceId`: a change in any part of it counts once. */
function recordReturn(hook: string, workspaceId: string, parts: unknown[]) {
  const last = (h.last[hook] ??= {});
  const before = last[workspaceId];
  last[workspaceId] = parts;
  if (before && parts.some((part, i) => !Object.is(part, before[i]))) {
    const changes = (h.changes[hook] ??= {});
    changes[workspaceId] = (changes[workspaceId] ?? 0) + 1;
  }
}

vi.mock("@xterm/xterm", async (importOriginal) => {
  const xterm = await importOriginal<typeof import("@xterm/xterm")>();
  class CountedTerminal extends xterm.Terminal {
    constructor(...args: ConstructorParameters<typeof xterm.Terminal>) {
      super(...args);
      h.created++;
    }
  }
  return { ...xterm, Terminal: CountedTerminal };
});
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    activate() {}
    dispose() {}
    onContextLoss() {
      return { dispose() {} };
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (event: { payload: unknown }) => void) =>
    h.bus.listen(name, handler),
  emit: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/tauri/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/tauri/commands")>()),
  saveAppState: vi.fn().mockResolvedValue(undefined),
  loadAppState: vi.fn().mockResolvedValue("{}"),
  pushViewerState: vi.fn().mockResolvedValue(undefined),
  checkPathExists: vi.fn().mockResolvedValue(true),
  sessionsRunningProcesses: vi.fn((ids: string[]) =>
    Promise.resolve(ids.map(() => ({ foreground: null, background: [] }))),
  ),
  reserveTerminalStream: () => h.server.reserve(),
  subscribeTerminal: (session: string, stream?: number) => h.server.subscribe(session, stream),
  unsubscribeTerminal: (stream: number) => h.server.unsubscribe(stream),
  writePty: vi.fn().mockResolvedValue(undefined),
  resizePty: vi.fn((session: string, cols: number, rows: number) =>
    h.server.resize(session, cols, rows),
  ),
}));
vi.mock("./source-editor-inset", () => ({ WorktreeEditorSurface: () => null }));
vi.mock("@/features/inbox/components/chat-overlay", () => ({ ChatOverlay: () => null }));
vi.mock("@/features/dashboard/components/markdown-viewer", () => ({ MarkdownViewer: () => null }));
vi.mock("@/shared/lib/pipeline-graph/use-story-details", () => ({
  useStoryDetails: vi.fn(() => ({ data: { title: null, storyText: "" }, loading: false })),
}));

// The subscription probe: the hooks a frame subscribes through, counted per workspace id.
vi.mock("@/features/viewer/lib/cli-workspace/store/terminal-selectors", async (importOriginal) => {
  const mod =
    await importOriginal<
      typeof import("@/features/viewer/lib/cli-workspace/store/terminal-selectors")
    >();
  const watch = <A extends [string, string], R>(name: string, hook: (...args: A) => R) =>
    ((...args: A) => {
      const result = hook(...args);
      recordReturn(name, args[1], [result]);
      return result;
    }) as typeof hook;
  return {
    ...mod,
    useWorkspaceTabsSlice: watch("useWorkspaceTabsSlice", mod.useWorkspaceTabsSlice),
    useWorkspaceActiveTab: watch("useWorkspaceActiveTab", mod.useWorkspaceActiveTab),
    useWorkspacePanedTabIds: watch("useWorkspacePanedTabIds", mod.useWorkspacePanedTabIds),
    useShouldRenderTabGrid: watch("useShouldRenderTabGrid", mod.useShouldRenderTabGrid),
    useIsExpandedWorkspace: watch("useIsExpandedWorkspace", mod.useIsExpandedWorkspace),
  };
});
vi.mock("../lib/focus-indicator", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/focus-indicator")>();
  return {
    ...mod,
    useTileFocusIndicator: (tileKey: string) => {
      const result = mod.useTileFocusIndicator(tileKey);
      recordReturn("useTileFocusIndicator", tileKey.split(":").pop() ?? tileKey, [result]);
      return result;
    },
  };
});
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...mod,
    useDraggable: (options: Parameters<typeof mod.useDraggable>[0]) => {
      const result = mod.useDraggable(options);
      recordReturn("useDraggable", String(options.id), [
        result.attributes,
        result.listeners,
        result.setNodeRef,
        result.isDragging,
      ]);
      return result;
    },
    useDroppable: (options: Parameters<typeof mod.useDroppable>[0]) => {
      const result = mod.useDroppable(options);
      recordReturn("useDroppable", String(options.id), [result.setNodeRef, result.isOver]);
      return result;
    },
  };
});

import {
  FakeEventBus,
  FakeTerminalServer,
} from "@/shared/terminal/__test-utils__/fake-terminal-server";
import { terminalManager } from "@/shared/terminal/terminal-manager";
import { rememberTerminalSize } from "@/shared/lib/terminal-open";
import { useOrgStore } from "@/shared/stores/org-store";
import { useViewerStore, effectiveMosaicRoot } from "@/shared/stores/viewer-store";
import { reconcilePresetTree, type MosaicNode } from "@/shared/tiling";
import { dropWorkspace } from "../lib/tray-reorder-drag";
import { tileZoneId } from "../lib/terminal-drag";
import { installTerminalLayoutHarness, seedTerminalTabs } from "@/test/terminal-layout-harness";
import { useTerminalDisplayWarm } from "../hooks/use-terminal-display-warm";
import { WorkspaceTerminalPanels, type FrameProbe } from "./workspace-terminal-panels";

installTerminalLayoutHarness();

const TEAM = "acme:default";
const TEAM_B = "acme:other";
/** Eight tiles, each with one terminal; a ninth is added by the tests. */
const TILES = Array.from({ length: 8 }, (_, i) => `w${i + 1}`);
const NEW_TILE = "w9";
const GRID_TABS = ["g1", "g2", "g3", "g4"];

const s = () => useViewerStore.getState();
const flush = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const sessionOf = (id: string) => `s-${id}`;

/** The frame probe: commits and mounts per frame id since the last `reset`. The counts cover each
 *  frame's own render only, not its descendants': subscriptions below the frame (avatar packs, the
 *  tab captions' inbox counts, the tab bar's reads) can still redraw for an unrelated tile, and a
 *  later change owns them and widens this probe to a `Profiler` around the whole frame. */
const probe = (() => {
  const renders = new Map<string, number>();
  const mounts = new Map<string, number>();
  const api: FrameProbe & {
    reset: () => void;
    renders: Map<string, number>;
    mounts: Map<string, number>;
    /** Frame ids that committed a render since the last reset. */
    rendered: (prefix: string) => string[];
    mounted: (prefix: string) => string[];
  } = {
    renders,
    mounts,
    render: (id) => void renders.set(id, (renders.get(id) ?? 0) + 1),
    mount: (id) => void mounts.set(id, (mounts.get(id) ?? 0) + 1),
    reset: () => {
      renders.clear();
      mounts.clear();
      h.changes = {};
    },
    rendered: (prefix) => [...renders.keys()].filter((id) => id.startsWith(prefix)).sort(),
    mounted: (prefix) => [...mounts.keys()].filter((id) => id.startsWith(prefix)).sort(),
  };
  return api;
})();

function addWorkspace(teamKey: string, id: string, tabs = [sessionOf(id)]) {
  for (const tab of tabs) h.server.open(tab);
  useViewerStore.setState((st) => ({
    workspaces: {
      ...st.workspaces,
      [teamKey]: [
        ...(st.workspaces[teamKey] ?? []),
        { id, kind: "story", cwd: `/${id}`, status: "ready" },
      ],
    },
  }));
  seedTerminalTabs(teamKey, id, tabs, { active: tabs[0] });
}

function seed() {
  useViewerStore.setState((st) => ({
    settings: { ...st.settings, terminalScrollback: 1000 },
    foregroundLayout: { [TEAM]: { sizes: [], direction: "row", preset: "grid", root: null } },
    activeWorkspace: { [TEAM]: "w1" },
    terminalVisible: true,
    aiStatusBySession: {},
    workspaces: {},
  }));
  for (const id of TILES) addWorkspace(TEAM, id, id === "w1" ? GRID_TABS : undefined);
}

const dragEnd: { current: ((event: DragEndEvent) => void) | null } = { current: null };

function renderApp(teamHidden = false) {
  const onDragEnd = (event: DragEndEvent) => dropWorkspace(TEAM, event.active.id, event.over?.id);
  dragEnd.current = onDragEnd;
  return render(
    <DndContext onDragEnd={onDragEnd}>
      <DisplayWarm />
      <div data-xterm-host data-repo-path="/repo">
        <WorkspaceTerminalPanels
          teamKey={TEAM}
          repoPath="/repo"
          teamHidden={teamHidden}
          frameProbe={probe}
        />
      </div>
    </DndContext>,
  );
}

function DisplayWarm() {
  useTerminalDisplayWarm();
  return null;
}

beforeEach(() => {
  h.bus = new FakeEventBus();
  h.server = new FakeTerminalServer(h.bus);
  h.created = 0;
  h.changes = {};
  h.last = {};
  rememberTerminalSize(100, 30);
  useOrgStore.setState({ activeOrgSlug: "acme", activeTeamName: "default" });
  probe.reset();
  seed();
});

afterEach(() => {
  cleanup();
  for (const id of [...TILES, NEW_TILE, ...GRID_TABS, "g5"]) {
    terminalManager.dispose(sessionOf(id));
    terminalManager.dispose(id);
  }
  vi.restoreAllMocks();
});

/** The ids of every leaf under the split at `path`, or of the leaf there. */
function leavesUnder(root: MosaicNode, path: number[]): string[] {
  let node = root;
  for (const index of path) {
    if (node.kind !== "split") return [];
    node = node.children[index];
  }
  const out: string[] = [];
  const walk = (n: MosaicNode) => {
    if (n.kind === "leaf") out.push(n.id);
    else n.children.forEach(walk);
  };
  walk(node);
  return out;
}

/** The index path of the split that directly holds leaf `id`. */
function parentPathOf(node: MosaicNode, id: string, path: number[] = []): number[] | null {
  if (node.kind !== "split") return null;
  for (const [i, child] of node.children.entries()) {
    if (child.kind === "leaf" && child.id === id) return path;
    const deeper = parentPathOf(child, id, [...path, i]);
    if (deeper) return deeper;
  }
  return null;
}

const currentRoot = () =>
  effectiveMosaicRoot(
    s().foregroundLayout[TEAM],
    s().workspaces[TEAM].map((w) => w.id),
  )!;

const frames = (ids: string[]) => ids.map((id) => `tile:${id}`);

const leaf = (id: string): MosaicNode => ({ kind: "leaf", id });
const evenly = (n: number) => Array.from({ length: n }, () => 100 / n);

/** The node at `path` (the root for `[]`). */
const nodeAtPath = (root: MosaicNode, path: number[]) =>
  path.reduce<MosaicNode>((n, i) => (n.kind === "split" ? n.children[i] : n), root);

/** Sizes of the split at `path` that differ from its current ones and match its child count. */
function resizedSizes(root: MosaicNode, path: number[]): number[] {
  const node = nodeAtPath(root, path);
  if (node.kind !== "split") throw new Error("not a split");
  const n = node.children.length;
  return node.children.map((_, i) => (i === 0 ? 40 : 60 / (n - 1)));
}

/** Eight tiles in a custom mosaic: two rows, the second holding w3, w4 and a nested split of
 *  w5-w8 right of w4, where w9 will be inserted. */
function seedNestedMosaic() {
  const row = (children: MosaicNode[]): MosaicNode => ({
    kind: "split",
    axis: "row",
    children,
    sizes: evenly(children.length),
  });
  const column = (children: MosaicNode[]): MosaicNode => ({
    kind: "split",
    axis: "column",
    children,
    sizes: evenly(children.length),
  });
  const root = column([
    row([leaf("w1"), leaf("w2")]),
    row([leaf("w3"), leaf("w4"), column([leaf("w5"), leaf("w6"), row([leaf("w7"), leaf("w8")])])]),
  ]);
  useViewerStore.setState((st) => ({
    foregroundLayout: {
      ...st.foregroundLayout,
      [TEAM]: { sizes: [], direction: "row", preset: "custom", root },
    },
  }));
}

describe("the frame probe on today's CLI workspace (8 tiles)", () => {
  it("adding a tile draws only the new tile and the split it joins", async () => {
    seedNestedMosaic();
    renderApp();
    await flush();
    expect(probe.mounted("tile:")).toEqual(frames(TILES).sort());
    probe.reset();
    const constructed = h.created;

    act(() => {
      addWorkspace(TEAM, NEW_TILE);
      s().placeWorkspaceTile(TEAM, NEW_TILE, {
        targetWorkspaceId: "w4",
        axis: "row",
        side: "after",
      });
    });
    await flush();

    const root = currentRoot();
    const touched = new Set([NEW_TILE, ...leavesUnder(root, parentPathOf(root, "w4") ?? [])]);
    const outside = TILES.filter((id) => !touched.has(id));
    expect(outside.length).toBeGreaterThan(0);
    expect(probe.rendered("tile:").filter((id) => outside.includes(id.slice(5)))).toEqual([]);
    expect(probe.mounted("tile:").filter((id) => outside.includes(id.slice(5)))).toEqual([]);
    // The tiles whose index in the split shifted (a nested split among them) stay mounted.
    expect(probe.mounted("tile:")).toEqual(frames([NEW_TILE]));
    expect(probe.mounts.get(`tile:${NEW_TILE}`)).toBe(1);
    // Not the proof (the frame holds no terminal), but the display count is exactly one more.
    expect(h.created - constructed).toBe(1);
  });

  it("committing one split's sizes draws no frame outside that split and mounts none", async () => {
    seedNestedMosaic();
    renderApp();
    await flush();
    act(() => {
      addWorkspace(TEAM, NEW_TILE);
      s().placeWorkspaceTile(TEAM, NEW_TILE, {
        targetWorkspaceId: "w4",
        axis: "row",
        side: "after",
      });
    });
    await flush();
    const root = currentRoot();
    const path = parentPathOf(root, NEW_TILE)!;
    const split = path.reduce<MosaicNode>((n, i) => (n.kind === "split" ? n.children[i] : n), root);
    expect(split.kind).toBe("split");
    const inside = leavesUnder(root, path);
    probe.reset();

    const sizes = resizedSizes(root, path);
    expect(sizes).toHaveLength((split as { children: MosaicNode[] }).children.length);
    expect(sizes).not.toEqual((split as { sizes: number[] }).sizes);

    act(() => s().setForegroundNodeSizes(TEAM, path, sizes));
    await flush();

    // The commit landed, so the assertions below can fail.
    expect((nodeAtPath(currentRoot(), path) as { sizes: number[] }).sizes).toEqual(sizes);
    expect(probe.mounted("tile:")).toEqual([]);
    expect(probe.rendered("tile:").filter((id) => !inside.includes(id.slice(5)))).toEqual([]);
  });

  it("moving focus draws exactly the tile that lost it and the tile that gained it", async () => {
    renderApp();
    await flush();
    probe.reset();

    act(() => s().switchWorkspace(TEAM, "w5"));
    await flush();

    expect(probe.rendered("tile:")).toEqual(frames(["w1", "w5"]));
    expect(probe.mounted("tile:")).toEqual([]);
  });
});

describe("the subscription probe: no hook of an unrelated tile changes", () => {
  /** Every hook-and-tile pair that changed identity, for tiles outside `involved`. */
  const unrelatedChanges = (involved: string[]) =>
    Object.entries(h.changes).flatMap(([hook, byId]) =>
      Object.keys(byId)
        .filter((id) => !involved.some((w) => id === w || id.endsWith(w) || id.includes(`${w}`)))
        .map((id) => `${hook}:${id}`),
    );

  it("holds for an add, a focus move and a sizes commit", async () => {
    renderApp();
    await flush();
    h.changes = {};

    act(() => s().switchWorkspace(TEAM, "w5"));
    await flush();
    expect(unrelatedChanges(["w1", "w5"])).toEqual([]);

    h.changes = {};
    act(() => {
      addWorkspace(TEAM, NEW_TILE);
      s().placeWorkspaceTile(TEAM, NEW_TILE, {
        targetWorkspaceId: "w4",
        axis: "row",
        side: "after",
      });
    });
    await flush();
    const root = currentRoot();
    const touched = [NEW_TILE, ...leavesUnder(root, parentPathOf(root, "w4") ?? [])];
    expect(unrelatedChanges(touched)).toEqual([]);

    h.changes = {};
    const path = parentPathOf(root, NEW_TILE)!;
    const sizes = resizedSizes(root, path);
    act(() => s().setForegroundNodeSizes(TEAM, path, sizes));
    await flush();
    expect((nodeAtPath(currentRoot(), path) as { sizes: number[] }).sizes).toEqual(sizes);
    expect(unrelatedChanges(touched)).toEqual([]);
  });
});

describe("the tab grid's cells", () => {
  const cells = (ids: string[]) => ids.map((id) => `cell:w1/${id}`).sort();

  async function openGrid() {
    renderApp();
    act(() => s().expandWorkspace(TEAM, "w1"));
    act(() => s().gridAllTerminalTabs(TEAM, "w1"));
    await flush();
    expect(probe.mounted("cell:")).toEqual(cells(GRID_TABS));
    probe.reset();
  }

  it("a tab add draws only the new cell and its neighbours, and mounts only the new one", async () => {
    await openGrid();
    act(() => {
      h.server.open("g5");
      seedTerminalTabs(TEAM, "w1", ["g5"], { paned: [...GRID_TABS, "g5"], preset: "columns" });
    });
    await flush();
    expect(probe.mounted("cell:")).toEqual(cells(["g5"]));
    // The cell before the new one now has it as its close-neighbour; the three before that, and
    // every cell's place in the column, are untouched.
    expect(
      probe.rendered("cell:").filter((id) => !["cell:w1/g4", "cell:w1/g5"].includes(id)),
    ).toEqual([]);
  });

  it("committing a grid split's sizes draws and mounts no cell", async () => {
    await openGrid();
    const root = reconcilePresetTree(undefined, "columns", GRID_TABS, Infinity, Infinity)!;
    act(() => s().setTabGridSizes(TEAM, "w1", "columns", root, [], [10, 20, 30, 40]));
    await flush();
    const saved = Object.values(s().tabGridLayout).map((entry) => entry.root);
    expect(saved.map((node) => (node as { sizes: number[] }).sizes)).toEqual([[10, 20, 30, 40]]);
    expect(probe.rendered("cell:")).toEqual([]);
    expect(probe.mounted("cell:")).toEqual([]);
  });

  it("moving focus between cells draws only the two cells", async () => {
    await openGrid();
    act(() => s().setActiveTerminalTab(TEAM, "g3", "w1"));
    await flush();
    expect(probe.rendered("cell:")).toEqual(cells(["g1", "g3"]));
    expect(probe.mounted("cell:")).toEqual([]);
  });
});

describe("a drag in progress", () => {
  const handleOf = (id: string) =>
    document.querySelector<HTMLElement>(`[data-pane-id="${id}"] > div`)!;
  const zonesOn = (id: string) =>
    [...document.querySelectorAll(`[data-testid="tile-zones-${id}"] [data-drop-side]`)].map(
      (zone) => zone.getAttribute("data-drop-side"),
    );

  it("shows zones on every other tile, none on its own, and clears them on cancel", async () => {
    renderApp();
    await flush();
    expect(zonesOn("w2")).toEqual([]);
    probe.reset();

    handleOf("w1").focus();
    fireEvent.keyDown(handleOf("w1"), { code: "Space", key: " " });
    await flush();

    expect(zonesOn("w1")).toEqual([]);
    // w2 is w1's right neighbour in the first row: dropping w1 on w2's left edge changes nothing,
    // so that one zone is not offered and the other three are.
    expect(zonesOn("w2").sort()).toEqual(["bottom", "right", "top"]);
    for (const id of TILES.slice(2)) expect(zonesOn(id).length, id).toBeGreaterThan(0);
    // A drag start may redraw every frame (a per-tile zone subscription would end that): the
    // bound is that none mounts.
    expect(probe.mounted("tile:")).toEqual([]);

    probe.reset();
    fireEvent.keyDown(document, { code: "Escape", key: "Escape" });
    await flush();
    for (const id of TILES) expect(zonesOn(id), id).toEqual([]);
    expect(probe.mounted("tile:")).toEqual([]);
  });

  it("drops on a shown zone and the tile lands on that side", async () => {
    renderApp();
    await flush();
    handleOf("w1").focus();
    fireEvent.keyDown(handleOf("w1"), { code: "Space", key: " " });
    await flush();
    expect(zonesOn("w2")).toContain("right");

    // The drop the workbench's DndContext would deliver for that zone.
    const drop = dragEnd.current!;
    act(() =>
      drop({
        active: { id: "w1" },
        over: { id: tileZoneId("w2", "right") },
      } as unknown as DragEndEvent),
    );
    fireEvent.keyDown(document, { code: "Escape", key: "Escape" });
    await flush();

    const root = currentRoot();
    const siblings = leavesUnder(root, parentPathOf(root, "w2")!);
    expect(siblings.indexOf("w1")).toBe(siblings.indexOf("w2") + 1);
    for (const id of TILES) expect(zonesOn(id), id).toEqual([]);
  });
});

describe("a team switch (a warm team's tiles stay mounted)", () => {
  it("mounts no frame of either team's tiles", async () => {
    for (const id of ["x1", "x2"]) addWorkspace(TEAM_B, id);
    useViewerStore.setState((st) => ({
      activeWorkspace: { ...st.activeWorkspace, [TEAM_B]: "x1" },
    }));
    const view = (hiddenB: boolean) => (
      <DndContext>
        <DisplayWarm />
        <div data-xterm-host data-repo-path="/repo">
          <WorkspaceTerminalPanels
            teamKey={TEAM}
            repoPath="/repo"
            teamHidden={!hiddenB}
            frameProbe={probe}
          />
          <WorkspaceTerminalPanels
            teamKey={TEAM_B}
            repoPath="/repo"
            teamHidden={hiddenB}
            frameProbe={probe}
          />
        </div>
      </DndContext>
    );
    const { rerender } = render(view(true));
    await flush();
    expect(probe.mounted("tile:").length).toBe(TILES.length + 2);
    probe.reset();

    // The active team moves with the props, as the workbench's switch does.
    act(() => useOrgStore.setState({ activeTeamName: "other" }));
    rerender(view(false));
    await flush();
    act(() => useOrgStore.setState({ activeTeamName: "default" }));
    rerender(view(true));
    await flush();

    expect(probe.mounted("tile:")).toEqual([]);
  });
});
