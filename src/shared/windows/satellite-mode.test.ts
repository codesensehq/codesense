// SPDX-License-Identifier: MIT
/**
 * A satellite window boots the same bundle as `main` but must not write the
 * app state, push the viewer mirror, or answer main-only events. The cases run
 * the real store, commands and listener helper over a recorded `invoke` and an
 * in-memory event bus, once as `main` (the control) and once as a satellite.
 */
import { act, render, screen } from "@testing-library/react";
import { ThemeProvider, useTheme } from "next-themes";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ main: true }));
const invoked = vi.hoisted(() => [] as string[]);
const bus = vi.hoisted(() => new Map<string, Set<(event: { payload: unknown }) => void>>());

vi.mock("@/shared/lib/current-window", async (importActual) => ({
  ...(await importActual<typeof import("@/shared/lib/current-window")>()),
  isMainWindow: () => host.main,
}));

vi.mock("@tauri-apps/api/core", async (importActual) => ({
  ...(await importActual<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (command: string) => {
    invoked.push(command);
    if (command === "load_app_state") return "{}";
    if (command === "local_profile_status") return { active: null };
    if (command === "query_context") return { items: [] };
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

import { subscribeContext } from "@/shared/lib/context-query/subscribe-context";
import { useViewerStore } from "@/shared/stores/viewer-store";
import { pushViewerState, saveAppState } from "@/tauri/commands";
import { CONTEXT_FILE_CHANGE_EVENT, CONTEXT_INDEX_CHANGED_EVENT } from "@/tauri/events";

import { listenScoped } from "./listen-scoped";
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

describe("a satellite registers listeners by their inventory class", () => {
  beforeEach(() => {
    host.main = false;
  });

  it("registers no main-only row and every every-window and owning-window row", async () => {
    const registered: string[] = [];
    for (const row of LISTENER_INVENTORY) {
      const key = `${row.file} ${row.event}`;
      bus.clear();
      await listenScoped(key, row.scope, () => {});
      if (bus.get(key)?.size) registered.push(key);
    }
    const expected = LISTENER_INVENTORY.filter((row) => row.scope !== "main-only").map(
      (row) => `${row.file} ${row.event}`,
    );
    expect(registered).toEqual(expected);
    expect(LISTENER_INVENTORY.some((row) => row.scope === "main-only")).toBe(true);
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

  it("follows a theme change made in another window", async () => {
    function Shown() {
      return createElement("span", { "data-testid": "theme" }, useTheme().resolvedTheme);
    }
    render(
      createElement(
        ThemeProvider,
        { attribute: "class", defaultTheme: "dark" },
        createElement(Shown),
      ),
    );
    expect(screen.getByTestId("theme").textContent).toBe("dark");

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "theme", newValue: "light" }));
    });

    expect(screen.getByTestId("theme").textContent).toBe("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });
});
