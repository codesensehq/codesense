// SPDX-License-Identifier: MIT
/**
 * A window's layout is re-seeded from its group file: at launch (`hydrateLayouts` replaces the
 * restored tree with the head), on a conflict (the head is shown again), when a commit's reply
 * skips a rev, and when another writer's head arrives on the live hub's `group` view. Each
 * re-seed hands the host new node objects; the host keys bodies by leaf id, so an equal-keyed
 * head removes, inserts and renders no body.
 */
import { act, render } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseMosaicNode, serializeMosaicNode, type MosaicNode } from "./mosaic-tree";
import { TileHost, type TileBodyContext } from "./tile-host";
import { bodyCounts, FakeBody, leaf, row, split } from "./tile-host.test-util";

const commands = vi.hoisted(() => ({ groupRead: vi.fn(), groupCommit: vi.fn() }));
vi.mock("@/tauri/commands", () => commands);
/** The live hub's `watch`, keeping each callback so a test can hand it a view. */
const hub = vi.hoisted(() => {
  const watches: Array<{ topic: string; viewKey: string; callback: (view: unknown) => void }> = [];
  return {
    watches,
    watch: vi.fn((topic: string, viewKey: string, callback: (view: unknown) => void) => {
      watches.push({ topic, viewKey, callback });
      return () => {};
    }),
  };
});
vi.mock("@/features/dashboard/lib/live-hub", () => ({ liveHub: { watch: hub.watch } }));
vi.mock("@/shared/lib/tiles-enabled", () => ({ tilesEnabled: () => Promise.resolve(true) }));
vi.mock(
  "@/components/ui/resizable",
  async () => (await import("./tile-host.test-util")).resizableMock,
);

import {
  hydrateLayouts,
  layoutFileRef,
  resetLayoutClientForTests,
  saveLayout,
  type LayoutSlices,
  type LayoutTarget,
} from "@/shared/stores/layout-store-client";

const TEAM = "acme:app";
const FG: LayoutTarget = { kind: "foreground", teamKey: TEAM, railKey: null };
const TREE = split("row", [leaf("ws-a"), split("column", [leaf("ws-b"), leaf("doc:core/x.md")])]);

/** The window's slices, with a listener for the host to read the foreground tree from. */
function windowSlices(root: MosaicNode) {
  let state = {
    workspaces: { [TEAM]: [] },
    foregroundLayout: { [TEAM]: { sizes: [], direction: "row", preset: "custom", root } },
    foregroundLayoutByRail: {},
    tabGridLayout: {},
  } as unknown as LayoutSlices;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (update: (s: LayoutSlices) => Partial<LayoutSlices>) => {
      state = { ...state, ...update(state) };
      listeners.forEach((changed) => changed());
    },
    subscribe: (changed: () => void) => {
      listeners.add(changed);
      return () => listeners.delete(changed);
    },
  };
}

const counts = bodyCounts();
const renderBody = (key: string, context: TileBodyContext) => (
  <FakeBody tileKey={key} context={context} counts={counts} />
);

function Window({ slices }: { slices: ReturnType<typeof windowSlices> }) {
  const state = useSyncExternalStore(slices.subscribe, slices.get);
  const root = state.foregroundLayout[TEAM]?.root ?? null;
  return (
    <TileHost
      node={root}
      renderBody={renderBody}
      onSizesCommit={() => {}}
      renderProbe={counts.probe}
    />
  );
}

/** Mounts the window and counts only what later steps touch, with the bodies' DOM nodes. */
function mount(root: MosaicNode) {
  const slices = windowSlices(root);
  const view = render(<Window slices={slices} />);
  const nodes = () =>
    new Map(
      [...view.container.querySelectorAll<HTMLElement>("[data-tile-body]")].map((el) => [
        el.dataset.tileBody!,
        el,
      ]),
    );
  const before = nodes();
  counts.reset();
  return { slices, nodes, before };
}

/** Lets the client's queued steps run. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });
}

/** A head with the same keys as `root`: every node object new. */
const head = (rev: number, root: MosaicNode) => ({
  rev,
  tree: serializeMosaicNode(parseMosaicNode(serializeMosaicNode(root))),
});

beforeEach(() => {
  resetLayoutClientForTests();
  commands.groupRead.mockReset();
  commands.groupCommit.mockReset();
  hub.watches.length = 0;
  counts.reset();
});
afterEach(() => resetLayoutClientForTests());

