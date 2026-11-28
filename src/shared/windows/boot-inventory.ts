// SPDX-License-Identifier: MIT
/**
 * Every boot initializer of `App.tsx`, one row each, with what a satellite does
 * with it. A row is keyed by the hook `App` calls, by the `// boot: <id>` marker
 * on one of its inline `useEffect`s, or by its module-scope statement.
 *
 * - `run`: a satellite runs it as `main` does, for its own slice: the virtual-tab
 *   registrations and the terminal rows a workspace tile needs. In a satellite
 *   the terminal rows act only on `sliceWorkspaceIds()`, so they touch nothing
 *   until a slice carries workspaces.
 * - `read-only`: a satellite runs it to read; it writes nothing (the stores' app-
 *   state writes go through `patchAppState`, which drops a satellite's write to a
 *   key `main` owns).
 * - `skip`: `main` alone runs it: it writes what `main` owns, is an app-wide
 *   singleton (one badge, one notification, one update check), or serves `main`'s
 *   shell, which a satellite does not draw.
 *
 * Each `run` and `read-only` row is a shared export here (`BOOT_EXPORTS`), which
 * `App.tsx` calls as before and `satellite-root.tsx` mounts through
 * `<BootRows rows={SATELLITE_ROWS} />`. Nothing here imports a `skip` row.
 *
 * `boot-inventory.test.ts` keeps this list and `App.tsx` in step: an initializer
 * with no row, a row with no initializer, an unmarked inline `useEffect` or a
 * module-scope statement with no row fails it.
 */
import { useEffect, useSyncExternalStore } from "react";

import { useDashboardStream } from "@/app/hooks/use-dashboard-stream";
import { registerAgentsTab } from "@/features/agents/agents-virtual-tab";
import { usePrefsLive } from "@/features/dashboard/lib/prefs-live";
import { registerSourceReposTab } from "@/features/dashboard/source-repos-virtual-tab";
import { registerDashboardsTab } from "@/features/dashboard-publishing/dashboards-virtual-tab";
import { registerOpenDiffTab } from "@/features/git-sync/lib/open-diff";
import { registerWorkspacesTab } from "@/features/org/workspaces-virtual-tab";
import { registerRoutinesTab } from "@/features/routines/routines-virtual-tab";
import { registerScratchSpaceTab } from "@/features/scratch-space/scratch-space-virtual-tab";
import { registerSettingsTab } from "@/features/settings/settings-virtual-tab";
import { registerMachinesTab } from "@/features/shell/machines-virtual-tab";
import { registerManageTeamsTab } from "@/features/shell/manage-teams-virtual-tab";
import { useMarkActiveSessionSeen } from "@/features/viewer/hooks/use-mark-active-session-seen";
import { useStatusTaxonomy } from "@/features/viewer/hooks/use-status-taxonomy";
import { useTerminalDisplayGc } from "@/features/viewer/hooks/use-terminal-display-gc";
import { useTerminalDisplayWarm } from "@/features/viewer/hooks/use-terminal-display-warm";
import { registerMessageTab } from "@/features/weft/components/inbox-message-dashboard";
import { useActiveWorkspaceContext } from "@/shared/hooks/use-active-workspace-context";
import { useTerminalStatusEvents } from "@/shared/hooks/use-terminal-status-events";
import { isMainWindow } from "@/shared/lib/current-window";
import { useCurrentUser } from "@/shared/lib/get-current-user";
import { initLogging, logger } from "@/shared/lib/logger";
import { useActiveTeamKey } from "@/shared/lib/team-key";
import { hydrateTerminalLayout } from "@/shared/lib/terminal-layout";
import { useConfigStore } from "@/shared/stores/config-store";
import { useLocalProfileStore } from "@/shared/stores/local-profile-store";
import { useOrgStore } from "@/shared/stores/org-store";
import { useShortcutsStore } from "@/shared/stores/shortcuts-store";
import { selectSessionHome, useViewerStore } from "@/shared/stores/viewer-store";

import { setSessionLocator, sliceSource, sliceWorkspaceIds } from "./slice";

setSessionLocator(
  (sessionId) => selectSessionHome(useViewerStore.getState(), sessionId)?.workspaceId,
);

type BootClass = "run" | "read-only" | "skip";

export interface BootRow {
  /** The hook `App` calls, the `// boot:` marker of an inline effect, or a module row's name. */
  id: string;
  kind: "hook" | "effect" | "module";
  class: BootClass;
  /** Why the row has its class. */
  why: string;
}

