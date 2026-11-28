// SPDX-License-Identifier: MIT
/**
 * A satellite window boots the same bundle as `main` but must not write the
 * app state, push the viewer mirror, or answer main-only events. The cases run
 * the real store, commands and listener helper over a recorded `invoke` and an
 * in-memory event bus, once as `main` (the control) and once as a satellite.
 */
import { render, renderHook } from "@testing-library/react";
import { ThemeProvider } from "next-themes";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ main: true }));
const invoked = vi.hoisted(() => [] as string[]);
const bus = vi.hoisted(() => new Map<string, Set<(event: { payload: unknown }) => void>>());
const prefsViews = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/shared/lib/current-window", async (importActual) => ({
  ...(await importActual<typeof import("@/shared/lib/current-window")>()),
  isMainWindow: () => host.main,
}));

vi.mock("@tauri-apps/api/core", async (importActual) => ({
  ...(await importActual<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (command: string, args?: { scope?: string }) => {
    invoked.push(command);
    if (command === "configuration_prepare") {
      return structuredClone(
        prefsViews.get(args?.scope === "global" ? "prefs:global" : "prefs:42:native"),
      );
    }
    if (command === "load_app_state") return "{}";
    if (command === "window_get_slice") {
      return {
        label: "main",
        kind: "main",
        version: 1,
        layoutRef: null,
        items: [],
        pending: false,
      };
    }
    if (command === "local_profile_status") return { active: null };
    if (command === "query_context") return { items: [] };
    return undefined;
  }),
}));

const busListen = vi.hoisted(
  () => async (event: string, handler: (event: { payload: unknown }) => void) => {
    const handlers = bus.get(event) ?? new Set();
    handlers.add(handler);
    bus.set(event, handlers);
    return () => handlers.delete(handler);
  },
);

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(busListen),
  emit: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ listen: busListen }),
}));

import { useSyncWaveRescan } from "@/app/hooks/use-sync-wave-rescan";
import { useMcpActions } from "@/shared/hooks/use-mcp-actions";
import { connectPrefs } from "@/features/dashboard/lib/prefs-client";
import { bindPrefsConsumers } from "@/features/dashboard/lib/prefs-live";
import { LiveHub, type HubSnapshot } from "@/features/dashboard/lib/live-hub";
import { subscribeContext } from "@/shared/lib/context-query/subscribe-context";
import { useFileRefreshStore } from "@/shared/stores/file-refresh-store";
import { useViewerStore } from "@/shared/stores/viewer-store";
import { pushViewerState, saveAppState } from "@/tauri/commands";
import {
  CONTEXT_FILE_CHANGE_EVENT,
  CONTEXT_INDEX_CHANGED_EVENT,
  SYNC_WAVE_COMPLETED_EVENT,
} from "@/tauri/events";
import { AppThemeProvider } from "@/themes/theme-provider";

import { listenScoped } from "./listen-scoped";
import { useSatellitePathRefresh } from "./path-listeners";
import { installSliceSource } from "./slice";
import { useMainWindowRegistry } from "./use-main-window-registry";
import { LISTENER_INVENTORY } from "./listener-inventory";

const REPO = "/test/repo";

function deliver(event: string, payload: unknown) {
  for (const handler of bus.get(event) ?? []) handler({ payload });
}

function rowScope(file: string, event: string) {
  const row = LISTENER_INVENTORY.find((r) => r.file === file && r.event === event);
  if (!row) throw new Error(`no inventory row for ${file} ${event}`);
  return row.scope;
}

/** Open two tabs, switch between them, and let the debounced save and the mirror push run. */
async function changeTabs() {
  useViewerStore.setState({ stateLoaded: true, openTabs: {}, activeTab: {} });
  const store = useViewerStore.getState();
  store.openFile(REPO, REPO, "a.md");
  store.openFile(REPO, REPO, "b.md");
  store.setActiveTab(REPO, REPO, "a.md");
  await vi.advanceTimersByTimeAsync(1000);
  await useViewerStore.getState().flushPersist();
}

beforeEach(() => {
  host.main = true;
  invoked.length = 0;
  bus.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a satellite writes nothing a main window owns", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("main saves the app state and pushes the viewer mirror after a tab change (control)", async () => {
    await changeTabs();
    expect(invoked).toContain("save_app_state");
    expect(invoked).toContain("push_viewer_state");
  });

  it("a satellite makes no save_app_state and no push_viewer_state invoke after a tab change", async () => {
    host.main = false;
    await changeTabs();
    // The org, config, shortcut and dashboard stores save through the same command at boot.
    await saveAppState("{}", true);
    await pushViewerState({ openTabs: {} });
    expect(invoked.filter((name) => name === "save_app_state")).toEqual([]);
    expect(invoked.filter((name) => name === "push_viewer_state")).toEqual([]);
  });
});

describe("only main runs main's registry client", () => {
  it.each([
    { main: true, calls: ["window_get_slice", "window_ready"], listening: 1 },
    { main: false, calls: [], listening: 0 },
  ])("main=$main: the registry client runs only in main", async ({ main, calls, listening }) => {
    host.main = main;
    const { unmount } = renderHook(() => useMainWindowRegistry());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      invoked.filter((name) => name === "window_get_slice" || name === "window_ready"),
    ).toEqual(calls);
    expect(bus.get("window:slice")?.size ?? 0).toBe(listening);
    unmount();
  });
});