describe("a re-seed from the group file moves no body", () => {
  it("the launch hydrate replaces the restored tree with an equal-keyed head", async () => {
    commands.groupRead.mockResolvedValue(head(3, TREE));
    const { slices, nodes, before } = mount(TREE);
    const restored = slices.get().foregroundLayout[TEAM].root;
    await act(() => hydrateLayouts(slices.get(), slices.set));
    await settle();
    // The head replaced the restored tree: new objects, the same keys.
    expect(slices.get().foregroundLayout[TEAM].root).not.toBe(restored);
    expect(nodes()).toEqual(before);
    expect(counts.mounts).toEqual({});
    expect(counts.unmounts).toEqual({});
    expect(counts.renders).toEqual({});
  });

  it("a conflict reload shows the head again with the same keys and moves nothing", async () => {
    commands.groupRead.mockResolvedValue(head(1, TREE));
    const { slices, nodes, before } = mount(TREE);
    await act(() => hydrateLayouts(slices.get(), slices.set));
    await settle();
    counts.reset();
    // An agent's write touched the same tiles: the window drops the op and shows the head.
    commands.groupCommit.mockResolvedValue({
      conflict: { currentRevision: 2, collided: ["ws-a"] },
    });
    commands.groupRead.mockResolvedValue(head(2, TREE));
    const shownBefore = slices.get().foregroundLayout[TEAM].root;
    saveLayout(FG, row("ws-a", "ws-b"), { op: "close", leafId: "doc:core/x.md" });
    await settle();
    expect(commands.groupCommit).toHaveBeenCalledTimes(1);
    expect(slices.get().foregroundLayout[TEAM].root).not.toBe(shownBefore);
    expect(nodes()).toEqual(before);
    expect(counts.mounts).toEqual({});
    expect(counts.unmounts).toEqual({});
    expect(counts.renders).toEqual({});
  });

  it("another writer's rev that adds one leaf mounts exactly one body", async () => {
    commands.groupRead.mockResolvedValue(head(1, TREE));
    const { slices, nodes, before } = mount(TREE);
    await act(() => hydrateLayouts(slices.get(), slices.set));
    await settle();
    counts.reset();
    // The reply skips a rev, so the window re-reads the head, which another writer grew.
    const grown = split("row", [
      leaf("ws-a"),
      split("column", [leaf("ws-b"), leaf("doc:core/x.md")]),
      leaf("agent:team-2/review.bot_1"),
    ]);
    commands.groupCommit.mockResolvedValue({ rev: 3 });
    commands.groupRead.mockResolvedValue(head(3, grown));
    saveLayout(FG, row("ws-a", "ws-b"), { op: "close", leafId: "doc:core/x.md" });
    await settle();
    expect(counts.mounts).toEqual({ "agent:team-2/review.bot_1": 1 });
    expect(counts.renders).toEqual({ "agent:team-2/review.bot_1": 1 });
    expect(counts.unmounts).toEqual({});
    for (const [key, node] of before) expect(nodes().get(key)).toBe(node);
  });

  it("another writer's head on the hub's group view mounts only its new leaf", async () => {
    commands.groupRead.mockResolvedValue(head(1, TREE));
    const { slices, nodes, before } = mount(TREE);
    await act(() => hydrateLayouts(slices.get(), slices.set));
    await settle();
    counts.reset();
    const { org, file } = await layoutFileRef(FG);
    const live = hub.watches.filter(
      (w) => w.topic === "group" && w.viewKey === `${org}:${file.id}`,
    );
    expect(live).toHaveLength(1);
    const grown = split("row", [
      leaf("ws-a"),
      split("column", [leaf("ws-b"), leaf("doc:core/x.md")]),
      leaf("agent:team-2/review.bot_1"),
    ]);
    const { rev, tree } = head(2, grown);
    live[0].callback({ snapshot: [{ id: file.id, file: { rev, root: tree }, dropped: [] }] });
    await settle();
    expect(counts.mounts).toEqual({ "agent:team-2/review.bot_1": 1 });
    expect(counts.renders).toEqual({ "agent:team-2/review.bot_1": 1 });
    expect(counts.unmounts).toEqual({});
    for (const [key, node] of before) expect(nodes().get(key)).toBe(node);
  });
});
