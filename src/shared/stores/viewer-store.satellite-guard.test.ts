// SPDX-License-Identifier: MIT
import "@/test/prefs-state-fixture";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { applyOwnedViewerPrefs, useViewerStore, type ViewerState } from "./viewer-store";
import { useOrgStore } from "./org-store";
import * as commands from "@/tauri/commands";
import { logger } from "@/shared/lib/logger";
import { canonicalItemKey, itemKeyForTab } from "@/shared/windows/item-key";
import {
  applyOwnerMap,
  resetOwnerMapForTests,
  satelliteOwnedTabs,
} from "@/shared/windows/owner-map";
import type { WindowSlice } from "@/shared/windows/window-slice";
import { AGENTS_VIRTUAL_PATH } from "@/features/agents/agents-virtual-tab";
import { retiredRoutinesTabs } from "@/features/routines/routines-virtual-tab";

// `main` never shows a tab a satellite holds: every writer of `openTabs` goes through the
// store's one guard. K is the satellite-owned tab in every row below.

vi.mock("@/tauri/commands", () => ({
  saveAppState: vi.fn().mockResolvedValue(undefined),
  loadAppState: vi.fn().mockResolvedValue("{}"),
  pushViewerState: vi.fn().mockResolvedValue(undefined),
  listNotes: vi.fn().mockResolvedValue([]),
  readNote: vi.fn(),
  createNote: vi.fn(),
  writeNote: vi.fn().mockResolvedValue(undefined),
  updateNoteMeta: vi.fn(),
  deleteNote: vi.fn().mockResolvedValue([]),
  saveScratchNote: vi.fn().mockResolvedValue(undefined),
  loadScratchNote: vi.fn().mockResolvedValue(""),
  checkPathExists: vi.fn().mockResolvedValue(true),
  detectTools: vi.fn().mockResolvedValue({
    terminals: [],
    editors: [],
    default_terminal: "",
    default_editor: "",
  }),
  windowGetSlice: vi.fn(),
  windowFocusOwner: vi.fn().mockResolvedValue("sat-1"),
}));

const loadAppStateMock = commands.loadAppState as ReturnType<typeof vi.fn>;
const windowGetSliceMock = commands.windowGetSlice as ReturnType<typeof vi.fn>;
const windowFocusOwnerMock = commands.windowFocusOwner as ReturnType<typeof vi.fn>;

const TEAM = "acme:default";
const TEAM_B = "acme:other";
const REPO = "/repo";
const K = "/repo/k.md";
const A = "/repo/a.md";
const B = "/repo/b.md";
const K_KEY = itemKeyForTab(TEAM, { path: K });

const tab = (path: string, preview = false) => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  ...(preview ? { preview: true } : {}),
});

function own(team = TEAM, path = K): void {
  applyOwnerMap({ [canonicalItemKey(itemKeyForTab(team, { path }))]: "sat-1" });
}

function mainSlice(owners: Record<string, string>): WindowSlice {
  return {
    label: "main",
    kind: "main",
    version: 2,
    layoutRef: null,
    items: [],
    pending: false,
    owners,
  };
}

const paths = (team = TEAM) => (useViewerStore.getState().openTabs[team] ?? []).map((t) => t.path);
const active = (team = TEAM) => useViewerStore.getState().activeTab[team];

/** Every state a subscriber saw that shows a satellite-owned tab `main` has no unsaved
 *  edit for. Must stay empty in every row. */
let leaks: string[] = [];
let unsubscribe: () => void = () => {};

function satelliteTabsIn(s: ViewerState): string[] {
  const found: string[] = [];
  for (const [team, owned] of satelliteOwnedTabs()) {
    const dirty = s.editingDirtyPaths[team] ?? [];
    for (const t of s.openTabs[team] ?? []) {
      if (owned.has(t.path) && !dirty.includes(t.path)) found.push(`${team} ${t.path}`);
    }
    const a = s.activeTab[team];
    if (a !== undefined && owned.has(a) && !dirty.includes(a)) found.push(`${team} active ${a}`);
  }
  return found;
}

beforeEach(() => {
  resetOwnerMapForTests();
  loadAppStateMock.mockReset().mockResolvedValue("{}");
  windowGetSliceMock.mockReset().mockRejectedValue(new Error("no registry"));
  windowFocusOwnerMock.mockReset().mockResolvedValue("sat-1");
  useOrgStore.setState({ activeOrgSlug: null, activeTeamName: null, workspaceRepos: {} });
  useViewerStore.setState({
    openTabs: { [TEAM]: [tab(A), tab(B)] },
    activeTab: { [TEAM]: A },
    editingDirtyPaths: {},
  });
  leaks = [];
  unsubscribe = useViewerStore.subscribe((s) => leaks.push(...satelliteTabsIn(s)));
});

