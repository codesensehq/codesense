// SPDX-License-Identifier: MIT
/**
 * What a satellite boots: `satellite-root.tsx` over the real stores, boot rows and
 * commands, on a recorded `invoke` and an in-memory event bus. It takes its content
 * from its slice only, runs the terminal rows only for the slice's workspaces, and
 * never calls a command `main` owns. The last case boots `main.tsx` itself as a
 * satellite, with `App` mocked so a stray import of it shows.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement, useContext, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import mainOnly from "../../../src-tauri/src/windows/command_acl.json";

const host = vi.hoisted(() => ({ main: false }));
const invoked = vi.hoisted(() => [] as string[]);
const bus = vi.hoisted(() => new Map<string, Set<(event: { payload: unknown }) => void>>());
const spies = vi.hoisted(() => ({
  show: vi.fn(async () => {}),
  setBadgeCount: vi.fn(async () => {}),
  sendNotification: vi.fn(),
  startUpdateCheck: vi.fn(async () => {}),
  useWarmPool: vi.fn(),
  watchedSplash: vi.fn(() => null),
  appEvaluated: false,
}));
const boot = vi.hoisted(() => ({
  inject: null as null | { source: unknown; renderer: unknown },
}));

const APP_STATE = JSON.stringify({
  openTabs: { "acme:core": [{ path: "/w/stale.md" }] },
  activeTab: { "acme:core": "/w/stale.md" },
});

vi.mock("@/shared/lib/current-window", async (importActual) => {
  const actual = await importActual<typeof import("@/shared/lib/current-window")>();
  const window = {
    label: "pane-x",
    show: spies.show,
    setBadgeCount: spies.setBadgeCount,
    onCloseRequested: vi.fn(async () => () => {}),
    destroy: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
    listen: vi.fn(async () => () => {}),
    onFocusChanged: vi.fn(async () => () => {}),
    isFocused: vi.fn(async () => true),
  };
  return {
    ...actual,
    isMainWindow: () => host.main,
    currentWindowLabel: () => (host.main ? "main" : "pane-x"),
    currentWindow: () => window,
  };
});

vi.mock("@tauri-apps/api/core", async (importActual) => ({
  ...(await importActual<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (command: string) => {
    invoked.push(command);
    if (command === "load_app_state") return APP_STATE;
    if (command === "local_profile_status" || command === "renderer_profile_status")
      return { active: null };
    if (command === "query_context") return { items: [] };
    if (command === "get_platform_caps") return [];
    if (command === "terminal_activity_snapshot") throw new Error("no host in this test");
    return undefined;
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    const handlers = bus.get(event) ?? new Set();
    handlers.add(handler);
    bus.set(event, handlers);
    return () => handlers.delete(handler);
  }),
  emit: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  sendNotification: spies.sendNotification,
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
}));
vi.mock("@/app/update-check", () => ({ startUpdateCheck: spies.startUpdateCheck }));
vi.mock("@/features/viewer/hooks/use-warm-pool", () => ({ useWarmPool: spies.useWarmPool }));
vi.mock("@/features/shell/components/boot-wait", () => ({ WatchedSplash: spies.watchedSplash }));

vi.mock("@/shared/lib/terminal-layout", async (importActual) => {
  const actual = await importActual<typeof import("@/shared/lib/terminal-layout")>();
  return { ...actual, hydrateTerminalLayout: vi.fn(actual.hydrateTerminalLayout) };
});
vi.mock("@/shared/stores/viewer-store", async (importActual) => {
  const actual = await importActual<typeof import("@/shared/stores/viewer-store")>();
  return { ...actual, applyOwnedViewerPrefs: vi.fn(actual.applyOwnedViewerPrefs) };
});
vi.mock("@/shared/stores/agent-state-store", async (importActual) => {
  const actual = await importActual<typeof import("@/shared/stores/agent-state-store")>();
  return { ...actual, markSessionSeen: vi.fn(actual.markSessionSeen) };
});

// `main.tsx`'s own boot work, which the main.tsx case does not exercise.
vi.mock("@/app/App", () => {
  spies.appEvaluated = true;
  return { default: () => null };
});
vi.mock("@/app/install-global-error-handlers", () => ({ installGlobalErrorHandlers: vi.fn() }));
vi.mock("@/app/renderer-heartbeat", () => ({ startRendererHeartbeat: vi.fn() }));
vi.mock("@/app/mock/install", () => ({ installMockBackend: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/home/me" }));

// The main.tsx case hands its stub slice and renderer to the real root.
vi.mock("@/shared/windows/satellite-root", async (importActual) => {
  const actual = await importActual<typeof import("./satellite-root")>();
  const SatelliteRoot = (props: Parameters<typeof actual.SatelliteRoot>[0]) =>
    actual.SatelliteRoot({ ...props, ...(boot.inject as object | null) });
  return { ...actual, SatelliteRoot };
});

import { VerbConfirmationContext } from "@/features/dashboard/components/verb-confirmation-context";
import { usePrefsStore } from "@/features/dashboard/lib/prefs-store";
import { resolveVirtualTab } from "@/shared/lib/virtual-viewer-registry";
import { hydrateTerminalLayout } from "@/shared/lib/terminal-layout";
import { markSessionSeen } from "@/shared/stores/agent-state-store";
import { useConfigStore } from "@/shared/stores/config-store";
import { useOrgStore } from "@/shared/stores/org-store";
import { applyOwnedViewerPrefs, useViewerStore } from "@/shared/stores/viewer-store";
import { terminalManager } from "@/shared/terminal/terminal-manager";
import {
  installTerminalLayoutHarness,
  seedTerminalTabs,
  terminalHost,
} from "@/test/terminal-layout-harness";

import { SatelliteRoot, type SatelliteContent } from "./satellite-root";
import type { SliceSource, SliceView } from "./slice";
import { sliceWorkspaceIds } from "./slice";

installTerminalLayoutHarness();

const TEAM = "acme:core";

/** A slice source a test drives: `set` swaps the slice and notifies. */
function stubSource(initial: SliceView | null) {
  let slice = initial;
  const listeners = new Set<() => void>();
  const source: SliceSource = {
    current: () => slice,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  return {
    source,
    set(next: SliceView | null) {
      slice = next;
      for (const listener of listeners) listener();
    },
  };
}

const slice = (items: SliceView["items"], layoutRef: string | null = null): SliceView => ({
  label: "pane-x",
  layoutRef,
  items,
});
const fileItem = { kind: "tab", team: TEAM, id: "/w/doc.md" };
const dashboardItem = { kind: "tab", team: TEAM, id: "/w/board.html" };

async function bootSatellite(source: SliceSource, renderer = vi.fn(() => null)) {
  const view = render(createElement(SatelliteRoot, { source, renderer }));
  await waitFor(() => expect(useConfigStore.getState().initialized).toBe(true));
  await act(async () => {});
  return { view, renderer };
}

beforeEach(() => {
  host.main = false;
  invoked.length = 0;
  bus.clear();
  vi.mocked(hydrateTerminalLayout).mockClear();
  vi.mocked(applyOwnedViewerPrefs).mockClear();
  vi.mocked(markSessionSeen).mockClear();
  useConfigStore.setState({ initialized: false });
  useViewerStore.setState({ openTabs: {}, activeTab: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a satellite's content", () => {
  it("mounts no tab from app-state.json and hands its one item to the renderer", async () => {
    const { renderer } = await bootSatellite(stubSource(slice([fileItem])).source);
    expect(invoked).toContain("load_app_state");
    expect(useViewerStore.getState().openTabs).toEqual({});
    const calls = renderer.mock.calls as unknown as [SatelliteContent][];
    expect(calls.map(([content]) => content)).toContainEqual({ item: fileItem });
    for (const [content] of calls) expect(content).toEqual({ item: fileItem });
  });

  it("hands the renderer the layoutRef when the slice names one", async () => {
    const { renderer } = await bootSatellite(stubSource(slice([fileItem], "group-1")).source);
    expect(renderer).toHaveBeenCalled();
    for (const [content] of renderer.mock.calls as unknown as [SatelliteContent][])
      expect(content).toEqual({ layoutRef: "group-1" });
  });

  it("never applies the owned viewer prefs (main's layout keys)", async () => {
    await bootSatellite(stubSource(slice([fileItem])).source);
    act(() => {
      usePrefsStore.setState({
        principal: "p1",
        owned: { viewer: { openTabs: { [TEAM]: [{ path: "/w/owned.md" }] } } },
        ownedReady: true,
      });
    });
    expect(applyOwnedViewerPrefs).not.toHaveBeenCalled();
    expect(useViewerStore.getState().openTabs).toEqual({});
  });
});

describe("the terminal rows in a satellite", () => {
  it("never start the terminal layout restore while the slice holds no workspace", async () => {
    await bootSatellite(stubSource(slice([fileItem])).source);
    expect(hydrateTerminalLayout).not.toHaveBeenCalled();
    expect(invoked).not.toContain("terminal_layout_snapshot");
  });

  it("start it for the slice's workspaces only, and again when they change", async () => {
    const scopes: (readonly string[])[] = [];
    vi.mocked(hydrateTerminalLayout).mockImplementation(async () => {
      scopes.push([...sliceWorkspaceIds()]);
      return () => {};
    });
    const stub = stubSource(slice([{ kind: "workspace", team: TEAM, id: "ws-1" }]));
    await bootSatellite(stub.source);
    await waitFor(() => expect(scopes.at(-1)).toEqual(["ws-1"]));
    act(() => stub.set(slice([{ kind: "workspace", team: TEAM, id: "ws-2" }])));
    await waitFor(() => expect(scopes.at(-1)).toEqual(["ws-2"]));
    expect(new Set(scopes.map((ids) => ids.join()))).toEqual(new Set(["ws-1", "ws-2"]));
  });

  it.each([
    ["file", fileItem],
    ["dashboard", dashboardItem],
  ])("with a %s slice, GC, warm and mark nothing, and run no warm pool", async (_, item) => {
    const ensure = vi.spyOn(terminalManager, "ensure").mockResolvedValue(undefined as never);
    const dispose = vi.spyOn(terminalManager, "dispose").mockImplementation(() => {});
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    useOrgStore.setState({ activeOrgSlug: "acme", activeTeamName: "core" });
    useViewerStore.setState({
      workspaces: { [TEAM]: [{ id: "ws", kind: "generic", cwd: "/w", status: "ready" }] },
      activeWorkspace: { [TEAM]: "ws" },
      terminalVisible: true,
      softClosedWorkspaces: {},
    });
    const ws = seedTerminalTabs(TEAM, "ws", ["a", "b"]);
    await bootSatellite(stubSource(slice([item])).source);
    act(() => terminalHost().setActive(ws, "a"));
    act(() => terminalHost().closeTab("b", "kill"));
    await act(async () => {});
    expect(ensure).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(markSessionSeen).not.toHaveBeenCalled();
    expect(spies.useWarmPool).not.toHaveBeenCalled();
  });

  it("main warms and GCs the same tabs (control)", async () => {
    host.main = true;
    const ensure = vi.spyOn(terminalManager, "ensure").mockResolvedValue(undefined as never);
    const dispose = vi.spyOn(terminalManager, "dispose").mockImplementation(() => {});
    useViewerStore.setState({
      workspaces: { [TEAM]: [{ id: "ws", kind: "generic", cwd: "/w", status: "ready" }] },
    });
    seedTerminalTabs(TEAM, "ws", ["a", "b"]);
    await bootSatellite(stubSource(slice([fileItem])).source);
    act(() => terminalHost().closeTab("b", "kill"));
    expect(ensure).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledWith("b");
  });
});

describe("what a satellite never calls", () => {
  const forbidden = [
    ...mainOnly.map((entry: { name: string }) => entry.name),
    "terminal_layout_snapshot",
    "set_active_team_for_wave",
    "remove_watch",
    "init_watched_cache",
    "reconcile_worktrees_on_launch",
    "set_quit_on_close",
    "set_terminal_server_menu_bar",
    "dashboard_set_background_limit",
  ];

  it("a boot and unmount make no main-only invoke, badge, notification or update check", async () => {
    const { view } = await bootSatellite(stubSource(slice([fileItem])).source);
    view.unmount();
    await act(async () => {});
    expect(invoked.length).toBeGreaterThan(0);
    expect(invoked.filter((command) => forbidden.includes(command))).toEqual([]);
    expect(spies.setBadgeCount).not.toHaveBeenCalled();
    expect(spies.sendNotification).not.toHaveBeenCalled();
    expect(spies.startUpdateCheck).not.toHaveBeenCalled();
    expect(spies.show).not.toHaveBeenCalled();
  });
});

function VerbProbe() {
  const request = useContext(VerbConfirmationContext);
  useEffect(() => {
    void request({
      id: "probe-1",
      caller: { kind: "builtin", dashboard: "virtual://machines" } as never,
      verb: "probeVerb",
      args: {},
      allowAlways: false,
    }).catch(() => {});
  }, [request]);
  return null;
}

describe("booting main.tsx as a satellite", () => {
  it("renders the slice through satellite-root and never evaluates App", async () => {
    const firstRender: { resolved: boolean | null } = { resolved: null };
    const renderer = vi.fn((content: SatelliteContent) => {
      if (firstRender.resolved === null && "item" in content)
        firstRender.resolved = resolveVirtualTab(content.item.id) !== undefined;
      return createElement(VerbProbe);
    });
    const machines = { kind: "tab", team: TEAM, id: "virtual://machines" };
    boot.inject = { source: stubSource(slice([machines])).source, renderer };
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    window.history.replaceState(null, "", "/?window=pane-x");
    document.body.innerHTML = '<div id="root"></div>';
    vi.spyOn(terminalManager, "chooseRenderer").mockImplementation(() => null);

    await import("@/main");
    await waitFor(() => expect(renderer).toHaveBeenCalled(), { timeout: 10_000 });

    expect(spies.appEvaluated).toBe(false);
    expect(renderer.mock.calls[0][0]).toEqual({ item: machines });
    expect(firstRender.resolved).toBe(true);
    expect(spies.watchedSplash).not.toHaveBeenCalled();
    expect(timeouts.mock.calls.filter(([, ms]) => ms === 12_000)).toEqual([]);
    expect(spies.show).not.toHaveBeenCalled();
    // The confirmation layer answers: the request opens its dialog.
    expect(await screen.findByText("Allow probeVerb?")).toBeTruthy();
    boot.inject = null;
  }, 30_000);
});
