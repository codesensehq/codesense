// SPDX-License-Identifier: MIT
/**
 * Every app-state writer sends a key patch, so a satellite's patch that lands
 * between `main`'s read and `main`'s save survives it. The cases run each
 * writer's real persist (org, config, both dashboard-prefs paths) over an
 * in-memory backend whose `save_app_state` and `patch_app_state_keys` merge like
 * the Rust `write_app_state`, and assert on the merged file, not the payload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import satelliteKeys from "../../../src-tauri/src/windows/app_state_patch_keys.json";
import { applyFieldPatch } from "./field-patch";

const host = vi.hoisted(() => ({ main: true, windowReads: 0 }));
const backend = vi.hoisted(() => ({
  disk: {} as Record<string, unknown>,
  invoked: [] as string[],
  /** Runs once, at the next save, before it merges: a satellite's write landing mid-persist. */
  beforeSave: null as null | (() => void),
}));

vi.mock("@/shared/lib/current-window", async (importActual) => ({
  ...(await importActual<typeof import("./current-window")>()),
  isMainWindow: () => {
    host.windowReads += 1;
    return host.main;
  },
}));

vi.mock("@/shared/lib/local-profile-session", async (importActual) => ({
  ...(await importActual<typeof import("./local-profile-session")>()),
  rendererPrincipal: async () => "p1",
}));

function merge(raw: string) {
  backend.disk = applyFieldPatch(backend.disk, JSON.parse(raw)) as Record<string, unknown>;
}

vi.mock("@tauri-apps/api/core", async (importActual) => ({
  ...(await importActual<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (command: string, args: { state?: string; patch?: boolean }) => {
    backend.invoked.push(command);
    if (command === "load_app_state") return JSON.stringify(backend.disk);
    if (command === "save_app_state" || command === "patch_app_state_keys") {
      const landing = backend.beforeSave;
      backend.beforeSave = null;
      landing?.();
      if (command === "patch_app_state_keys") {
        const outside = Object.keys(JSON.parse(args.state!)).filter(
          (key) => !satelliteKeys.includes(key),
        );
        if (outside.length) throw new Error(`not a key a satellite may write: ${outside[0]}`);
      }
      if (command === "save_app_state" && !args.patch) backend.disk = JSON.parse(args.state!);
      else merge(args.state!);
      return undefined;
    }
    return undefined;
  }),
}));

vi.mock("@/tauri/commands", async (importActual) => ({
  ...(await importActual<typeof import("@/tauri/commands")>()),
  createContextRepo: async (repoPath: string) => ({
    repo_name: repoPath.split("/").pop(),
    path: `${repoPath}/.context`,
    has_remote: false,
    remote_url: null,
  }),
}));

const SATELLITE_SHORTCUTS = { version: 2, shortcuts: { open: "Mod+O" } };

/** A satellite's shortcut patch, as `patch_app_state_keys` merges it. */
const satelliteLands = () => {
  backend.beforeSave = () => merge(JSON.stringify({ shortcuts: SATELLITE_SHORTCUTS }));
};

async function load() {
  const write = await import("./app-state-write");
  const org = await import("@/shared/stores/org-store");
  const config = await import("@/shared/stores/config-store");
  const prefs = await import("@/features/dashboard/lib/dashboard-prefs");
  const drain = () => write.serializeAppStateWrite(async () => {});
  return { write, org, config, prefs, drain };
}

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
  host.main = true;
  host.windowReads = 0;
  backend.disk = { viewer: { tab: "keep" } };
  backend.invoked = [];
  backend.beforeSave = null;
});