/** The virtual tabs `App` registers at module scope. The registry is a plain Map, so a
 *  satellite registers them at module scope too: a `virtual://` item its slice hands
 *  over synchronously resolves at first render. Idempotent (last registration wins). */
export function registerVirtualTabs(): void {
  registerMachinesTab();
  registerDashboardsTab();
  registerRoutinesTab();
  registerAgentsTab();
  registerScratchSpaceTab();
  registerOpenDiffTab();
  registerSourceReposTab();
  registerSettingsTab();
  registerManageTeamsTab();
  registerWorkspacesTab();
  registerMessageTab();
}

/** The boot reads: the org session block and shortcut overrides, the platform caps,
 *  logging, then the config and the local profile. Each only reads. */
export function useBootLoad(): void {
  const loadState = useConfigStore((s) => s.loadState);
  const initializeAuth = useLocalProfileStore((s) => s.initialize);
  useEffect(() => {
    // Kick off org-store rehydrate OUTSIDE the `await initLogging()`
    // chain so it fires even if logging init fails. F-25 removed the
    // currentUser projection (and its two-gate race), so the rehydrate
    // no longer needs to serialize against an auth-projection hook —
    // it only needs to restore the persisted session block before any
    // setter writes live state on top of it.
    useOrgStore
      .getState()
      .loadPersistedState()
      .catch(() => {
        // Failures are logged inside loadPersistedState.
      });

    // Shortcut overrides load in parallel with org-store. No
    // ordering constraint — the keyboard handler reads whatever is
    // in the store at match time; pre-rehydrate it uses the
    // registry's defaults, post-rehydrate it uses the user's overrides.
    // `loadPersistedState` logs its own failures; this tail-catch
    // guards sync throws before the promise chain.
    useShortcutsStore
      .getState()
      .loadPersistedState()
      .catch((e) => {
        logger.warn("App", `shortcuts loadPersistedState failed — ${e}`);
      });

    // Which optional features this OS supports: read once, fixed for the run (`useCapability`).
    void useConfigStore.getState().loadPlatformCaps();

    (async () => {
      await initLogging();
      loadState();
      initializeAuth();
    })().catch(() => {});
  }, [loadState, initializeAuth]);
}

/** The workspace ids of this window's slice, re-read when the slice changes. */
function useSliceWorkspaceIds(): readonly string[] {
  const source = sliceSource();
  return useSyncExternalStore(source.subscribe, sliceWorkspaceIds);
}

/**
 * The terminal hosts own the terminal layout: restoring it is subscribing to
 * their changes and fetching their snapshots. It never opens a terminal. It
 * starts once the config is loaded; in a satellite, only while its slice holds
 * workspaces, and again when they change. The snapshot takes no workspace filter,
 * so a satellite holding none never asks for one.
 */
export function useTerminalLayoutRestore(): void {
  const initialized = useConfigStore((s) => s.initialized);
  const workspaces = useSliceWorkspaceIds();
  const main = isMainWindow();
  const ready = initialized && (main || workspaces.length > 0);
  const scope = main ? "" : workspaces.join("\n");
  useEffect(() => {
    if (!ready) return;
    let teardown: (() => void) | null = null;
    let cancelled = false;
    hydrateTerminalLayout()
      .then((stop) => {
        if (cancelled) stop();
        else teardown = stop;
      })
      .catch((e) => logger.warn("terminal", `terminal layout restore failed: ${e}`));
    return () => {
      cancelled = true;
      teardown?.();
    };
  }, [ready, scope]);
}

/** The status taxonomy of the active team (its board states). */
export function useActiveTeamStatusTaxonomy(): void {
  useStatusTaxonomy(useActiveTeamKey());
}

/** The shared export of each `run` and `read-only` row, looked up at call time. */
export const BOOT_EXPORTS: Record<string, () => unknown> = {
  registerVirtualTabs,
  useTerminalStatusEvents,
  useTerminalDisplayGc,
  useTerminalDisplayWarm,
  useMarkActiveSessionSeen,
  useCurrentUser,
  useActiveTeamStatusTaxonomy,
  useDashboardStream,
  usePrefsLive,
  useActiveWorkspaceContext,
  useBootLoad,
  useTerminalLayoutRestore,
};

const why = {
  shell: "serves main's shell (tabs, panels, menus), which a satellite does not draw",
  mainStore: "feeds an app-root store main's shell reads",
  push: "main pushes settings to Rust",
  singleton: "an app-wide singleton: one per event, from main",
} as const;

