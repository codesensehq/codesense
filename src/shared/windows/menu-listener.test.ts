// SPDX-License-Identifier: MIT
/** One native menu click runs once: the listener registers on this window's webview handle,
 *  `main` runs the action, and a satellite runs a `focused` action itself and forwards the
 *  rest to `main`, once. */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  label: "main",
  handlers: [] as ((event: { payload: string }) => void)[],
  unlistened: 0,
}));

const mocks = vi.hoisted(() => ({
  handleListen: vi.fn(),
  emitTo: vi.fn(async () => {}),
  dispatchMenuAction: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: mocks.emitTo,
  listen: () => {
    throw new Error("the menu listener must not register through the global listen");
  },
}));

vi.mock("@/shared/lib/current-window", () => ({
  MAIN_WINDOW_LABEL: "main",
  currentWindowLabel: () => state.label,
  isMainWindow: () => state.label === "main",
  currentWebviewWindow: () => ({
    listen: async (event: string, handler: (event: { payload: string }) => void) => {
      mocks.handleListen(event);
      state.handlers.push(handler);
      return () => {
        state.unlistened += 1;
      };
    },
  }),
}));

vi.mock("@/app/menu-action-dispatch", () => ({
  dispatchMenuAction: mocks.dispatchMenuAction,
}));

vi.mock("@/shared/lib/shortcuts/registry", () => ({
  findShortcutAction: (id: string) => {
    if (id === "test.focused") return { id, windowScope: "focused" };
    if (id === "viewer.toggle-terminal") return { id };
    if (id === "test.main") return { id, windowScope: "main" };
    return undefined;
  },
}));

import {
  dispatchSatelliteMenuAction,
  MENU_ACTION_EVENT,
  useMenuActionListener,
} from "./menu-listener";

function click(id: string) {
  for (const handler of state.handlers) handler({ payload: id });
}

beforeEach(() => {
  state.label = "main";
  state.handlers = [];
  state.unlistened = 0;
  vi.clearAllMocks();
});

describe("useMenuActionListener", () => {
  it("registers once, on this window's webview handle, never through the global listen", async () => {
    const { unmount } = renderHook(() => useMenuActionListener());
    await vi.waitFor(() => expect(state.handlers).toHaveLength(1));
    expect(mocks.handleListen).toHaveBeenCalledTimes(1);
    expect(mocks.handleListen).toHaveBeenCalledWith(MENU_ACTION_EVENT);
    expect(MENU_ACTION_EVENT).toBe("menu:action");
    unmount();
    await vi.waitFor(() => expect(state.unlistened).toBe(1));
  });

  it("unlistens a registration that resolves after unmount", async () => {
    const { unmount } = renderHook(() => useMenuActionListener());
    unmount();
    await vi.waitFor(() => expect(state.unlistened).toBe(1));
  });

  it("in main, runs every action through dispatchMenuAction and forwards nothing", async () => {
    renderHook(() => useMenuActionListener());
    await vi.waitFor(() => expect(state.handlers).toHaveLength(1));
    act(() => {
      click("settings.open");
      click("viewer.toggle-terminal");
      click("panel:agents");
      click("does.not.exist");
    });
    expect(mocks.dispatchMenuAction.mock.calls).toEqual([
      ["settings.open"],
      ["viewer.toggle-terminal"],
      ["panel:agents"],
      ["does.not.exist"],
    ]);
    expect(mocks.emitTo).not.toHaveBeenCalled();
  });

  it("in a satellite, forwards a main action to main once and does not run it", async () => {
    state.label = "pane-1";
    renderHook(() => useMenuActionListener());
    await vi.waitFor(() => expect(state.handlers).toHaveLength(1));
    act(() => click("viewer.toggle-terminal"));
    expect(mocks.emitTo).toHaveBeenCalledTimes(1);
    expect(mocks.emitTo).toHaveBeenCalledWith("main", "menu:action", "viewer.toggle-terminal");
    expect(mocks.dispatchMenuAction).not.toHaveBeenCalled();
  });

  it("a forwarded action delivered to main runs once and is not forwarded again", async () => {
    state.label = "pane-1";
    dispatchSatelliteMenuAction("viewer.toggle-terminal");
    const [[target, event, id]] = mocks.emitTo.mock.calls as unknown as [[string, string, string]];
    expect([target, event]).toEqual(["main", "menu:action"]);

    state.label = "main";
    renderHook(() => useMenuActionListener());
    await vi.waitFor(() => expect(state.handlers).toHaveLength(1));
    act(() => click(id));
    expect(mocks.dispatchMenuAction).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchMenuAction).toHaveBeenCalledWith("viewer.toggle-terminal");
    expect(mocks.emitTo).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchSatelliteMenuAction", () => {
  beforeEach(() => {
    state.label = "pane-1";
  });

  it("runs a focused action in the satellite and does not forward it", () => {
    dispatchSatelliteMenuAction("test.focused");
    expect(mocks.dispatchMenuAction).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchMenuAction).toHaveBeenCalledWith("test.focused");
    expect(mocks.emitTo).not.toHaveBeenCalled();
  });

  it.each(["viewer.toggle-terminal", "test.main", "panel:agents", "does.not.exist"])(
    "forwards %s to main once and does not run it",
    (id) => {
      dispatchSatelliteMenuAction(id);
      expect(mocks.emitTo).toHaveBeenCalledTimes(1);
      expect(mocks.emitTo).toHaveBeenCalledWith("main", "menu:action", id);
      expect(mocks.dispatchMenuAction).not.toHaveBeenCalled();
    },
  );

  it("forwards a panel id even when an action shares its name", () => {
    dispatchSatelliteMenuAction("panel:test.focused");
    expect(mocks.emitTo).toHaveBeenCalledWith("main", "menu:action", "panel:test.focused");
    expect(mocks.dispatchMenuAction).not.toHaveBeenCalled();
  });
});