describe("a satellite registers listeners by their inventory class", () => {
  beforeEach(() => {
    host.main = false;
  });

  it("mounting the real hooks registers every-window listeners and no main-only one", async () => {
    const mount = async (main: boolean) => {
      host.main = main;
      bus.clear();
      const { unmount } = renderHook(() => {
        useMcpActions();
        useSyncWaveRescan();
      });
      await vi.waitFor(() => expect(bus.has(SYNC_WAVE_COMPLETED_EVENT)).toBe(true));
      const events = [...bus.keys()];
      unmount();
      return events;
    };
    expect(await mount(true)).toEqual(expect.arrayContaining(["mcp:set-viewer-state"]));
    const satellite = await mount(false);
    expect(satellite).toEqual([SYNC_WAVE_COMPLETED_EVENT]);
    expect(rowScope("shared/hooks/use-mcp-actions.ts", "mcp:set-viewer-state")).toBe("main-only");
    expect(rowScope("app/hooks/use-sync-wave-rescan.ts", "SYNC_WAVE_COMPLETED_EVENT")).toBe(
      "every-window",
    );
  });

  it("sees context-index-changed live, and not context-file-change", async () => {
    const updates = vi.fn();
    const stop = subscribeContext({} as never, updates, "satellite-test");
    await vi.waitFor(() => expect(updates).toHaveBeenCalledTimes(1));

    const fileChanges = vi.fn();
    await listenScoped(
      CONTEXT_FILE_CHANGE_EVENT,
      rowScope("app/App.tsx", "CONTEXT_FILE_CHANGE_EVENT"),
      fileChanges,
    );

    deliver(CONTEXT_INDEX_CHANGED_EVENT, { orgs: [], allOrgs: true, truncated: false });
    deliver(CONTEXT_FILE_CHANGE_EVENT, { file_path: "/ctx/a.md" });

    await vi.waitFor(() => expect(updates).toHaveBeenCalledTimes(2));
    expect(fileChanges).not.toHaveBeenCalled();
    stop();
  });

  it("refreshes the tab it holds on a routed context-file-change, and not another file's", async () => {
    expect(rowScope("shared/windows/path-listeners.ts", "CONTEXT_FILE_CHANGE_EVENT")).toBe(
      "owning-window",
    );
    const uninstall = installSliceSource({
      current: () => ({
        label: "sat-1",
        kind: "satellite",
        version: 1,
        layoutRef: null,
        items: [{ kind: "tab", team: "acme:docs", id: `${REPO}/a.md` }],
      }),
      subscribe: () => () => {},
    });
    useFileRefreshStore.setState({ contentRefreshKeys: {} });
    const { unmount } = renderHook(() => useSatellitePathRefresh());
    await vi.waitFor(() => expect(bus.get(CONTEXT_FILE_CHANGE_EVENT)?.size).toBe(1));

    const held = () => useFileRefreshStore.getState().contentRefreshKeys["team:acme:docs"];
    deliver(CONTEXT_FILE_CHANGE_EVENT, { repo_path: REPO, file_path: `${REPO}/b.md` });
    expect(held()).toBeUndefined();
    deliver(CONTEXT_FILE_CHANGE_EVENT, { repo_path: REPO, file_path: `${REPO}/a.md` });
    expect(held()).toBe(1);
    unmount();
    uninstall();
  });

  it("does not call an owning-window handler for a session it does not own", async () => {
    const handler = vi.fn();
    await listenScoped(
      "pty-exit",
      rowScope("shared/terminal/terminal-manager.ts", "pty-exit"),
      handler,
    );
    deliver("pty-exit", { session_id: "held-by-main" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("follows an app theme change the live hub delivers as a prefs delta", async () => {
    const view: HubSnapshot = {
      topic: "prefs",
      viewKey: "prefs:global",
      rev: 1,
      snapshot: [
        {
          id: '["viewer","settings","editorLineWrap"]',
          path: ["viewer", "settings", "editorLineWrap"],
          value: "off",
        },
      ],
    } as HubSnapshot;
    prefsViews.set("prefs:global", view);
    prefsViews.set("prefs:42:native", { ...view, viewKey: "prefs:42:native", snapshot: [] });
    const subscriptions = new Map<string, string>();
    const hub = new LiveHub({
      read: async (_topic, key, _since, options) => {
        if (options) subscriptions.set(key, options.subscriptionId);
        return structuredClone(prefsViews.get(key) as HubSnapshot);
      },
      listen: (event, handler) =>
        listenScoped(event, rowScope("features/dashboard/lib/live-hub.ts", "{event}"), handler),
      unsubscribe: async () => {},
      readUi: async () => ({}),
      writeUi: async () => ({}),
    });
    useViewerStore.setState({
      stateLoaded: true,
      settings: useViewerStore.getInitialState().settings,
    });
    host.main = false;
    const root = document.documentElement;
    const before = useViewerStore.getState().settings.appTheme;
    const stop = bindPrefsConsumers();
    const connection = connectPrefs("42", hub);
    await connection.live;
    render(
      createElement(
        ThemeProvider,
        { attribute: "class", defaultTheme: "dark" },
        createElement(AppThemeProvider),
      ),
    );
    expect(before).not.toBe("dracula");
    expect(root.dataset.appTheme).not.toBe("dracula");

    deliver("codesense:subscription-delta", {
      baseRev: 1,
      subscriptionId: subscriptions.get("prefs:global"),
      delta: {
        topic: "prefs",
        viewKey: "prefs:global",
        rev: 2,
        total: 2,
        removes: [],
        upserts: [
          {
            id: '["viewer","settings","appTheme"]',
            path: ["viewer", "settings", "appTheme"],
            value: "dracula",
          },
        ],
      },
    });

    await vi.waitFor(() => expect(useViewerStore.getState().settings.appTheme).toBe("dracula"));
    await vi.waitFor(() => expect(root.dataset.appTheme).toBe("dracula"));
    expect(root.classList.contains("dark")).toBe(true);
    connection.dispose();
    stop();
    hub.dispose();
  });
});
