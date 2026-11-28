// SPDX-License-Identifier: MIT
/**
 * The tile host's one mount site: with the tiles flag off it mounts nothing, so the team view
 * is today's; with it on it hosts the active team's foreground tree and mounts a viewer only
 * for a tile-ref leaf, once.
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

  it("is listed among the tiles flag sites", () => {
    const sites = JSON.parse(
      readFileSync(resolve(__dirname, "../../../shared/lib/tiles-flag-sites.json"), "utf8"),
    ) as Array<{ file: string }>;
    expect(sites.map((site) => site.file)).toContain(
      "src/features/shell/components/tile-host-mount.tsx",
    );
  });
});
