// SPDX-License-Identifier: MIT
/**
 * The tiles flag's local setting, `viewer.settings.tiles`: the settings writer persists it in
 * app-state, a missing or non-boolean value reads as off, and a change acts at the next launch,
 * since `tilesEnabled()` keeps the value the app read at startup.
 */
import "@/test/prefs-state-fixture";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetTilesEnabledForTests, tilesEnabled } from "@/shared/lib/tiles-enabled";

import { useViewerStore } from "./viewer-store";

vi.mock("@/tauri/commands", () => ({
  saveAppState: vi.fn().mockResolvedValue(undefined),
  loadAppState: vi.fn().mockResolvedValue("{}"),
  pushViewerState: vi.fn().mockResolvedValue(undefined),
  checkPathExists: vi.fn().mockResolvedValue(true),
  listNotes: vi.fn().mockResolvedValue([]),
  getTilesEnabled: vi.fn().mockResolvedValue(false),
  detectTools: vi.fn().mockResolvedValue({
    terminals: [],
    editors: [],
    default_terminal: "",
    default_editor: "",
  }),
}));

import * as commands from "@/tauri/commands";

async function loadSettings(settings: Record<string, unknown>) {
  vi.mocked(commands.loadAppState).mockResolvedValue(
    JSON.stringify({ viewer: { schemaVersion: 8, settings } }),
  );
  await useViewerStore.getState().loadPersistedState();
  return useViewerStore.getState().settings;
}

/** The viewer settings the last app-state save that holds them wrote. */
const savedSettings = (): { tiles?: unknown } | undefined =>
  vi
    .mocked(commands.saveAppState)
    .mock.calls.map(([json]) => JSON.parse(json as string)?.viewer?.settings)
    .filter(Boolean)
    .at(-1);

beforeEach(() => {
  useViewerStore.setState({ stateLoaded: false });
  vi.mocked(commands.saveAppState).mockClear();
  resetTilesEnabledForTests();
});

describe("the tiles setting", () => {
  it("is written to app-state by the settings writer", async () => {
    await loadSettings({});
    useViewerStore.getState().updateSettings({ tiles: true });
    await vi.waitFor(() => expect(savedSettings()?.tiles).toBe(true));
    expect(useViewerStore.getState().settings.tiles).toBe(true);
  });

  it("reads back a saved value", async () => {
    expect((await loadSettings({ tiles: true })).tiles).toBe(true);
    expect((await loadSettings({ tiles: false })).tiles).toBe(false);
  });

  it.each([
    ["missing", {}],
    ["a string", { tiles: "yes" }],
    ["a number", { tiles: 1 }],
    ["null", { tiles: null }],
  ])("reads as off when %s", async (_name, settings) => {
    expect((await loadSettings(settings)).tiles ?? false).toBe(false);
  });

  it("acts at the next launch: the session keeps the flag it read at startup", async () => {
    await loadSettings({ tiles: false });
    expect(await tilesEnabled()).toBe(false);
    vi.mocked(commands.getTilesEnabled).mockClear();
    useViewerStore.getState().updateSettings({ tiles: true });
    await vi.waitFor(() => expect(savedSettings()?.tiles).toBe(true));
    expect(await tilesEnabled()).toBe(false);
    expect(commands.getTilesEnabled).not.toHaveBeenCalled();
  });
});
