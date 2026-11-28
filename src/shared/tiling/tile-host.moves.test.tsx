// SPDX-License-Identifier: MIT
/**
 * The right pane's proofs, on the tile host: a reordered tile, a tile grouped into another
 * cell's tabs and a tab split out into its own cell each keep the same DOM node, mounted once.
 */
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { moveLeaf, pruneLeaf, splitAt, type MosaicNode } from "./mosaic-tree";
import { TileHost, type CellTabs, type TileBodyContext } from "./tile-host";
import { bodyCounts, FakeBody, row } from "./tile-host.test-util";

vi.mock(
  "@/components/ui/resizable",
  async () => (await import("./tile-host.test-util")).resizableMock,
);

const counts = bodyCounts();
const renderBody = (key: string, context: TileBodyContext) => (
  <FakeBody tileKey={key} context={context} counts={counts} />
);
const NO_TABS: ReadonlyMap<string, CellTabs> = new Map();

function mount(node: MosaicNode, tabs = NO_TABS) {
  const host = (next: MosaicNode, nextTabs: ReadonlyMap<string, CellTabs>) => (
    <TileHost
      node={next}
      cellTabs={nextTabs}
      renderBody={renderBody}
      onSizesCommit={() => {}}
      renderProbe={counts.probe}
    />
  );
  const view = render(host(node, tabs));
  return (next: MosaicNode, nextTabs = NO_TABS) => act(() => view.rerender(host(next, nextTabs)));
}

beforeEach(() => counts.reset());

describe("a moved body stays mounted", () => {
  it("a reordered tile keeps its DOM node", () => {
    const tree = row("a", "b", "c");
    const update = mount(tree);
    const body = screen.getByTestId("body-c");
    update(moveLeaf(tree, "c", { targetWorkspaceId: "a", axis: "row", side: "before" }));
    expect(screen.getByTestId("body-c")).toBe(body);
    expect(counts.mounts).toEqual({ a: 1, b: 1, c: 1 });
    expect(counts.unmounts).toEqual({});
  });

  it("a tile grouped into another cell's tabs keeps its DOM node", () => {
    const tree = row("a", "b");
    const update = mount(tree);
    const body = screen.getByTestId("body-b");
    update(pruneLeaf(tree, "b")!, new Map([["a", { keys: ["a", "b"], active: "b" }]]));
    expect(screen.getByTestId("body-b")).toBe(body);
    expect(screen.getByTestId("body-b").dataset.visible).toBe("true");
    expect(screen.getByTestId("body-a").dataset.visible).toBe("false");
    expect(counts.mounts).toEqual({ a: 1, b: 1 });
  });

  it("a tab split out into its own cell keeps its DOM node", () => {
    const grouped = row("a");
    const update = mount(grouped, new Map([["a", { keys: ["a", "b"], active: "b" }]]));
    const body = screen.getByTestId("body-b");
    update(splitAt(grouped, "a", "row", "after", "b"));
    expect(screen.getByTestId("body-b")).toBe(body);
    expect(counts.mounts).toEqual({ b: 1, a: 1 });
    expect(counts.unmounts).toEqual({});
  });
});