afterEach(() => {
  unsubscribe();
  expect(leaks).toEqual([]);
});

describe("guard routes: each ends without K @P1", () => {
  beforeEach(() => {
    own();
    useViewerStore.setState({ stateLoaded: true });
  });
  afterEach(() => useViewerStore.setState({ stateLoaded: false }));

  it("openFile(K): no K, activeTab unchanged, owner focused", () => {
    useViewerStore.getState().openFile(TEAM, REPO, K);
    expect(paths()).toEqual([A, B]);
    expect(active()).toBe(A);
    expect(windowFocusOwnerMock).toHaveBeenCalledWith(K_KEY);
  });

  it("openFile(K) with the previous active tab gone deletes the pointer", () => {
    useViewerStore.setState({ activeTab: {} });
    useViewerStore.getState().openFile(TEAM, REPO, K);
    expect(paths()).toEqual([A, B]);
    expect(active()).toBeUndefined();
    expect(windowFocusOwnerMock).toHaveBeenCalledTimes(1);
  });

  it("openFilePreview(K) swap: no K, no focus", () => {
    useViewerStore.setState({ openTabs: { [TEAM]: [tab(A), tab(B, true)] } });
    useViewerStore.getState().openFilePreview(TEAM, REPO, K);
    expect(paths()).not.toContain(K);
    expect(active()).toBe(A);
    expect(windowFocusOwnerMock).not.toHaveBeenCalled();
  });

  it("openFilePreview(K) swap with [A, B(preview)] and B active restores B and its pointer", () => {
    useViewerStore.setState({
      openTabs: { [TEAM]: [tab(A), tab(B, true)] },
      activeTab: { [TEAM]: B },
    });
    useViewerStore.getState().openFilePreview(TEAM, REPO, K);
    expect(useViewerStore.getState().openTabs[TEAM]).toEqual([tab(A), tab(B, true)]);
    expect(active()).toBe(B);
    expect(windowFocusOwnerMock).not.toHaveBeenCalled();
  });

  it("a refused open leaves navHistory and navIndex unchanged", () => {
    const navHistory = { [TEAM]: [A, B] };
    const navIndex = { [TEAM]: 0 };
    useViewerStore.setState({ navHistory, navIndex });
    useViewerStore.getState().openFile(TEAM, REPO, K);
    useViewerStore.getState().openFilePreview(TEAM, REPO, K);
    expect(useViewerStore.getState().navHistory).toEqual(navHistory);
    expect(useViewerStore.getState().navIndex).toEqual(navIndex);
  });

  it("navigateBack steps past a satellite-owned entry to the next one main can show", () => {
    const X = "/repo/x.md";
    useViewerStore.setState({ navHistory: { [TEAM]: [X, K, A] }, navIndex: { [TEAM]: 2 } });
    useViewerStore.getState().navigateBack(TEAM, REPO);
    expect(useViewerStore.getState().navIndex[TEAM]).toBe(0);
    expect(active()).toBe(X);
    expect(paths()).not.toContain(K);
    expect(windowFocusOwnerMock).not.toHaveBeenCalled();
  });

  it("navigateForward steps past a satellite-owned entry to the next one main can show", () => {
    const X = "/repo/x.md";
    useViewerStore.setState({ navHistory: { [TEAM]: [A, K, X] }, navIndex: { [TEAM]: 0 } });
    useViewerStore.getState().navigateForward(TEAM, REPO);
    expect(useViewerStore.getState().navIndex[TEAM]).toBe(2);
    expect(active()).toBe(X);
    expect(paths()).not.toContain(K);
  });

  it("Back and Forward with only satellite-owned entries left keep the index", () => {
    useViewerStore.setState({ navHistory: { [TEAM]: [K, A, K] }, navIndex: { [TEAM]: 1 } });
    useViewerStore.getState().navigateBack(TEAM, REPO);
    expect(useViewerStore.getState().navIndex[TEAM]).toBe(1);
    useViewerStore.getState().navigateForward(TEAM, REPO);
    expect(useViewerStore.getState().navIndex[TEAM]).toBe(1);
    expect(active()).toBe(A);
  });

  it("setActiveTab's add-if-missing branch", () => {
    useViewerStore.getState().setActiveTab(TEAM, null, K);
    expect(paths()).toEqual([A, B]);
    expect(active()).toBe(A);
    expect(windowFocusOwnerMock).toHaveBeenCalledWith(K_KEY);
  });

  it("navigateBack and navigateForward onto K, through a write the store didn't vet", () => {
    // Back and Forward skip a satellite-owned entry themselves; the guard still stops a
    // history target that reaches K some other way.
    useViewerStore.setState((s) => ({
      openTabs: { [TEAM]: [...s.openTabs[TEAM], tab(K)] },
      activeTab: { [TEAM]: K },
      navIndex: { [TEAM]: 0 },
    }));
    expect(paths()).toEqual([A, B]);
    expect(active()).toBe(A);
  });

  it("remapTabPath onto K", () => {
    useViewerStore.getState().remapTabPath(TEAM, B, K);
    expect(paths()).toEqual([A]);
    expect(active()).toBe(A);
  });

  it("remapTabPath of the preview tab onto K restores nothing", () => {
    useViewerStore.setState({
      openTabs: { [TEAM]: [tab(A), tab(B, true)] },
      activeTab: { [TEAM]: A },
    });
    useViewerStore.getState().remapTabPath(TEAM, B, K);
    expect(paths()).toEqual([A]);
    expect(active()).toBe(A);
  });

  it("remapTabPath of the active tab onto K drops the pointer", () => {
    useViewerStore.getState().remapTabPath(TEAM, A, K);
    expect(paths()).toEqual([B]);
    expect(paths()).not.toContain(K);
  });

  it("setTabDiff on K", () => {
    // `setTabDiff` changes a tab's name, never its path. `main` holds a tab for K only
    // while K is unsaved here, and renaming it keeps it then.
    useViewerStore.setState({
      openTabs: { [TEAM]: [tab(A), tab(K)] },
      editingDirtyPaths: { [TEAM]: [K] },
    });
    useViewerStore.getState().setTabDiff(TEAM, K, { shortSha: "abc1234" } as never);
    expect(paths()).toEqual([A, K]);
    expect(useViewerStore.getState().openTabs[TEAM][1].name).toBe("k @ abc1234");
    useViewerStore.getState().setTabDiff(TEAM, A, { shortSha: "abc1234" } as never);
    expect(paths()).toEqual([A, K]);
  });

  it("dirty rescan: K kept while unsaved is dropped once it leaves editingDirtyPaths", () => {
    useViewerStore.setState({
      openTabs: { [TEAM]: [tab(A), tab(K)] },
      activeTab: { [TEAM]: K },
      editingDirtyPaths: { [TEAM]: [K] },
    });
    expect(paths()).toEqual([A, K]);
    useViewerStore.getState().setEditingDirtyPaths(TEAM, []);
    expect(paths()).toEqual([A]);
    expect(active()).toBe(A);
    expect(windowFocusOwnerMock).not.toHaveBeenCalled();
  });

  it("rekeyTeam onto K's team", () => {
    resetOwnerMapForTests();
    own("acme:renamed");
    useViewerStore.setState({ openTabs: { [TEAM]: [tab(A), tab(K)] }, activeTab: { [TEAM]: A } });
    useViewerStore.getState().rekeyTeam("acme", "default", "renamed");
    expect(paths("acme:renamed")).toEqual([A]);
    expect(active("acme:renamed")).toBe(A);
  });

  it("closeTeam reintroduces nothing", () => {
    useViewerStore.getState().closeTeam(TEAM);
    expect(paths()).not.toContain(K);
  });

  it("loadPersistedState with K in the saved openTabs", async () => {
    useViewerStore.setState({ stateLoaded: false });
    loadAppStateMock.mockResolvedValue(
      JSON.stringify({
        viewer: {
          schemaVersion: 9,
          openTabs: { [TEAM]: [tab(A), tab(K)] },
          activeTab: { [TEAM]: K },
        },
      }),
    );
    await useViewerStore.getState().loadPersistedState();
    expect(paths()).not.toContain(K);
    expect(active()).toBe(A);
    expect(windowFocusOwnerMock).not.toHaveBeenCalled();
  });

  it("applyOwnedViewerPrefs, the reset and the apply paths", () => {
    applyOwnedViewerPrefs({}, true);
    expect(paths()).not.toContain(K);
    // `main`'s tabs match the defaults, so the saved prefs apply with no pending edit.
    useViewerStore.setState({ openTabs: {}, activeTab: {}, stateLoaded: true });
    applyOwnedViewerPrefs({
      openTabs: { [TEAM]: [tab(A), tab(K)] },
      activeTab: { [TEAM]: K },
    });
    expect(paths()).not.toContain(K);
    expect(active()).not.toBe(K);
    // Today's behaviour, pinned until an open carries its origin: K becoming active
    // after load reads as a deliberate open and focuses the owner.
    expect(windowFocusOwnerMock).toHaveBeenCalledWith(K_KEY);
    useViewerStore.setState({ stateLoaded: false });
  });

  it("the MCP set_viewer_state patch", () => {
    useViewerStore.setState({
      openTabs: { [TEAM]: [tab(A), tab(K)] },
      activeTab: { [TEAM]: K },
    } as Partial<ViewerState>);
    expect(paths()).toEqual([A]);
    expect(active()).toBe(A);
    // Today's behaviour, pinned until an open carries its origin: the patch making K
    // active after load focuses the owner.
    expect(windowFocusOwnerMock).toHaveBeenCalledWith(K_KEY);
  });

  it("the Routines tab retirement onto a satellite-owned Agents tab", () => {
    resetOwnerMapForTests();
    own(TEAM, AGENTS_VIRTUAL_PATH);
    useViewerStore.setState({
      openTabs: { [TEAM]: [tab(A), { path: "virtual://routines", name: "Schedule" }] },
    });
    const s = useViewerStore.getState();
    const next = retiredRoutinesTabs(s.openTabs, s.activeTab);
    expect(next?.openTabs[TEAM].map((t) => t.path)).toContain(AGENTS_VIRTUAL_PATH);
    useViewerStore.setState({ openTabs: next!.openTabs, activeTab: next!.activeTab });
    expect(paths()).toEqual([A]);
  });

  it("a direct setState with an updater", () => {
    useViewerStore.setState((s) => ({
      openTabs: { ...s.openTabs, [TEAM]: [...s.openTabs[TEAM], tab(K)] },
    }));
    expect(paths()).toEqual([A, B]);
  });
});

