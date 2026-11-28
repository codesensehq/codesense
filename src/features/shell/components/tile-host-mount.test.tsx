// SPDX-License-Identifier: MIT
/**
 * The tile host's one mount site: with the tiles flag off it mounts nothing, so the team view
 * is today's; with it on it hosts the active team's foreground tree and mounts a viewer only
 * for a tile-ref leaf, once, in its tile's tab frame.
 */
import { act, render } from "@testing-library/react";
import { readFileSync } from "fs";
import { resolve } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MosaicNode } from "@/shared/tiling/mosaic-tree";
import { VIEWER_PERF } from "@/shared/lib/viewer-perf-config";

const flag = vi.hoisted(() => ({ on: false }));
vi.mock("@/shared/lib/tiles-enabled", () => ({ tilesEnabled: () => Promise.resolve(flag.on) }));

const viewers = vi.hoisted(() => ({ mounts: [] as string[] }));
vi.mock("@/features/dashboard/components/html-viewer", async () => {
  const { useEffect } = await import("react");
  return {
    HtmlViewer: ({ filePath, visible }: { filePath: string; visible: boolean }) => {
      useEffect(() => void viewers.mounts.push(filePath), [filePath]);
      return <iframe title={filePath} data-visible={String(visible)} />;
    },
  };
});

// The content kinds' bodies, each a marker: the mount test is about which body a key mounts.
vi.mock("@/features/shell/slots/dashboard-tile-body", () => ({
  DashboardTileBody: ({ tileKey }: { tileKey: string }) => <div data-body-of={tileKey} />,
  InboxTileBody: ({ tileKey }: { tileKey: string }) => <div data-body-of={tileKey} />,
}));
vi.mock("@/features/shell/right-pane/builtin-panels", () => ({
  ScratchSlotBody: ({ panelId }: { panelId: string }) => <div data-body-of={panelId} />,
}));
vi.mock("@/features/viewer/components/story-tile-body", () => ({
  StoryTileBody: ({ tileKey }: { tileKey: string }) => <div data-body-of={tileKey} />,
}));
vi.mock("@/features/viewer/components/diff-tile-body", () => ({
  DiffTileBody: ({ tileKey }: { tileKey: string }) => <div data-body-of={tileKey} />,
}));

const store = vi.hoisted(() => ({ root: null as unknown }));
vi.mock("@/shared/stores/viewer-store", () => ({
  useViewerStore: (select: (s: unknown) => unknown) => select({}),
  activeForegroundLayout: () => ({ root: store.root }),
}));
vi.mock("@/shared/stores/org-store", () => ({
  useOrgStore: (select: (s: unknown) => unknown) =>
    select({ orgs: [{ slug: "acme", org_root: "/orgs/acme" }] }),
}));
vi.mock(
  "@/components/ui/resizable",
  async () => (await import("@/shared/tiling/tile-host.test-util")).resizableMock,
);

import { TileHostMount } from "./tile-host-mount";

const leaf = (id: string): MosaicNode => ({ kind: "leaf", id });
const TREE: MosaicNode = {
  kind: "split",
  axis: "row",
  children: [leaf("ws-1"), leaf("doc:core/board.html")],
  sizes: [50, 50],
};

async function mount() {
  const view = render(<TileHostMount teamKey="acme:core" />);
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

beforeEach(() => {
  viewers.mounts = [];
  store.root = TREE;
});

describe("the tile host mount", () => {
  it("mounts nothing with the tiles flag off, and the team view keeps its keep-alive", async () => {
    flag.on = false;
    const { container } = await mount();
    expect(container.innerHTML).toBe("");
    expect(viewers.mounts).toEqual([]);
    expect(VIEWER_PERF.keepAliveMaxViewers).toBeGreaterThan(0);
  });

  it("with the flag on, mounts one viewer for the doc leaf and none for the workspace", async () => {
    flag.on = true;
    const { container } = await mount();
    expect(container.querySelector("[data-tile-host]")).toBeTruthy();
    expect(viewers.mounts).toEqual(["/orgs/acme/core/content/board.html"]);
    expect(container.querySelector('[data-tile-body="ws-1"] [data-tile-kind]')).toBeNull();
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("puts each tile-ref body under its tab bar, and no bar on a workspace leaf", async () => {
    flag.on = true;
    const { container } = await mount();
    const doc = container.querySelector('[data-tile-body="doc:core/board.html"]');
    expect(
      doc?.querySelector('[role="tablist"] [data-tile-tab="doc:core/board.html"]'),
    ).toBeTruthy();
    expect(doc?.querySelector("[data-tile-tab-name]")?.textContent).toContain("board.html");
    expect(container.querySelector('[data-tile-body="ws-1"] [role="tablist"]')).toBeNull();
  });

  it.each([
    ["dashboard:team:acme:core/board", "dashboard:team:acme:core/board"],
    ["story-page:DEMO-63", "story-page:DEMO-63"],
    ["diff:source:wt-demo-63", "diff:source:wt-demo-63"],
    ["notes:scratch", "tile:notes:scratch"],
    ["inbox:acme", "inbox:acme"],
  ])("mounts the %s body in its frame", async (key, marker) => {
    flag.on = true;
    store.root = {
      kind: "split",
      axis: "row",
      children: [leaf("ws-1"), leaf(key)],
      sizes: [50, 50],
    };
    const { container } = await mount();
    const body = container.querySelector(`[data-tile-body="${key}"]`);
    expect(body?.querySelector(`[data-tile-tab="${key}"]`)).toBeTruthy();
    expect(body?.querySelectorAll(`[data-body-of="${marker}"]`)).toHaveLength(1);
  });

  it("is listed among the tiles flag sites", () => {
    const sites = JSON.parse(
      readFileSync(resolve(__dirname, "../../../shared/lib/tiles-flag-sites.json"), "utf8"),
    ) as Array<{ file: string }>;
    expect(sites.map((site) => site.file)).toContain(
      "src/features/shell/components/tile-host-mount.tsx",
    );
  });
});
