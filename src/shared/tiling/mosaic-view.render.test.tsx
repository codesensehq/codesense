// SPDX-License-Identifier: MIT
import { act, render, screen } from "@testing-library/react";
import { Profiler, useEffect, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MosaicView, type MosaicRenderProbe } from "./mosaic-view";
import { appendLeaf, pruneLeaf, setNodeSizes, splitAt, type MosaicNode } from "./mosaic-tree";

// The resizable wrapper as plain divs: the library's measuring isn't available here and isn't
// what this test counts. Each group keeps its layout callbacks so a test can commit a resize.
const groups = vi.hoisted(() => ({
  byPanels: new Map<
    string,
    { pointerDown: () => void; changed: (l: Record<string, number>) => void }
  >(),
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    onLayoutChanged,
    onPointerDownCapture,
    defaultLayout,
  }: any) => {
    groups.byPanels.set(Object.keys(defaultLayout).join(","), {
      pointerDown: () => onPointerDownCapture?.({}),
      changed: onLayoutChanged,
    });
    return <div data-testid="group">{children}</div>;
  },
  ResizablePanel: ({ children, id, minSize: _minSize, className: _className, ...rest }: any) => (
    <div data-testid={`panel-${id}`} {...rest}>
      {children}
    </div>
  ),
  ResizableHandle: () => <div data-testid="handle" />,
}));

const leaf = (id: string): MosaicNode => ({ kind: "leaf", id });
const split = (axis: "row" | "column", children: MosaicNode[]): MosaicNode => ({
  kind: "split",
  axis,
  children,
  sizes: children.map(() => 100 / children.length),
});

/** Eight leaves, each row ending in a nested split (right of where a leaf goes in):
 *  column[ row[a, b, column[c, d]], row[e, f, column[g, h]] ] */
const build = () =>
  split("column", [
    split("row", [leaf("a"), leaf("b"), split("column", [leaf("c"), leaf("d")])]),
    split("row", [leaf("e"), leaf("f"), split("column", [leaf("g"), leaf("h")])]),
  ]);
const LEAVES = ["a", "b", "c", "d", "e", "f", "g", "h"];

let leafRenders: Record<string, number>;
let leafMounts: Record<string, number>;
let splitRenders: Record<string, number>;
let splitMounts: Record<string, number>;

function Cell({ id }: { id: string }) {
  useEffect(() => {
    leafMounts[id] = (leafMounts[id] ?? 0) + 1;
  }, [id]);
  return <div data-testid={`cell-${id}`}>{id}</div>;
}

const onLeafRender = (id: string) => {
  leafRenders[id] = (leafRenders[id] ?? 0) + 1;
};

// One stable renderLeaf for the whole file: the contract holds for a stable reference.
const renderLeaf = (id: string): ReactNode => (
  <Profiler id={id} onRender={onLeafRender}>
    <Cell id={id} />
  </Profiler>
);

const probe: MosaicRenderProbe = (key, phase) => {
  const counts = phase === "mount" ? splitMounts : splitRenders;
  counts[key] = (counts[key] ?? 0) + 1;
};

const onSizesCommit = vi.fn();

function View({ node, zoomPath }: { node: MosaicNode | null; zoomPath?: number[] | null }) {
  return (
    <MosaicView
      node={node}
      renderLeaf={renderLeaf}
      onSizesCommit={onSizesCommit}
      zoomPath={zoomPath}
      renderProbe={probe}
    />
  );
}

function mount(node: MosaicNode) {
  const view = render(<View node={node} />);
  leafRenders = {};
  leafMounts = {};
  splitRenders = {};
  splitMounts = {};
  return {
    update: (next: MosaicNode | null, zoomPath?: number[] | null) =>
      act(() => view.rerender(<View node={next} zoomPath={zoomPath} />)),
  };
}

/** The split keys a render touched, by kind. */
const touched = (counts: Record<string, number>) => Object.keys(counts).sort();

beforeEach(() => {
  groups.byPanels.clear();
  onSizesCommit.mockReset();
});