describe("guard scope and exceptions @P1", () => {
  it("team scope: K in one team leaves the same path in another team open", () => {
    own(TEAM);
    useViewerStore.setState({
      openTabs: { [TEAM]: [tab(A), tab(K)], [TEAM_B]: [tab(K)] },
      activeTab: { [TEAM]: A, [TEAM_B]: K },
    });
    expect(paths()).toEqual([A]);
    expect(paths(TEAM_B)).toEqual([K]);
    expect(active(TEAM_B)).toBe(K);
  });

  it("a K that is unsaved in main stays open and is logged", () => {
    const warn = vi.spyOn(logger, "warn");
    useViewerStore.setState({
      openTabs: { [TEAM]: [tab(A), tab(K)] },
      activeTab: { [TEAM]: K },
      editingDirtyPaths: { [TEAM]: [K] },
    });
    own();
    expect(paths()).toEqual([A, K]);
    expect(active()).toBe(K);
    expect(warn).toHaveBeenCalledWith("windows", expect.stringContaining(K));
    warn.mockRestore();
  });

  it("the map gaining K removes it, repairs activeTab and focuses nothing", () => {
    useViewerStore.setState({
      openTabs: { [TEAM]: [tab(A), tab(K)] },
      activeTab: { [TEAM]: K },
    });
    own();
    expect(paths()).toEqual([A]);
    expect(active()).toBe(A);
    expect(windowFocusOwnerMock).not.toHaveBeenCalled();
  });

  it("neighbour fallback: a map update removing the active K activates its neighbour", () => {
    useViewerStore.setState({
      openTabs: { [TEAM]: [tab(A), tab(K), tab(B)] },
      activeTab: { [TEAM]: K },
    });
    own();
    expect(paths()).toEqual([A, B]);
    expect(active()).toBe(B);
    expect(windowFocusOwnerMock).not.toHaveBeenCalled();
  });
});

