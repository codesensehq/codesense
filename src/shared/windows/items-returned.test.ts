// SPDX-License-Identifier: MIT
/** `main` opens a returned item in its origin team, without changing the active team. */
import "@/test/prefs-state-fixture";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/tauri/commands", () => ({
  saveAppState: vi.fn().mockResolvedValue(undefined),
  loadAppState: vi.fn().mockResolvedValue("{}"),
  pushViewerState: vi.fn().mockResolvedValue(undefined),
  checkPathExists: vi.fn().mockResolvedValue(true),
  windowGetSlice: vi.fn().mockRejectedValue(new Error("no registry")),
  windowFocusOwner: vi.fn().mockResolvedValue("sat-1"),
}));

import { logger } from "@/shared/lib/logger";
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

const notices = vi.spyOn(toast, "info").mockImplementation(() => "");
const warns = vi.spyOn(logger, "warn").mockImplementation(() => {});

beforeEach(() => {
  notices.mockClear();
  warns.mockClear();
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

  it("skips a known item kind that is not a tab, with no notice", () => {
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

  it("drops a queued item whose team is unavailable, and ends the org-store subscription", () => {
    const ready = useOrgStore.getState().orgs;
    useOrgStore.setState({ orgs: [], discoveryComplete: false });
    openReturnedItems({ items: [KEY], reason: "move" });
    useOrgStore.setState({ orgs: [], discoveryComplete: true });
    expect(tabs(ORIGIN)).toEqual([]);
    expect(notices.mock.calls).toEqual([["Closed 1 item of docs: the team was removed"]]);
    useOrgStore.setState({ orgs: ready, discoveryComplete: true });
    expect(tabs(ORIGIN)).toEqual([]);
  });

  it("drops a queued item whose org has no teams, and ends the org-store subscription", () => {
    const ready = useOrgStore.getState().orgs;
    useOrgStore.setState({ orgs: [], discoveryComplete: false });
    openReturnedItems({ items: [KEY], reason: "move" });
    useOrgStore.setState({ orgs: [{ ...ready[0]!, teams: [] }], discoveryComplete: true });
    expect(tabs(ORIGIN)).toEqual([]);
    useOrgStore.setState({ orgs: ready, discoveryComplete: true });
    expect(tabs(ORIGIN)).toEqual([]);
  });
});

const DOCS_B = itemKeyForTab(ORIGIN, { path: "/acme/teams/docs/b.md" });
const GENERAL = itemKeyForTab(ACTIVE, { path: "/acme/teams/general/c.md" });
const NEWER = { kind: "hologram", team: ORIGIN, id: "h-1" };

describe("items returned by kind", () => {
  it("opens no item of an unknown kind and posts one notice for all of them", () => {
    openReturnedItems({
      items: [NEWER, { ...NEWER, id: "h-2" }, KEY],
      reason: "close",
    });
    expect(tabs(ORIGIN)).toEqual([DOC]);
    expect(notices.mock.calls).toEqual([["Couldn't reopen 2 items from a newer version"]]);
  });

  it("posts no notice for an unknown kind a move brings back, and opens nothing", () => {
    openReturnedItems({ items: [NEWER], reason: "move" });
    expect(tabs(ORIGIN)).toEqual([]);
    expect(notices).not.toHaveBeenCalled();
  });

  it("opens a tab for every reason a window goes away", () => {
    for (const reason of ["close", "crash", "boot", "failed_restore", "profile_switch"] as const) {
      useViewerStore.setState({ openTabs: {}, activeTab: {} });
      openReturnedItems({ items: [KEY], reason });
      expect(tabs(ORIGIN), reason).toEqual([DOC]);
    }
    expect(notices).not.toHaveBeenCalled();
  });
});

describe("items of a removed team", () => {
  it("opens nothing and posts one notice for the team", () => {
    openReturnedItems({
      items: [KEY, DOCS_B, { kind: "workspace", team: ORIGIN, id: "ws-1" }],
      reason: "removed_team",
    });
    expect(tabs(ORIGIN)).toEqual([]);
    expect(notices.mock.calls).toEqual([["Closed 3 items of docs: the team was removed"]]);
  });

  it("posts one notice per team, each with its own count", () => {
    openReturnedItems({ items: [KEY, GENERAL, DOCS_B], reason: "removed_team" });
    expect(tabs(ORIGIN)).toEqual([]);
    expect(tabs(ACTIVE)).toEqual(["/acme/a.md"]);
    expect(notices.mock.calls).toEqual([
      ["Closed 2 items of docs: the team was removed"],
      ["Closed 1 item of general: the team was removed"],
    ]);
  });

  it.each(["boot", "failed_restore"] as const)(
    "a %s return of an unavailable team opens nothing and posts one notice, with no warn-only drop",
    (reason) => {
      const [org] = useOrgStore.getState().orgs;
      useOrgStore.setState({ orgs: [{ ...org!, teams: [team("general")] }] });
      openReturnedItems({ items: [KEY, DOCS_B], reason });
      expect(tabs(ORIGIN)).toEqual([]);
      expect(notices.mock.calls).toEqual([["Closed 2 items of docs: the team was removed"]]);
      expect(warns).not.toHaveBeenCalled();
    },
  );

  it("a boot return to an org with no teams opens nothing and posts one notice", () => {
    const [org] = useOrgStore.getState().orgs;
    useOrgStore.setState({ orgs: [{ ...org!, teams: [] }] });
    openReturnedItems({ items: [KEY], reason: "boot" });
    expect(tabs(ORIGIN)).toEqual([]);
    expect(notices.mock.calls).toEqual([["Closed 1 item of docs: the team was removed"]]);
  });
});
