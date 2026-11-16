// SPDX-License-Identifier: MIT
import { FrameMessageEvent } from "../../../../tests/support/fixtures/frame";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A chord pressed while a frame has focus reaches the host TWICE in the real app: the
// frame shim forwards it as `codesense:shortcut` (it cannot cancel a host chord), and
// WebKit, seeing the key unhandled, also fires the native menu accelerator, which
// arrives as `menu:action`. Both go through the real registry, gate and stores here;
// only the Tauri edge and the active team are stubbed. vitest has no native menu, so
// the menu half is `dispatchMenuAction(id)`, exactly what App's `menu:action` listener
// calls.
vi.mock("@/features/dashboard/lib/verb-dispatch", () => ({
  verbDispatch: vi.fn(async () => ({ status: "deny", reason: "denied" })),
  verbSettle: vi.fn(async () => undefined),
  verbAnswer: vi.fn(),
}));
vi.mock("../lib/verb-dispatch", () => ({
  verbDispatch: vi.fn(async () => ({ status: "deny", reason: "denied" })),
  verbSettle: vi.fn(async () => undefined),
  verbAnswer: vi.fn(),
}));
vi.mock("@/shared/lib/local-profile-session", () => ({ rendererPrincipal: async () => "42" }));
vi.mock("@/tauri/commands", async () => ({
  ...(await import("../../../../tests/support/fixtures/frame")).frameCommands(),
  bridgeDocContext: async () => null,
  admitRenderedDocument: vi.fn().mockResolvedValue(undefined),
  getHttpApiPort: async () => 9123,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("./dashboard-launch-controller", () => ({
  useRegisterDashboardLaunchController: () => {},
}));
// A team is active; no workspace is focused (the viewer store's workspaces stay empty).
vi.mock("@/shared/lib/team-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/team-key")>()),
  getActiveTeamKey: () => "acme:default",
}));

import { dispatchMenuAction } from "@/app/menu-action-dispatch";
import { isTerminalColumnShown } from "@/features/viewer/lib/terminal-column";
import { useViewerStore } from "@/shared/stores/viewer-store";
import { HtmlViewer, type FrameShortcutHandler } from "./html-viewer";

globalThis.fetch = vi.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch;

/** The centre file tab hands the viewer a handler that only wants the view-toggle chord. */
const fileTabHandler: FrameShortcutHandler = () => false;

const SURFACES = [
  {
    name: "right-pane Inbox chat frame",
    props: {
      filePath: "/org/team/panes/inbox.html",
      teamContentPath: "/org/team/content",
      pane: {
        contentRoot: "/org/team/content",
        panesDir: "/org/team/panes",
        fileName: "inbox.html",
      },
    },
  },
  {
    name: "centre file-tab frame",
    props: {
      filePath: "/repo/page.html",
      teamContentPath: "/repo",
      onFrameShortcut: fileTabHandler,
    },
  },
  {
    name: "Foreman dashboard tab",
    props: {
      filePath: "/org/team/panes/foreman.html",
      teamContentPath: "/org/team/content",
      pane: {
        contentRoot: "/org/team/content",
        panesDir: "/org/team/panes",
        fileName: "foreman.html",
      },
    },
  },
] as const;

function chord(key: string, code: string) {
  return {
    type: "codesense:shortcut",
    key,
    code,
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };
}
const CMD_BACKSLASH = chord("\\", "Backslash");
const CMD_J = chord("j", "KeyJ");

/** The frame's forwarded half of one keystroke. */
function frameHalf(data: Record<string, unknown>) {
  const iframe = document.querySelector("iframe")!;
  const source = {} as Window;
  Object.defineProperty(iframe, "contentWindow", { value: source, configurable: true });
  act(() => {
    window.dispatchEvent(new FrameMessageEvent("message", { data, source }));
  });
}
/** The native menu half of the same keystroke. */
const menuHalf = (id: string) => act(() => dispatchMenuAction(id));

const TOGGLE = "viewer.toggle-terminal";
const cliShown = () => isTerminalColumnShown(useViewerStore.getState());

let testClock = 0;