describe("a satellite patch that lands mid-persist survives main's write", () => {
  it("org", async () => {
    const { org } = await load();
    await org.useOrgStore.getState().loadPersistedState();
    org.useOrgStore.getState().setOrgs([makeOrg("acme", ["main"])] as never);
    org.useOrgStore.getState().setActiveOrg("acme");
    satelliteLands();
    await org.flushOrgForProfileSwitch();
    expect(backend.disk.shortcuts).toEqual(SATELLITE_SHORTCUTS);
    expect(backend.disk.org).toMatchObject({ activeOrgSlug: "acme", activeTeamName: "main" });
    expect(backend.disk.viewer).toEqual({ tab: "keep" });
  });

  it("config", async () => {
    const { config } = await load();
    await config.useConfigStore.getState().loadState();
    satelliteLands();
    await config.useConfigStore.getState().recordSetupApproval("/repo", "hash");
    expect(backend.disk.shortcuts).toEqual(SATELLITE_SHORTCUTS);
    expect(
      (backend.disk.worktreeSetupApprovals as Record<string, { configHash: string }>)["/repo::hash"]
        .configHash,
    ).toBe("hash");
    expect(backend.disk.viewer).toEqual({ tab: "keep" });
  });

  it("dashboard prefs, a write", async () => {
    const { prefs } = await load();
    satelliteLands();
    await prefs.writeDashboardPrefs("doc:/a.html", { sort: "date" });
    expect(backend.disk.shortcuts).toEqual(SATELLITE_SHORTCUTS);
    expect(backend.disk.dashboardPrefs).toMatchObject({
      "doc:/a.html": { data: { sort: "date" } },
    });
  });

  it("dashboard prefs, the touch a stale read makes", async () => {
    backend.disk.dashboardPrefs = { "doc:/a.html": { data: { sort: "date" }, at: 0 } };
    const { prefs, drain } = await load();
    satelliteLands();
    expect(await prefs.readDashboardPrefs("doc:/a.html")).toEqual({ sort: "date" });
    await drain();
    expect(backend.disk.shortcuts).toEqual(SATELLITE_SHORTCUTS);
    const entry = (backend.disk.dashboardPrefs as Record<string, { at: number }>)["doc:/a.html"];
    expect(entry.at).toBeGreaterThan(0);
  });

  it("an evicted dashboard-prefs entry is removed from the file", async () => {
    const all: Record<string, { data: object; at: number }> = {};
    for (let i = 0; i < 500; i++) all[`doc:/${i}.html`] = { data: {}, at: i + 1 };
    backend.disk.dashboardPrefs = all;
    const { prefs } = await load();
    await prefs.writeDashboardPrefs("doc:/new.html", { a: 1 });
    const saved = backend.disk.dashboardPrefs as Record<string, unknown>;
    expect(saved).not.toHaveProperty("doc:/0.html");
    expect(saved).toHaveProperty("doc:/1.html");
    expect(saved).toHaveProperty("doc:/new.html");
    expect(Object.keys(saved)).toHaveLength(500);
  });

  it("main adds a repo while a satellite tries to patch repos: the satellite's write is skipped", async () => {
    const { config, write } = await load();
    await config.useConfigStore.getState().loadState();
    await config.useConfigStore.getState().addRepo("/work/app");
    host.main = false;
    await write.patchAppState({ repos: [] });
    host.main = true;
    expect(backend.invoked.filter((name) => name === "patch_app_state_keys")).toEqual([]);
    expect((backend.disk.repos as { repoPath: string }[]).map((r) => r.repoPath)).toEqual([
      "/work/app",
    ]);
  });
});

describe("main's org switch", () => {
  it("is one save_app_state carrying org alone, with no load_app_state", async () => {
    backend.disk.org = { activeOrgSlug: "one", activeTeamName: "main" };
    const { org } = await load();
    await org.useOrgStore.getState().loadPersistedState();
    org.useOrgStore.getState().setOrgs([makeOrg("one", ["main"]), makeOrg("two", [])] as never);
    backend.invoked = [];
    org.useOrgStore.getState().setActiveOrg("two");
    await org.flushOrgForProfileSwitch();
    expect(backend.invoked.filter((name) => name.endsWith("_app_state"))).toEqual([
      "save_app_state",
    ]);
    // The file, not the payload: a team that "two" lacks goes out as null and is removed.
    expect(backend.disk.org).toMatchObject({ activeOrgSlug: "two" });
    expect(backend.disk.org).not.toHaveProperty("activeTeamName");
    expect(backend.disk.viewer).toEqual({ tab: "keep" });
  });

  it("patchAppState reads the window once (save_app_state's own gate reads it again)", async () => {
    const { write } = await load();
    host.windowReads = 0;
    await write.patchAppState({ org: { activeOrgSlug: "x" } });
    expect(host.windowReads).toBe(2);
    host.main = false;
    host.windowReads = 0;
    await write.patchAppState({ shortcuts: SATELLITE_SHORTCUTS });
    expect(host.windowReads).toBe(1);
    expect(backend.invoked.filter((name) => name.endsWith("_app_state_keys"))).toEqual([
      "patch_app_state_keys",
    ]);
  });
});
