// SPDX-License-Identifier: MIT
/**
 * A dashboard pref a satellite writes reaches `main`: `main`'s next read returns
 * it from the live prefs store, or from the file while that store is not ready or
 * is parked, and `main`'s next write keeps it. The backend merges key patches
 * like the Rust `write_app_state`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyFieldPatch } from "@/shared/lib/field-patch";

const host = vi.hoisted(() => ({ main: true }));
const store = vi.hoisted(() => ({ disk: {} as Record<string, unknown>, saves: 0, patches: 0 }));

vi.mock("@/shared/lib/current-window", async (importActual) => ({
  ...(await importActual<typeof import("@/shared/lib/current-window")>()),
  isMainWindow: () => host.main,
}));

vi.mock("@/shared/lib/local-profile-session", () => ({
  rendererPrincipal: vi.fn(async () => "p1"),
}));

vi.mock("@/tauri/commands", () => {
  const merge = (state: string) => {
    store.disk = applyFieldPatch(store.disk, JSON.parse(state)) as Record<string, unknown>;
  };
  return {
    loadAppState: vi.fn(async () => JSON.stringify(store.disk)),
    saveAppState: vi.fn(async (state: string, patch?: boolean) => {
      store.saves += 1;
      if (patch) merge(state);
      else store.disk = JSON.parse(state);
    }),
    patchAppStateKeys: vi.fn(async (state: string) => {
      store.patches += 1;
      merge(state);
    }),
  };
});

import { readDashboardPrefs, writeDashboardPrefs } from "./dashboard-prefs";
import { usePrefsStore } from "./prefs-store";

const KEY = "doc:/a.html";

/** The live store as the app keeps it from the file, for principal `p1`. */
const liveFromFile = (extra: Partial<ReturnType<typeof usePrefsStore.getState>> = {}) =>
  usePrefsStore.setState({
    principal: "p1",
    owned: { dashboardPrefs: store.disk.dashboardPrefs },
    ownedReady: true,
    parked: false,
    ...extra,
  });

async function satelliteWrites(patch: Record<string, unknown>) {
  host.main = false;
  try {
    await writeDashboardPrefs(KEY, patch);
  } finally {
    host.main = true;
  }
}

beforeEach(() => {
  host.main = true;
  store.disk = { viewer: { keep: true } };
  store.saves = 0;
  store.patches = 0;
  usePrefsStore.setState({ principal: null, owned: {}, ownedReady: false, parked: false });
});

describe("a satellite's dashboard pref, read and kept by main", () => {
  it("goes out as patch_app_state_keys and merges into the file", async () => {
    await satelliteWrites({ sort: "date" });
    expect(store.patches).toBe(1);
    expect(store.saves).toBe(0);
    expect(store.disk.viewer).toEqual({ keep: true });
    expect(store.disk.dashboardPrefs).toMatchObject({ [KEY]: { data: { sort: "date" } } });
  });

  it("main's next read returns it from the live prefs store", async () => {
    await satelliteWrites({ sort: "date" });
    liveFromFile();
    expect(await readDashboardPrefs(KEY)).toEqual({ sort: "date" });
  });

  it("main's next read returns it from the file while the store is not ready or parked", async () => {
    await satelliteWrites({ sort: "date" });
    usePrefsStore.setState({ principal: "p1", owned: {}, ownedReady: false });
    expect(await readDashboardPrefs(KEY)).toEqual({ sort: "date" });
    liveFromFile({ owned: {}, parked: true });
    expect(await readDashboardPrefs(KEY)).toEqual({ sort: "date" });
  });

  it("main's next write keeps it", async () => {
    await satelliteWrites({ sort: "date" });
    await writeDashboardPrefs(KEY, { density: "compact" });
    expect(store.saves).toBe(1);
    expect(await readDashboardPrefs(KEY)).toEqual({ sort: "date", density: "compact" });
    expect(store.disk.dashboardPrefs).toMatchObject({
      [KEY]: { data: { sort: "date", density: "compact" } },
    });
  });

  it("a write shows in the live store of the principal it read, and no other", async () => {
    liveFromFile({ owned: {} });
    await writeDashboardPrefs(KEY, { sort: "date" });
    expect(usePrefsStore.getState().owned.dashboardPrefs).toMatchObject({
      [KEY]: { data: { sort: "date" } },
    });
    usePrefsStore.setState({ principal: "p2", owned: {}, ownedReady: true });
    await writeDashboardPrefs(KEY, { density: "compact" });
    expect(usePrefsStore.getState().owned).toEqual({});
  });
});
