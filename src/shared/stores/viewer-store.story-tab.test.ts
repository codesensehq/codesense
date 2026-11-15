// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useViewerStore } from "./viewer-store";

vi.mock("@/tauri/commands", () => ({
  saveAppState: vi.fn().mockResolvedValue(undefined),
  loadAppState: vi.fn().mockResolvedValue("{}"),
  pushViewerState: vi.fn().mockResolvedValue(undefined),
}));

const TEAM = "acme:web";
const STORY = "/ctx/acme/web/content/stories/SV-1.md";

// A story file's tab is its own path, whichever door opened it: the Files tree and a pipeline card
// preview it, a double click, a link or an inbox chip pin it. Opening it again is one tab, focused.
describe("a story file's tab", () => {
  beforeEach(() => useViewerStore.setState({ openTabs: {}, activeTab: {} }));
  const tabs = () => (useViewerStore.getState().openTabs[TEAM] ?? []).map((t) => t.path);

  it("is one tab however many times and ways it is opened", () => {
    const store = useViewerStore.getState();
    store.openFilePreview(TEAM, "", STORY);
    store.openFile(TEAM, "", STORY);
    store.openFilePreview(TEAM, "", STORY);
    store.openFile(TEAM, "", STORY);
    expect(tabs()).toEqual([STORY]);
    expect(useViewerStore.getState().activeTab[TEAM]).toBe(STORY);
  });

  it("is focused again, not duplicated, when another tab was in front", () => {
    const store = useViewerStore.getState();
    store.openFile(TEAM, "", STORY);
    store.openFile(TEAM, "", "/ctx/acme/web/content/README.md");
    expect(useViewerStore.getState().activeTab[TEAM]).toBe("/ctx/acme/web/content/README.md");
    store.openFilePreview(TEAM, "", STORY);
    expect(tabs().filter((p) => p === STORY)).toHaveLength(1);
    expect(useViewerStore.getState().activeTab[TEAM]).toBe(STORY);
  });
});
