// SPDX-License-Identifier: MIT
/** `main` opens a returned item in its origin team, without changing the active team. */
import "@/test/prefs-state-fixture";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/tauri/commands", () => ({
  saveAppState: vi.fn().mockResolvedValue(undefined),
  loadAppState: vi.fn().mockResolvedValue("{}"),
  pushViewerState: vi.fn().mockResolvedValue(undefined),
  checkPathExists: vi.fn().mockResolvedValue(true),
  windowGetSlice: vi.fn().mockRejectedValue(new Error("no registry")),
  windowFocusOwner: vi.fn().mockResolvedValue("sat-1"),
}));

import { getActiveTeamKey } from "@/shared/lib/team-key";
import { useOrgStore } from "@/shared/stores/org-store";
import { useViewerStore } from "@/shared/stores/viewer-store";

import { canonicalItemKey, itemKeyForTab } from "./item-key";
import { openReturnedItems, repoPathForItem, resetWaitingItemsForTests } from "./items-returned";
import { applyOwnerMap, resetOwnerMapForTests } from "./owner-map";

const ACTIVE = "acme:general";
const ORIGIN = "acme:docs";
const DOC = "/acme/teams/docs/guide.md";
const KEY = itemKeyForTab(ORIGIN, { path: DOC });

const team = (name: string) => ({ name, source_repos: [] });
const tabs = (teamKey: string) =>
  (useViewerStore.getState().openTabs[teamKey] ?? []).map((t) => t.path);

beforeEach(() => {
  resetOwnerMapForTests();
  resetWaitingItemsForTests();
  useOrgStore.setState({
    orgs: [
      {
        slug: "acme",
        display_name: "Acme",
        created_at: new Date(0).toISOString(),
        remote_url: null,
        config_flags: {},
        people: [],
        teams: [team("general"), team("docs")],
        org_root: "/acme",
      },
    ],
    discoveryComplete: true,
    activeOrgSlug: "acme",
    activeTeamName: "general",
  });
  useViewerStore.setState({
    openTabs: { [ACTIVE]: [{ path: "/acme/a.md", name: "a.md" }] },
    activeTab: { [ACTIVE]: "/acme/a.md" },
    editingDirtyPaths: {},
    stateLoaded: true,
  });
});

describe("items returned to main", () => {
  it("opens the item in its origin team without changing the active team", () => {
    openReturnedItems({ items: [KEY], reason: "move" });
    expect(tabs(ORIGIN)).toEqual([DOC]);
    expect(useViewerStore.getState().activeTab[ORIGIN]).toBe(DOC);
    expect(getActiveTeamKey()).toBe(ACTIVE);
    expect(tabs(ACTIVE)).toEqual(["/acme/a.md"]);
    expect(useViewerStore.getState().activeTab[ACTIVE]).toBe("/acme/a.md");
  });

  it("opens it once when the tab is already open", () => {
    openReturnedItems({ items: [KEY], reason: "move" });
    openReturnedItems({ items: [KEY], reason: "move" });
    expect(tabs(ORIGIN)).toEqual([DOC]);
  });

  it("opens it once the owner map that reached main first no longer names a satellite", () => {
    applyOwnerMap({ [canonicalItemKey(KEY)]: "sat-1" });
    applyOwnerMap({});
    openReturnedItems({ items: [KEY], reason: "move" });
    expect(tabs(ORIGIN)).toEqual([DOC]);
  });

  it("skips an item whose kind is not a tab", () => {
    openReturnedItems({ items: [{ kind: "tile", team: ORIGIN, id: "t-1" }], reason: "move" });
    expect(tabs(ORIGIN)).toEqual([]);
  });

  it("resolves the repo through the team's content context, null while it is not ready", () => {
    expect(repoPathForItem(KEY)).toBe("team:acme:docs");
    useOrgStore.setState({ orgs: [], discoveryComplete: false });
    expect(repoPathForItem(KEY)).toBeNull();
    openReturnedItems({ items: [KEY], reason: "move" });
    expect(tabs(ORIGIN)).toEqual([]);
  });

  it("queues an item whose team is not ready and opens it once the team is", () => {
    const ready = useOrgStore.getState().orgs;
    useOrgStore.setState({ orgs: [], discoveryComplete: false });
    openReturnedItems({ items: [KEY, KEY], reason: "move" });
    expect(tabs(ORIGIN)).toEqual([]);
    useOrgStore.setState({ orgs: ready, discoveryComplete: true });
    expect(tabs(ORIGIN)).toEqual([DOC]);
    expect(getActiveTeamKey()).toBe(ACTIVE);
  });
});
