// SPDX-License-Identifier: MIT
import { useOrgStore } from "./org-store";
import { describe, it, expect, beforeEach, vi } from "vitest";

// With the tiles flag on, every layout change the store makes reaches the layout client's
// saveLayout, so a relaunch reads it back from the group file: a preset change, a focused-leaf
// replace, a terminal re-key that moves a tab grid to a new key and a team rename that moves
// the team's foreground to its new key.

vi.mock("@/tauri/commands", () => ({
  saveAppState: vi.fn().mockResolvedValue(undefined),
  loadAppState: vi.fn().mockResolvedValue("{}"),
  listNotes: vi.fn().mockResolvedValue([]),
  readNote: vi
    .fn()
    .mockResolvedValue({ id: "n1", title: "Scratch", pinned: false, lastOpenedAt: 0, content: "" }),
  createNote: vi.fn().mockResolvedValue({
    id: "n2",
    title: "Untitled",
    pinned: false,
    lastOpenedAt: 0,
    content: "",
  }),
  writeNote: vi.fn().mockResolvedValue(undefined),
  updateNoteMeta: vi
    .fn()
    .mockResolvedValue({ id: "n1", title: "Scratch", pinned: false, lastOpenedAt: 0 }),
  deleteNote: vi.fn().mockResolvedValue([]),
  pushViewerState: vi.fn().mockResolvedValue(undefined),
  checkPathExists: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/shared/lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  initLogging: vi.fn().mockResolvedValue(undefined),
}));

const client = vi.hoisted(() => ({ saveLayout: vi.fn() }));
vi.mock("@/shared/stores/layout-store-client", async (actual) => ({
  ...(await actual<typeof import("./layout-store-client")>()),
  saveLayout: client.saveLayout,
}));

import {
  useViewerStore,
  effectiveMosaicRoot,
  selectWorkspaceKey,
  teamTileOrder,
  type SoftClosedWorkspace,
  type Workspace,
} from "./viewer-store";
import { seedTerminalTabs, installTerminalLayoutHarness } from "@/test/terminal-layout-harness";
import { foregroundTilesFor } from "@/features/viewer/lib/foreground-tiles";
import { leafWorkspaceIds, type MosaicNode } from "@/shared/tiling";

const TEAM = "acme:default";
const A = "e-1-a";
const B = "e-1-b";
const M = "e-1-minimized";

installTerminalLayoutHarness();

const ws = (id: string): Workspace => ({ id, kind: "story", cwd: `/${id}`, status: "ready" });
const shadow = (id: string): SoftClosedWorkspace => ({ workspace: ws(id) });

/** The foreground tree the team shows now. */
const shownRoot = () => {
  const s = useViewerStore.getState();
  const ids = foregroundTilesFor(s.workspaces[TEAM] ?? [], teamTileOrder(s, TEAM)).map((w) => w.id);
  return effectiveMosaicRoot(s.foregroundLayout[TEAM], ids);
};

/** The last saveLayout call: its target, tree and gesture. */
const lastSave = () => client.saveLayout.mock.calls.at(-1) as [unknown, MosaicNode | null, unknown];

beforeEach(() => {
  useOrgStore.setState({ activeOrgSlug: "acme", activeTeamName: "default" });
  useViewerStore.setState({
    foregroundLayout: {},
    foregroundLayoutByRail: {},
    activeWorkspace: { [TEAM]: A },
    workspaces: { [TEAM]: [ws(A), ws(B)] },
    softClosedWorkspaces: { [TEAM]: { [M]: shadow(M) } },
    tabGridLayout: {},
  });
  for (const id of [A, B, M]) seedTerminalTabs(TEAM, id, [`sess-${id}`]);
  vi.clearAllMocks();
});

describe("a layout change the store makes is saved to its group file", () => {
  it("a preset change saves the tree the preset lays out", () => {
    useViewerStore.getState().setForegroundPreset(TEAM, "rows");
    expect(client.saveLayout).toHaveBeenCalledTimes(1);
    const [target, root, gesture] = lastSave();
    expect(target).toEqual({ kind: "foreground", teamKey: TEAM, railKey: null });
    expect(root).toEqual(shownRoot());
    expect(leafWorkspaceIds(root)).toEqual([A, B]);
    expect(gesture).toBeUndefined();
  });

  it("a focused-leaf replace saves the swapped tree as one replace op", () => {
    useViewerStore.getState().replaceFocusedLeafWorkspace(TEAM, M);
    expect(client.saveLayout).toHaveBeenCalledTimes(1);
    const [target, root, gesture] = lastSave();
    expect(target).toEqual({ kind: "foreground", teamKey: TEAM, railKey: null });
    expect(root).toEqual(shownRoot());
    expect(leafWorkspaceIds(root)).toContain(M);
    expect(gesture).toEqual({ op: "replace", from: A, to: M });
  });

  it("a team rename saves each tab grid under the workspace's new key", () => {
    const grid: MosaicNode = {
      kind: "split",
      axis: "row",
      sizes: [50, 50],
      children: [
        { kind: "leaf", id: "tab-1" },
        { kind: "leaf", id: "tab-2" },
      ],
    };
    const before = selectWorkspaceKey(useViewerStore.getState(), TEAM, A);
    useViewerStore.setState({ tabGridLayout: { [before]: { preset: "grid", root: grid } } });
    useViewerStore.getState().rekeyTeam("acme", "default", "renamed");
    const [after] = Object.keys(useViewerStore.getState().tabGridLayout);
    expect(after).not.toBe(before);
    expect(client.saveLayout).toHaveBeenCalledWith({ kind: "tabGrid", workspaceKey: after }, grid);
  });

  it("a team rename saves the team's foreground under its new key", () => {
    useViewerStore.getState().setForegroundPreset(TEAM, "rows");
    const root = shownRoot();
    client.saveLayout.mockClear();
    useViewerStore.getState().rekeyTeam("acme", "default", "renamed");
    expect(client.saveLayout).toHaveBeenCalledWith(
      { kind: "foreground", teamKey: "acme:renamed", railKey: null },
      root,
    );
  });
});