describe("guard cost @P1", () => {
  it("an empty map passes the partial through by identity", () => {
    const openTabs = { [TEAM]: [tab(A), tab(K)] };
    useViewerStore.setState({ openTabs });
    expect(useViewerStore.getState().openTabs).toBe(openTabs);
  });

  it("a non-empty map keeps every bucket reference on an unrelated set", () => {
    useViewerStore.setState({ openTabs: { [TEAM]: [tab(A)], [TEAM_B]: [tab(B)] } });
    own();
    const before = useViewerStore.getState().openTabs;
    useViewerStore.setState({ agentsPaneArrange: useViewerStore.getState().agentsPaneArrange });
    useViewerStore.setState({ activeTab: { [TEAM]: A } });
    const after = useViewerStore.getState().openTabs;
    expect(after).toBe(before);
  });

  it("opening a main-owned tab keeps the other buckets' references", () => {
    useViewerStore.setState({ stateLoaded: true });
    useViewerStore.setState({ openTabs: { [TEAM]: [tab(A)], [TEAM_B]: [tab(B)] } });
    own();
    const other = useViewerStore.getState().openTabs[TEAM_B];
    useViewerStore.getState().openFile(TEAM, REPO, B);
    expect(paths()).toContain(B);
    expect(useViewerStore.getState().openTabs[TEAM_B]).toBe(other);
    expect(windowFocusOwnerMock).not.toHaveBeenCalled();
    useViewerStore.setState({ stateLoaded: false });
  });

  it("a removal changes only its own bucket", () => {
    useViewerStore.setState({ openTabs: { [TEAM]: [tab(A)], [TEAM_B]: [tab(B)] } });
    own();
    let renders = 0;
    const stop = useViewerStore.subscribe((s, prev) => {
      if (s.openTabs[TEAM_B] !== prev.openTabs[TEAM_B]) renders += 1;
    });
    useViewerStore.getState().openFile(TEAM, REPO, K);
    stop();
    expect(paths()).toEqual([A]);
    expect(renders).toBe(0);
  });
});