// prettier-ignore
export const BOOT_ROWS: readonly BootRow[] = [
  { id: "registerVirtualTabs", kind: "module", class: "run", why: "the virtual-tab registry a satellite's virtual:// item resolves against" },
  { id: "webdriver-e2e-controls", kind: "module", class: "skip", why: "main's webdriver controls; a satellite's driver installs its own probe" },
  { id: "remote-story-workspace", kind: "module", class: "skip", why: "installs the viewer store's driver for machine workspaces, which main opens" },
  { id: "useShellScrollContainment", kind: "hook", class: "skip", why: why.shell },
  { id: "settings-tab-flag", kind: "effect", class: "skip", why: why.shell },
  { id: "navigation-capture", kind: "effect", class: "skip", why: why.shell },
  { id: "useShortcutHandler", kind: "hook", class: "skip", why: "global keys act on main's tabs and panels" },
  { id: "useMcpActions", kind: "hook", class: "skip", why: "MCP actions are main-only" },
  { id: "useRightPaneMenuSync", kind: "hook", class: "skip", why: "the native menu belongs to main" },
  { id: "useDashboardCommandsSync", kind: "hook", class: "skip", why: "joins dashboards' commands to main's shortcut registry" },
  { id: "useAgentMessageListener", kind: "hook", class: "skip", why: why.mainStore },
  { id: "useCanvasRenderBridge", kind: "hook", class: "skip", why: "render replies are main-only" },
  { id: "useRenderedDocumentBridge", kind: "hook", class: "skip", why: "render replies are main-only" },
  { id: "useMainWindowRegistry", kind: "hook", class: "skip", why: "keeps main's map of the items satellites own" },
  { id: "useManagedSessionBridge", kind: "hook", class: "skip", why: "a request/reply bridge: one window answers" },
  { id: "useTerminalStatusEvents", kind: "hook", class: "run", why: "the status dots of this window's terminals" },
  { id: "useTerminalDisplayGc", kind: "hook", class: "run", why: "disposes the displays of this window's closed tabs" },
  { id: "useTerminalDisplayWarm", kind: "hook", class: "run", why: "warms the displays of this window's tabs" },
  { id: "useMarkActiveSessionSeen", kind: "hook", class: "run", why: "settles the dot of the terminal this window shows" },
  { id: "useWarmPool", kind: "hook", class: "skip", why: "one global warm pool, sized by main" },
  { id: "useBackgroundSetupCap", kind: "hook", class: "skip", why: why.push },
  { id: "useBackgroundAgentLimit", kind: "hook", class: "skip", why: why.push },
  { id: "useNeedsYouNotifications", kind: "hook", class: "skip", why: why.singleton },
  { id: "useAttentionAlerts", kind: "hook", class: "skip", why: `${why.singleton} (the dock badge)` },
  { id: "useQuitOnCloseSetting", kind: "hook", class: "skip", why: why.push },
  { id: "useTerminalServerMenuBarSetting", kind: "hook", class: "skip", why: why.push },
  { id: "useBackgroundModeNotification", kind: "hook", class: "skip", why: `${why.singleton}; it also writes the explainer flag` },
  { id: "useOrgDiscovery", kind: "hook", class: "skip", why: "places the docs repo and discovers orgs on disk for main's boot" },
  { id: "useCurrentUser", kind: "hook", class: "read-only", why: "reads the signed-in profile" },
  { id: "usePendingJoinLanding", kind: "hook", class: "skip", why: why.shell },
  { id: "useWorkspaceViewerSync", kind: "hook", class: "skip", why: "sets the global active team and owns the watches main keeps" },
  { id: "useTeamLandingPage", kind: "hook", class: "skip", why: "opens main's landing tab" },
  { id: "useStaleArrowFilterCleanup", kind: "hook", class: "skip", why: "clears a saved filter main owns" },
  { id: "useContextProgressListener", kind: "hook", class: "skip", why: why.mainStore },
  { id: "useAgentRosterListener", kind: "hook", class: "skip", why: why.mainStore },
  { id: "useAgentTabTitles", kind: "hook", class: "skip", why: "renames main's tabs" },
  { id: "useAttendedAgentRelease", kind: "hook", class: "skip", why: "releases background-limit slots: one window acts" },
  { id: "useOpenWorkspaceReveal", kind: "hook", class: "skip", why: "reveals a workspace in main" },
  { id: "useWorktreeRosterListener", kind: "hook", class: "skip", why: why.mainStore },
  { id: "useEpicAssemblyListener", kind: "hook", class: "skip", why: why.mainStore },
  { id: "useResolvedRepositoryPathsSync", kind: "hook", class: "skip", why: "moves the worktree watches main owns" },
  { id: "useSyncWaveRescan", kind: "hook", class: "skip", why: "re-scans main's pipelines" },
  { id: "useCompositeOverlayRefresh", kind: "hook", class: "skip", why: "refreshes main's nav overlay" },
  { id: "useActiveTeamStatusTaxonomy", kind: "hook", class: "read-only", why: "reads the active team's board states" },
  { id: "useDashboardStream", kind: "hook", class: "read-only", why: "feeds this window's dashboard streams from broadcasts; it writes nothing" },
  { id: "useEpicReposReassembly", kind: "hook", class: "skip", why: "re-assembles worktrees: one window acts" },
  { id: "useOrgRegistrySync", kind: "hook", class: "skip", why: "follows an agent's team switch, which moves main's active team" },
  { id: "useMoveWorkspaceSync", kind: "hook", class: "skip", why: "replays move intents, which main drives" },
  { id: "useNotesProjection", kind: "hook", class: "skip", why: why.mainStore },
  { id: "useAgentDefinitions", kind: "hook", class: "skip", why: "main's bridge; a mounted Agents tab opens its own" },
  { id: "useConfigurationLive", kind: "hook", class: "skip", why: "main's configuration bridge; a mounted pane reads the stores" },
  { id: "usePrefsLive", kind: "hook", class: "read-only", why: "the global prefs; a satellite skips the owned viewer prefs (main's layout keys)" },
  { id: "useWindowTitle", kind: "hook", class: "skip", why: "main's title; the story that shows a satellite sets its title" },
  { id: "useActiveWorkspaceContext", kind: "hook", class: "read-only", why: "reads the active workspace" },
  { id: "useSourceRepoAttachment", kind: "hook", class: "skip", why: "the track prompt is main's" },
  { id: "deps-ready-ref", kind: "effect", class: "skip", why: "main's dependency gate" },
  { id: "machine-memory", kind: "effect", class: "skip", why: "main keeps the machines' last-known census" },
  { id: "useBootLoad", kind: "hook", class: "read-only", why: "loads the config, org and shortcut state, the platform caps and the profile" },
  { id: "boot-gate-watchdog", kind: "effect", class: "skip", why: "guards main's splash, which a satellite does not render" },
  { id: "external-links", kind: "effect", class: "skip", why: why.shell },
  { id: "deps-check", kind: "effect", class: "skip", why: "main's dependency gate" },
  { id: "workspace-archive", kind: "effect", class: "skip", why: why.mainStore },
  { id: "dep-status-changed", kind: "effect", class: "skip", why: "main's dependency gate" },
  { id: "update-check", kind: "effect", class: "skip", why: `${why.singleton} (its toast relaunches the app)` },
  { id: "menu-action", kind: "effect", class: "skip", why: "the native menu belongs to main" },
  { id: "worktree-file-change", kind: "effect", class: "skip", why: "path event for main's editor inset" },
  { id: "local-profiles-changed", kind: "effect", class: "skip", why: "main's account gate" },
  { id: "fsmonitor-nudge", kind: "effect", class: "skip", why: why.singleton },
  { id: "close-tab-shortcut", kind: "effect", class: "skip", why: "Cmd+W closes main's tabs" },
  { id: "viewer-restore", kind: "effect", class: "skip", why: "restores main's tabs from the app state and shows the window" },
  { id: "close-flush", kind: "effect", class: "skip", why: "main's close flush; Rust closes satellites" },
  { id: "quit-flush", kind: "effect", class: "skip", why: "Rust waits for one ack, from main" },
  { id: "useTerminalLayoutRestore", kind: "hook", class: "run", why: "this window's terminal layout; a satellite starts it only while its slice holds workspaces" },
  { id: "watcher", kind: "effect", class: "skip", why: "starts and stops the watcher main owns" },
];

/** The `run` and `read-only` rows, in `App`'s order: what a satellite mounts. */
export const SATELLITE_ROWS: readonly BootRow[] = Object.freeze(
  BOOT_ROWS.filter((row) => row.class !== "skip"),
);

/** Calls each hook row of `rows`, every render, in their fixed order (so the rules of
 *  hooks hold). Module rows ran at module scope; it renders nothing. */
export function BootRows({ rows }: { rows: readonly BootRow[] }): null {
  for (const row of rows) {
    if (row.kind === "hook") BOOT_EXPORTS[row.id]?.();
  }
  return null;
}