describe("MosaicView re-renders only the changed path", () => {
  it("(a) a leaf from another team added by splitAt renders and mounts only itself", () => {
    const tree = build();
    const { update } = mount(tree);
    update(splitAt(tree, "a", "row", "after", "agent:other-team/x"));
    expect(screen.getByTestId("cell-agent:other-team/x")).toBeTruthy();
    expect(leafRenders).toEqual({ "agent:other-team/x": 1 });
    expect(leafMounts).toEqual({ "agent:other-team/x": 1 });
    // The root and the row the leaf went into; neither nested split nor the other row.
    expect(touched(splitRenders)).toHaveLength(2);
    expect(splitMounts).toEqual({});
  });

  it("(a) a doc leaf added by appendLeaf renders and mounts only itself", () => {
    const tree = build();
    const { update } = mount(tree);
    update(appendLeaf(tree, "doc:other-team/plan.md"));
    expect(leafRenders).toEqual({ "doc:other-team/plan.md": 1 });
    expect(leafMounts).toEqual({ "doc:other-team/plan.md": 1 });
    expect(touched(splitRenders)).toHaveLength(1);
    expect(splitMounts).toEqual({});
  });

  it("(b) committing one split's sizes renders that split and its ancestors, no leaf", () => {
    const tree = build();
    const { update } = mount(tree);
    update(setNodeSizes(tree, [0, 2], [30, 70]));
    expect(leafRenders).toEqual({});
    expect(leafMounts).toEqual({});
    expect(touched(splitRenders)).toHaveLength(3);
    expect(splitMounts).toEqual({});
  });

  it("(c) pruning one leaf renders its row and the root, no other leaf", () => {
    const tree = build();
    const { update } = mount(tree);
    update(pruneLeaf(tree, "e"));
    expect(screen.queryByTestId("cell-e")).toBeNull();
    expect(leafRenders).toEqual({});
    expect(leafMounts).toEqual({});
    expect(touched(splitRenders)).toHaveLength(2);
    expect(splitMounts).toEqual({});
  });

  it("(d) the same tree again renders nothing", () => {
    const tree = build();
    const { update } = mount(tree);
    update(tree);
    expect(leafRenders).toEqual({});
    expect(splitRenders).toEqual({});
  });

  it("(d) a freshly built, structurally equal tree renders nothing", () => {
    const { update } = mount(build());
    update(build());
    update(build());
    expect(leafRenders).toEqual({});
    expect(leafMounts).toEqual({});
    expect(splitRenders).toEqual({});
    expect(splitMounts).toEqual({});
  });

  it("accepted: a cross-axis split reparents only its target leaf", () => {
    const tree = build();
    const { update } = mount(tree);
    update(splitAt(tree, "b", "column", "after", "x"));
    expect(Object.keys(leafMounts).sort()).toEqual(["b", "x"]);
    for (const id of LEAVES.filter((l) => l !== "b")) expect(leafRenders[id]).toBeUndefined();
  });
});

describe("MosaicView without index paths", () => {
  it("commits a resize at the split's path after a leaf goes in before it", () => {
    const tree = build();
    const { update } = mount(tree);
    update(splitAt(tree, "a", "row", "after", "x"));
    const group = groups.byPanels.get("c,d")!;
    act(() => {
      group.pointerDown();
      group.changed({ c: 30, d: 70 });
    });
    expect(onSizesCommit).toHaveBeenCalledWith([0, 3], [30, 70]);
  });

  it("zooms a leaf through split keys, and keeps it zoomed after a reorder", () => {
    const tree = build();
    const { update } = mount(tree);
    update(tree, [0, 2, 1]);
    const zoom = (id: string) => screen.getByTestId(`panel-${id}`).getAttribute("data-zoom");
    expect(zoom("d")).toBe("active");
    expect(zoom("c")).toBe("collapsed");
    expect(zoom("a")).toBe("collapsed");
    expect(
      document.querySelectorAll('[data-testid^="panel-split:"][data-zoom="active"]'),
    ).toHaveLength(2);
    const grown = splitAt(tree, "a", "row", "after", "x");
    update(grown, [0, 3, 1]);
    expect(zoom("d")).toBe("active");
    expect(zoom("x")).toBe("collapsed");
  });
});