/** A real press is well apart from the last one. */
const nextPress = () => vi.advanceTimersByTime(1000);

beforeEach(() => {
  // Only the clock: waitFor and promises keep running on real timers.
  // Each test starts a long way after the last, so no earlier press can pair with this one.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime((testClock += 1_000_000));
  // App start: the CLI hidden, no workspace focused.
  useViewerStore.setState({
    layoutMode: "viewer",
    terminalVisible: false,
    lastTerminalMode: "shared",
    activeWorkspace: {},
    rightPaneOpen: false,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe.each(SURFACES)("Cmd-\\ with focus in the $name", ({ props }) => {
  async function mountFrame() {
    render(<HtmlViewer {...props} />);
    await waitFor(() =>
      expect(document.querySelector("iframe")?.getAttribute("src")).toContain(
        "http://f-test.localhost:9123",
      ),
    );
  }

  it.each([
    ["frame message first", true],
    ["menu action first", false],
  ])("one press arriving by both paths toggles once (%s)", async (_name, frameFirst) => {
    await mountFrame();
    expect(cliShown()).toBe(false);
    const press = () => {
      if (frameFirst) {
        frameHalf(CMD_BACKSLASH);
        menuHalf(TOGGLE);
      } else {
        menuHalf(TOGGLE);
        frameHalf(CMD_BACKSLASH);
      }
    };
    press();
    expect(cliShown()).toBe(true);
    nextPress();
    press();
    expect(cliShown()).toBe(false);
  });

  it("a press arriving by one path only still toggles", async () => {
    await mountFrame();
    frameHalf(CMD_BACKSLASH);
    expect(cliShown()).toBe(true);
    nextPress();
    menuHalf(TOGGLE);
    expect(cliShown()).toBe(false);
  });
});

describe("Cmd-\\ press counting", () => {
  it("two menu-only presses toggle twice", () => {
    menuHalf(TOGGLE);
    expect(cliShown()).toBe(true);
    menuHalf(TOGGLE);
    expect(cliShown()).toBe(false);
  });

  it("two quick frame-only presses toggle twice", async () => {
    render(<HtmlViewer {...SURFACES[1].props} />);
    await waitFor(() => expect(document.querySelector("iframe")?.getAttribute("src")).toBeTruthy());
    frameHalf(CMD_BACKSLASH);
    vi.advanceTimersByTime(20);
    frameHalf(CMD_BACKSLASH);
    expect(cliShown()).toBe(false);
  });

  it("a menu arrival well after a frame one is a new press, not its twin", async () => {
    render(<HtmlViewer {...SURFACES[1].props} />);
    await waitFor(() => expect(document.querySelector("iframe")?.getAttribute("src")).toBeTruthy());
    frameHalf(CMD_BACKSLASH);
    vi.advanceTimersByTime(300);
    menuHalf(TOGGLE);
    expect(cliShown()).toBe(false);
  });

  it("two double-path presses a moment apart toggle twice", async () => {
    render(<HtmlViewer {...SURFACES[1].props} />);
    await waitFor(() => expect(document.querySelector("iframe")?.getAttribute("src")).toBeTruthy());
    frameHalf(CMD_BACKSLASH);
    menuHalf(TOGGLE);
    nextPress();
    frameHalf(CMD_BACKSLASH);
    menuHalf(TOGGLE);
    nextPress();
    expect(cliShown()).toBe(false);
  });
});

describe("another menu-mirrored chord sent from a frame", () => {
  it("Cmd-J toggles the right pane once when it arrives by both paths", async () => {
    render(<HtmlViewer {...SURFACES[0].props} />);
    await waitFor(() => expect(document.querySelector("iframe")?.getAttribute("src")).toBeTruthy());
    expect(useViewerStore.getState().rightPaneOpen).toBe(false);
    frameHalf(CMD_J);
    menuHalf("viewer.toggle-right-pane");
    expect(useViewerStore.getState().rightPaneOpen).toBe(true);
    nextPress();
    menuHalf("viewer.toggle-right-pane");
    frameHalf(CMD_J);
    expect(useViewerStore.getState().rightPaneOpen).toBe(false);
  });
});