describe("hydrate pull @P1", () => {
  it("starts with the prefs read and is awaited before the saved state applies", async () => {
    let resolvePrefs!: (v: string) => void;
    let resolveSlice!: (v: WindowSlice) => void;
    loadAppStateMock.mockReturnValue(new Promise<string>((r) => (resolvePrefs = r)));
    windowGetSliceMock.mockReturnValue(new Promise<WindowSlice>((r) => (resolveSlice = r)));
    useViewerStore.setState({ openTabs: {}, activeTab: {} });

    const loading = useViewerStore.getState().loadPersistedState();
    await vi.waitFor(() => expect(loadAppStateMock).toHaveBeenCalled());
    // Both reads are in flight together: no serial IPC.
    expect(windowGetSliceMock).toHaveBeenCalledWith("main");

    resolvePrefs(
      JSON.stringify({
        viewer: {
          schemaVersion: 9,
          openTabs: { [TEAM]: [tab(A), tab(K)] },
          activeTab: { [TEAM]: K },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(paths()).toEqual([]);

    resolveSlice(mainSlice({ [canonicalItemKey(K_KEY)]: "sat-1" }));
    await loading;
    expect(paths()).toEqual([A]);
    expect(active()).toBe(A);
    expect(windowFocusOwnerMock).not.toHaveBeenCalled();
  });

  it("a failed pull leaves main owning everything", async () => {
    loadAppStateMock.mockResolvedValue(
      JSON.stringify({ viewer: { schemaVersion: 9, openTabs: { [TEAM]: [tab(K)] } } }),
    );
    await useViewerStore.getState().loadPersistedState();
    expect(paths()).toEqual([K]);
  });
});

/** Store functions that write `openTabs`. A new writer fails here: add its route row
 *  above, then add it to this list. */
const OPEN_TABS_WRITERS = [
  "applyOwnedViewerPrefs",
  "closeAllTabs",
  "closeOtherTabs",
  "closeTab",
  "commitNavTarget",
  "commitTabOpen",
  "filterSatelliteTabs",
  "guardSatelliteItems",
  "loadPersistedState",
  "migrateT4Slices",
  "pinTab",
  "reconcileActiveTabs",
  "remapTabPath",
  "reorderTab",
  "serializedViewerPrefs",
  "setActiveTab",
  "setTabDiff",
  "viewerStore",
];

describe("writer drift @P2", () => {
  it("every function that writes openTabs is a known, guarded route", () => {
    const lines = readFileSync(resolve(__dirname, "viewer-store.ts"), "utf8").split("\n");
    const writer = /(\bopenTabs:\s|[{,]\s*openTabs\s*[,}]|^\s+openTabs,$|\.openTabs\s*=[^=])/;
    const enclosing = [
      /^ {2}(\w+): (?:async )?\(.*\) =>(?: \{)?$/,
      /^(?:export )?(?:async )?function (\w+)/,
      /^(?:export )?const (\w+)\b.*=/,
    ];
    const found = new Set<string>();
    lines.forEach((line, i) => {
      if (!writer.test(line) || /\bopenTabs:\s*Record</.test(line)) return;
      for (let j = i; j >= 0; j--) {
        const m = enclosing.map((re) => re.exec(lines[j])).find(Boolean);
        if (m) {
          found.add(m[1]);
          return;
        }
      }
      found.add(`? line ${i + 1}`);
    });
    expect([...found].sort()).toEqual(OPEN_TABS_WRITERS);
  });
});
