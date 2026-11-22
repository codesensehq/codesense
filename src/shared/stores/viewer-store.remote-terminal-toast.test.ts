// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useViewerStore, type Workspace } from "./viewer-store";
import * as shortcutsStore from "./shortcuts-store";
import { useShortcutsStore } from "./shortcuts-store";
import { logger } from "@/shared/lib/logger";
import { installTerminalLayoutHarness } from "@/test/terminal-layout-harness";
import { restorePlatform, setPlatform } from "@/test/platform";

const { toast } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock("sonner", () => ({ toast }));

vi.mock("@/tauri/commands", () => ({
  LOCAL_MACHINE_ID: "local",
  saveAppState: vi.fn().mockResolvedValue(undefined),
  loadAppState: vi.fn().mockResolvedValue("{}"),
  pushViewerState: vi.fn().mockResolvedValue(undefined),
}));

installTerminalLayoutHarness();

const teamKey = "test-org:default";
const remote: Workspace = {
  id: "ws-remote",
  kind: "generic",
  cwd: "/h",
  status: "ready",
  location: { kind: "machine", machineId: "box", requestId: "r" },
} as Workspace;

/** The toast a terminal opened in a workspace on another machine shows. */
async function refusedToast(): Promise<string> {
  await useViewerStore
    .getState()
    .addTerminalTab(teamKey, { id: "t1", sessionId: "s1", label: "zsh" } as never, remote.id)
    .catch(() => {});
  await vi.waitFor(() => expect(toast).toHaveBeenCalled());
  return String(toast.mock.calls.at(-1)?.[0]);
}

beforeEach(() => {
  toast.mockClear();
  useShortcutsStore.setState({ shortcuts: {} });
  useViewerStore.setState({
    workspaces: { [teamKey]: [remote] },
    activeWorkspace: { [teamKey]: remote.id },
    softClosedWorkspaces: {},
  });
});
afterEach(() => {
  restorePlatform();
  vi.restoreAllMocks();
});

describe("the toast for a terminal in a workspace on another machine", () => {
  it("names ⌘T on macOS, where the terminal answers to it too", async () => {
    setPlatform("MacIntel");
    expect(await refusedToast()).toBe(
      "This workspace lives on a machine: open its terminals with ⌘T or the new-terminal menu",
    );
  });

  it.each(["Win32", "Linux x86_64"])(
    "names no chord on %s, where the terminal's chord is Ctrl+Shift+T",
    async (platform) => {
      setPlatform(platform);
      expect(await refusedToast()).toBe(
        "This workspace lives on a machine: open its terminals with the new-terminal menu",
      );
    },
  );

  it("follows a rebind and names no chord when unbound", async () => {
    setPlatform("MacIntel");
    useShortcutsStore.setState({ shortcuts: { "viewer.new-terminal-tab": "" } });
    expect(await refusedToast()).toBe(
      "This workspace lives on a machine: open its terminals with the new-terminal menu",
    );
  });

  it("still shows the toast, without a chord, and logs when the chord lookup fails", async () => {
    setPlatform("MacIntel");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(shortcutsStore, "getToastShortcut").mockImplementation(() => {
      throw new Error("chunk load failed");
    });
    expect(await refusedToast()).toBe(
      "This workspace lives on a machine: open its terminals with the new-terminal menu",
    );
    expect(warn).toHaveBeenCalledWith(
      "terminal",
      expect.stringContaining("open terminal tab failed: chunk load failed"),
    );
  });
});
