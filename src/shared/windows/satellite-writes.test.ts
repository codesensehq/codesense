// SPDX-License-Identifier: MIT
/**
 * In a satellite the stores write only the app-state keys in
 * `app_state_patch_keys.json`, each as one `patch_app_state_keys` key patch, and
 * never `save_app_state`. A change to a key `main` owns (repos, approvals, org,
 * team) makes no write at all. The cases run the real stores and commands over a
 * recorded `invoke`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import satelliteKeys from "../../../src-tauri/src/windows/app_state_patch_keys.json";

const host = vi.hoisted(() => ({ main: false }));
const invoked = vi.hoisted(() => [] as { command: string; state?: string }[]);

vi.mock("@/shared/lib/current-window", async (importActual) => ({
  ...(await importActual<typeof import("@/shared/lib/current-window")>()),
  isMainWindow: () => host.main,
}));

vi.mock("@/shared/lib/local-profile-session", async (importActual) => ({
  ...(await importActual<typeof import("@/shared/lib/local-profile-session")>()),
  rendererPrincipal: async () => "p1",
}));

vi.mock("@tauri-apps/api/core", async (importActual) => ({
  ...(await importActual<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (command: string, args?: { state?: string }) => {
    invoked.push({ command, state: args?.state });
    if (command === "load_app_state") return "{}";
    return undefined;
  }),
}));

vi.mock("@/tauri/commands", async (importActual) => ({
  ...(await importActual<typeof import("@/tauri/commands")>()),
  createContextRepo: async (repoPath: string) => ({
    repo_name: "app",
    path: `${repoPath}/.context`,
    has_remote: false,
    remote_url: null,
  }),
}));

const count = (command: string) => invoked.filter((call) => call.command === command).length;
const writes = () =>
  invoked.filter(
    (call) => call.command === "save_app_state" || call.command === "patch_app_state_keys",
  );

const makeOrg = (slug: string, teams: string[]) => ({
  slug,
  display_name: slug,
  created_at: "2026-01-01T00:00:00Z",
  remote_url: null,
  config_flags: {},
  people: [],
  teams: teams.map((name) => ({ name, source_repos: [] })),
});

beforeEach(() => {
  vi.resetModules();
  host.main = false;
  invoked.length = 0;
});

describe("a satellite's app-state writes", () => {
  it("takes its allowlist from app_state_patch_keys.json", async () => {
    const { SATELLITE_APP_STATE_KEYS } = await import("@/shared/lib/app-state-write");
    expect(SATELLITE_APP_STATE_KEYS).toEqual(satelliteKeys);
  });

  it("a shortcut change is one patch_app_state_keys of shortcuts and no save_app_state", async () => {
    const shortcuts = await import("@/shared/stores/shortcuts-store");
    await shortcuts.useShortcutsStore.getState().loadPersistedState({});
    invoked.length = 0;
    shortcuts.useShortcutsStore.getState().clearShortcut("app.command-palette");
    await shortcuts.flushShortcutsForProfileSwitch();
    expect(count("save_app_state")).toBe(0);
    expect(count("patch_app_state_keys")).toBe(1);
    expect(Object.keys(JSON.parse(writes()[0].state!))).toEqual(["shortcuts"]);
    expect(count("rebuild_menu")).toBe(0);
  });

  it("a dashboard pref change is one patch_app_state_keys of dashboardPrefs and no save_app_state", async () => {
    const prefs = await import("@/features/dashboard/lib/dashboard-prefs");
    await prefs.writeDashboardPrefs("doc:/a.html", { sort: "date" });
    expect(count("save_app_state")).toBe(0);
    expect(count("patch_app_state_keys")).toBe(1);
    expect(Object.keys(JSON.parse(writes()[0].state!))).toEqual(["dashboardPrefs"]);
  });

  it("a repo change and an approval make no write", async () => {
    const { useConfigStore } = await import("@/shared/stores/config-store");
    await useConfigStore.getState().loadState();
    await useConfigStore.getState().addRepo("/work/app");
    await useConfigStore.getState().recordSetupApproval("/work/app", "hash");
    expect(useConfigStore.getState().repos.map((repo) => repo.repoPath)).toEqual(["/work/app"]);
    expect(writes()).toEqual([]);
  });

  it("an org change and a team change make no write", async () => {
    const { useOrgStore, flushOrgForProfileSwitch } = await import("@/shared/stores/org-store");
    await useOrgStore.getState().loadPersistedState();
    useOrgStore.getState().setOrgs([makeOrg("acme", ["a", "b"])] as never);
    useOrgStore.getState().setActiveOrg("acme");
    await flushOrgForProfileSwitch();
    useOrgStore.getState().setActiveTeam("b");
    await flushOrgForProfileSwitch();
    expect(useOrgStore.getState().activeTeamName).toBe("b");
    expect(writes()).toEqual([]);
  });

  it("starts and stops no watcher", async () => {
    const shortcuts = await import("@/shared/stores/shortcuts-store");
    const { useConfigStore } = await import("@/shared/stores/config-store");
    const { useOrgStore, flushOrgForProfileSwitch } = await import("@/shared/stores/org-store");
    await useConfigStore.getState().loadState();
    await useConfigStore.getState().addRepo("/work/app");
    await useOrgStore.getState().loadPersistedState();
    useOrgStore.getState().setOrgs([makeOrg("acme", ["a"])] as never);
    useOrgStore.getState().setActiveOrg("acme");
    await flushOrgForProfileSwitch();
    shortcuts.useShortcutsStore.getState().clearShortcut("app.command-palette");
    await shortcuts.flushShortcutsForProfileSwitch();
    expect(count("start_watching")).toBe(0);
    expect(count("stop_watching")).toBe(0);
  });

  it("main writes the same shortcut change through save_app_state (control)", async () => {
    host.main = true;
    const shortcuts = await import("@/shared/stores/shortcuts-store");
    await shortcuts.useShortcutsStore.getState().loadPersistedState({});
    invoked.length = 0;
    shortcuts.useShortcutsStore.getState().clearShortcut("app.command-palette");
    await shortcuts.flushShortcutsForProfileSwitch();
    expect(count("save_app_state")).toBe(1);
    expect(count("patch_app_state_keys")).toBe(0);
    expect(count("rebuild_menu")).toBe(1);
  });
});
