// SPDX-License-Identifier: MIT
import { forwardRef, useImperativeHandle } from "react";
import { act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@/test-utils";

import { PipelineStatusNav } from "./pipeline-status-nav";
import type { DerivedPipelineTree } from "@/shared/lib/pipeline-graph/types";
import type { FileEntry } from "@/tauri/commands";
import {
  buildStoryRef,
  buildTree,
  type BuildTreeOptions,
} from "@/shared/lib/pipeline-graph/test-fixtures/derived-tree";

// The reveal effect scrolls through the virtual list's imperative handle; spy on
// it instead of measuring a real virtualizer (jsdom has no layout).
const scrollToIndex = vi.fn();
// The rows the list was last given, so a scroll's index can be checked against its row.
const listItems = vi.fn<(items: unknown[]) => void>();
const listedItems = (): unknown[] => listItems.mock.calls.at(-1)?.[0] ?? [];
vi.mock("@/shared/components/virtual-list", () => ({
  VirtualList: forwardRef<unknown, { items: unknown[] }>(function VirtualListStub(props, ref) {
    listItems(props.items);
    useImperativeHandle(ref, () => ({ scrollToIndex, getScrollElement: () => null }), []);
    return null;
  }),
}));

vi.mock("@/shared/lib/team-key", () => ({
  useActiveTeamKey: () => "/repo",
  getActiveTeamKey: () => "/repo",
  buildTeamKey: (orgSlug: string, teamName: string | null) => `${orgSlug}:${teamName ?? "_none"}`,
  NO_TEAM_SENTINEL: "_no_team:_none",
}));

let mockExpandedPaths: Record<string, string[]> = {};
let mockRevealCounter: Record<string, number> = {};
vi.mock("@/shared/stores/viewer-store", () => ({
  useViewerStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        navLens: {},
        statusNavExpandedPaths: mockExpandedPaths,
        revealCounter: mockRevealCounter,
        toggleStatusNavExpanded: vi.fn(),
      }),
    {
      subscribe: () => () => {},
      getState: () => ({
        toggleStatusNavExpanded: vi.fn(),
        readViewState: () => undefined,
        captureViewState: () => {},
      }),
    },
  ),
}));

// Folder listings: each call waits until the test resolves it, so the listing
// lands after the reveal has started.
const pendingListings = new Map<string, (entries: FileEntry[]) => void>();
vi.mock("@/tauri/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/tauri/commands")>();
  return {
    ...actual,
    listDirectory: (path: string) =>
      path === "/repo"
        ? Promise.resolve([fileEntry("/repo/assets", true)])
        : new Promise<FileEntry[]>((resolve) => pendingListings.set(path, resolve)),
  };
});

function fileEntry(path: string, isDir = false): FileEntry {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return {
    name,
    path,
    is_dir: isDir,
    extension: isDir || !name.includes(".") ? null : name.slice(name.lastIndexOf(".") + 1),
    size: isDir ? null : 1,
  };
}

function makeTree(overrides?: BuildTreeOptions & Partial<DerivedPipelineTree>) {
  return buildTree("", { absoluteDirPath: "/repo", ...overrides });
}

function story(name: string) {
  return buildStoryRef(name, { absolutePath: `/repo/${name}`, status: "todo" });
}

// requestAnimationFrame under test control: a frame runs only when flushed, so a
// `flatItems` change can land between the reveal and its scroll.
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
function flushFrames() {
  const due = [...frames.values()];
  frames = new Map();
  act(() => due.forEach((cb) => cb(0)));
}

const handlers = { onFileSelect: vi.fn(), onDrillPathChange: vi.fn(), onStatusChange: vi.fn() };

function renderNav(tree: DerivedPipelineTree, selectedPath: string) {
  const ui = (t: DerivedPipelineTree, p: string) => (
    <PipelineStatusNav
      tree={t}
      repoPath="/repo"
      viewerRootPath="/repo"
      selectedPath={p}
      {...handlers}
    />
  );
  const view = render(ui(tree, selectedPath));
  return {
    rerenderTree: (t: DerivedPipelineTree) => view.rerender(ui(t, selectedPath)),
    rerender: () => view.rerender(ui(tree, selectedPath)),
  };
}

describe("PipelineStatusNav reveal scroll", () => {
  beforeEach(() => {
    scrollToIndex.mockClear();
    listItems.mockClear();
    pendingListings.clear();
    frames = new Map();
    nextFrame = 1;
    mockExpandedPaths = {};
    mockRevealCounter = {};
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("scrolls to a generic file whose listing lands after the reveal, even if the list changes again before the frame", async () => {
    mockExpandedPaths = { "/repo": ["/repo/assets"] };
    const tree = makeTree({ stories: [story("a.md")] });
    const { rerenderTree } = renderNav(tree, "/repo/assets/sample.ts");

    // The folder is expanded but not yet listed, so the target has no row.
    await vi.waitFor(() => expect(pendingListings.has("/repo/assets")).toBe(true));
    expect(scrollToIndex).not.toHaveBeenCalled();

    // The listing arrives: the row appears and a frame is scheduled.
    await act(async () =>
      pendingListings.get("/repo/assets")!([fileEntry("/repo/assets/sample.ts")]),
    );
    expect(frames.size).toBe(1);

    // Another listing lands (list changes) before that frame runs.
    rerenderTree(makeTree({ stories: [story("a.md"), story("b.md")] }));
    flushFrames();

    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    const [index] = scrollToIndex.mock.calls[0];
    expect(JSON.stringify(listedItems()[index])).toContain("/repo/assets/sample.ts");
  });

  it.each([
    ["story", "/repo/target.md", { stories: [story("target.md")] }],
    ["doc", "/repo/notes.md", { docs: [{ fileName: "notes.md", filePath: "/repo/notes.md" }] }],
    ["image", "/repo/shot.png", { docs: [{ fileName: "shot.png", filePath: "/repo/shot.png" }] }],
  ])("scrolls to a %s row", (_kind, path, overrides) => {
    renderNav(makeTree(overrides), path);
    flushFrames();
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it("scrolls again to the same row when the reveal counter is bumped", () => {
    const { rerender } = renderNav(
      makeTree({ stories: [story("a.md"), story("target.md")] }),
      "/repo/target.md",
    );
    flushFrames();
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    const [index] = scrollToIndex.mock.calls[0];
    expect(JSON.stringify(listedItems()[index])).toContain("/repo/target.md");

    // A double-click on the file's tab bumps the counter; nothing else changes.
    mockRevealCounter = { "/repo": 1 };
    rerender();
    flushFrames();
    expect(scrollToIndex).toHaveBeenCalledTimes(2);
    expect(scrollToIndex.mock.calls[1][0]).toBe(index);
  });
});
