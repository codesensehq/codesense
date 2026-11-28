// SPDX-License-Identifier: MIT
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";

import { MosaicView, type MosaicRenderProbe } from "@/shared/tiling/mosaic-view";
import {
  serializeMosaicNode,
  setNodeSizes,
  splitAt,
  type MosaicNode,
} from "@/shared/tiling/mosaic-tree";

const commands = vi.hoisted(() => ({ groupRead: vi.fn(), groupCommit: vi.fn() }));
/** The host's live hub, with only its native `watch`. */
const hub = vi.hoisted(() => ({
  watches: [] as Array<{
    topic: string;
    viewKey: string;
    callback: (snapshot: {
      topic: string;
      viewKey: string;
      rev: number;
      snapshot: unknown[];
    }) => void;
  }>,
}));

vi.mock("@/tauri/commands", () => commands);
vi.mock("@/shared/lib/tiles-enabled", () => ({ tilesEnabled: () => Promise.resolve(true) }));
vi.mock("@/features/dashboard/lib/live-hub", () => ({
  liveHub: {
    watch: (topic: string, viewKey: string, callback: (typeof hub.watches)[number]["callback"]) => {
      hub.watches.push({ topic, viewKey, callback });
      return () => {};
    },
  },
}));
// The resizable wrapper as plain divs: the library's measuring isn't available here.
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: any) => <div>{children}</div>,
  ResizablePanel: ({ children }: any) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}));

import {
  hydrateLayouts,
  layoutFileRef,
  resetLayoutClientForTests,
  type LayoutSlices,
  type LayoutTarget,
} from "./layout-store-client";

const leaf = (id: string): MosaicNode => ({ kind: "leaf", id });
const split = (axis: "row" | "column", children: MosaicNode[], sizes: number[]): MosaicNode => ({
  kind: "split",
  axis,
  children,
  sizes,
});

const TEAM = "acme:app";
const FG: LayoutTarget = { kind: "foreground", teamKey: TEAM, railKey: null };
const GRID: LayoutTarget = { kind: "tabGrid", workspaceKey: `${TEAM}|ws-1` };
/** row[ a, column[b, c] ] */
const TREE = split(
  "row",
  [leaf("ws-a"), split("column", [leaf("ws-b"), leaf("ws-c")], [50, 50])],
  [40, 60],
);

let splitRenders: Record<string, number>;
let leafRenders: Record<string, number>;
const probe: MosaicRenderProbe = (key, phase) => {
  if (phase === "render") splitRenders[key] = (splitRenders[key] ?? 0) + 1;
};
const renderLeaf = (id: string): ReactNode => {
  leafRenders[id] = (leafRenders[id] ?? 0) + 1;
  return <div data-testid={`cell-${id}`}>{id}</div>;
};

/** The team's foreground, the one layout mounted; its selector hands the view only its root. */
function Foreground({ store }: { store: ReturnType<typeof makeStore> }) {
  const root = store((s) => s.foregroundLayout[TEAM]?.root ?? null);
  return (
    <MosaicView node={root} renderLeaf={renderLeaf} onSizesCommit={() => {}} renderProbe={probe} />
  );
}

function makeStore() {
  return create<LayoutSlices>(
    () =>
      ({
        workspaces: { [TEAM]: [] },
        foregroundLayout: {},
        foregroundLayoutByRail: {},
        tabGridLayout: { [`${TEAM}|ws-1`]: { preset: "grid", root: TREE } },
      }) as unknown as LayoutSlices,
  );
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Hands the `group` watch of `target`'s file the file at `rev` holding `root`. */
async function deliver(target: LayoutTarget, rev: number, root: MosaicNode) {
  const { org, file } = await layoutFileRef(target);
  const watch = hub.watches.find((w) => w.topic === "group" && w.viewKey === `${org}:${file.id}`)!;
  await act(async () => {
    watch.callback({
      topic: "group",
      viewKey: watch.viewKey,
      rev: 1,
      snapshot: [
        {
          id: file.id,
          file: { version: 2, owner: file.owner, rev, root: serializeMosaicNode(root) },
          dropped: [],
        },
      ],
    });
    await settle();
  });
}

/** Mounts the foreground on the hydrated store, then counts only what later deltas touch. */
async function mounted() {
  const store = makeStore();
  await act(async () => {
    await hydrateLayouts(store.getState(), (update) => store.setState(update(store.getState())));
  });
  splitRenders = {};
  leafRenders = {};
  render(<Foreground store={store} />);
  const [root, column] = Object.keys(splitRenders);
  splitRenders = {};
  leafRenders = {};
  return { root, column };
}

beforeEach(() => {
  resetLayoutClientForTests();
  hub.watches.length = 0;
  commands.groupRead.mockReset().mockResolvedValue({ rev: 3, tree: serializeMosaicNode(TREE) });
  commands.groupCommit.mockReset();
});

describe("a group delta reaches only mounted tiles", () => {
  it("one for a layout that is not mounted changes none of the mounted tiles' props", async () => {
    await mounted();
    await deliver(GRID, 4, setNodeSizes(TREE, [], [10, 90]));
    expect(splitRenders).toEqual({});
    expect(leafRenders).toEqual({});
  });

  it("one with the tree the window shows renders nothing", async () => {
    await mounted();
    await deliver(FG, 4, TREE);
    expect(splitRenders).toEqual({});
    expect(leafRenders).toEqual({});
  });

  it("one resizing a split of the mounted layout renders that split and the root, no tile", async () => {
    const { root, column } = await mounted();
    await deliver(FG, 4, setNodeSizes(TREE, [1], [30, 70]));
    expect(Object.keys(splitRenders).sort()).toEqual([root, column].sort());
    expect(leafRenders).toEqual({});
  });

  it("one adding a tile to the mounted layout shows it", async () => {
    await mounted();
    await deliver(FG, 4, splitAt(TREE, "ws-c", "row", "after", "ws-d"));
    expect(screen.getByTestId("cell-ws-d")).toBeTruthy();
    // ws-c moves under the new split; the other tiles keep their props.
    expect(leafRenders["ws-d"]).toBe(1);
    expect(leafRenders["ws-a"]).toBeUndefined();
    expect(leafRenders["ws-b"]).toBeUndefined();
    expect(commands.groupCommit).not.toHaveBeenCalled();
  });
});
