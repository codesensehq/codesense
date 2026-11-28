// SPDX-License-Identifier: MIT
/**
 * The host's rects: one observer per host over the root and every cell, a re-measure on each
 * new tree, rects relative to the root, and listeners told only of a change. A body's wrapper
 * is placed by style, so a resize renders no body.
 */
import { act, render } from "@testing-library/react";
import { createRef, useContext, useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { swapLeaves, type MosaicNode } from "./mosaic-tree";
import {
  TileHost,
  TileKeyContext,
  useTileHost,
  type TileBodyContext,
  type TileHostHandle,
  type TileRect,
} from "./tile-host";
import { bodyCounts, FakeBody, row } from "./tile-host.test-util";

vi.mock(
  "@/components/ui/resizable",
  async () => (await import("./tile-host.test-util")).resizableMock,
);

/** Every observer made, with what it watches. */
class FakeObserver {
  static made: FakeObserver[] = [];
  observed = new Set<Element>();
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeObserver.made.push(this);
  }
  observe(element: Element) {
    this.observed.add(element);
  }
  unobserve(element: Element) {
    this.observed.delete(element);
  }
  disconnect() {
    this.disconnected = true;
    this.observed.clear();
  }
  fire() {
    act(() => this.callback([], this as unknown as ResizeObserver));
  }
}

/** Boxes by cell id; the host root sits at (100, 50). */
const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
const ROOT = { x: 100, y: 50, width: 800, height: 600 };
function boxOf(element: Element) {
  const el = element as HTMLElement;
  const b =
    el.dataset.tileHost !== undefined
      ? ROOT
      : (boxes.get(el.dataset.tileCell ?? "") ?? { x: 0, y: 0, width: 0, height: 0 });
  return { left: b.x, top: b.y, width: b.width, height: b.height } as DOMRect;
}

const counts = bodyCounts();
const renderBody = (key: string, context: TileBodyContext) => (
  <FakeBody tileKey={key} context={context} counts={counts} />
);

function mount(
  node: MosaicNode,
  extra: { wrapBody?: (p: { tileKey: string; children: ReactNode }) => ReactNode } = {},
) {
  const handle = createRef<TileHostHandle>();
  const host = (next: MosaicNode) => (
    <TileHost
      node={next}
      renderBody={renderBody}
      onSizesCommit={() => {}}
      handleRef={handle}
      renderProbe={counts.probe}
      wrapBody={extra.wrapBody}
    />
  );
  const view = render(host(node));
  return {
    view,
    handle: handle.current!,
    update: (next: MosaicNode) => act(() => view.rerender(host(next))),
  };
}

const wrapper = (key: string) => document.querySelector<HTMLElement>(`[data-tile-body="${key}"]`)!;

beforeEach(() => {
  FakeObserver.made = [];
  vi.stubGlobal("ResizeObserver", FakeObserver);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return boxOf(this);
  });
  boxes.clear();
  boxes.set("a", { x: 100, y: 50, width: 400, height: 600 });
  boxes.set("b", { x: 500, y: 50, width: 400, height: 600 });
  counts.reset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the host's rects", () => {
  it("are relative to the root, and get and subscribe agree", () => {
    const { handle } = mount(row("a", "b"));
    expect(handle.getTileRect("a")).toEqual({ x: 0, y: 0, width: 400, height: 600, folded: false });
    expect(handle.getTileRect("b")).toEqual({
      x: 400,
      y: 0,
      width: 400,
      height: 600,
      folded: false,
    });
    expect(handle.getTileRect("none")).toBeNull();
    const seen: TileRect[] = [];
    const stop = handle.subscribeTileRect("a", (rect) => seen.push(rect));
    boxes.set("a", { x: 100, y: 50, width: 300, height: 600 });
    FakeObserver.made[0].fire();
    expect(seen).toEqual([{ x: 0, y: 0, width: 300, height: 600, folded: false }]);
    stop();
    boxes.set("a", { x: 100, y: 50, width: 200, height: 600 });
    FakeObserver.made[0].fire();
    expect(seen).toHaveLength(1);
  });

  it("one observer per host watches the root and every cell, and disconnects on unmount", () => {
    const { view } = mount(row("a", "b"));
    expect(FakeObserver.made).toHaveLength(1);
    const [observer] = FakeObserver.made;
    const watched = [...observer.observed].map(
      (el) => (el as HTMLElement).dataset.tileCell ?? "root",
    );
    expect(watched.sort()).toEqual(["a", "b", "root"]);
    view.unmount();
    expect(observer.disconnected).toBe(true);
  });

  it("an unchanged rect tells no listener", () => {
    const { handle } = mount(row("a", "b"));
    const changed = vi.fn();
    handle.subscribeTileRect("a", changed);
    FakeObserver.made[0].fire();
    expect(changed).not.toHaveBeenCalled();
  });

  it("a swap re-measures with no resize, and moves the wrappers by style", () => {
    const tree = row("a", "b");
    const { update } = mount(tree);
    expect(wrapper("a").style.left).toBe("0px");
    const nodeA = wrapper("a");
    // After the swap a's cell sits on the right.
    boxes.set("a", { x: 500, y: 50, width: 400, height: 600 });
    boxes.set("b", { x: 100, y: 50, width: 400, height: 600 });
    update(swapLeaves(tree, "a", "b"));
    expect(wrapper("a")).toBe(nodeA);
    expect(wrapper("a").style.left).toBe("400px");
    expect(wrapper("b").style.left).toBe("0px");
  });

  it("a folded cell keeps its body's last size", () => {
    const { handle } = mount(row("a", "b"));
    boxes.set("b", { x: 900, y: 50, width: 0, height: 600 });
    FakeObserver.made[0].fire();
    expect(handle.getTileRect("b")).toEqual({
      x: 400,
      y: 0,
      width: 400,
      height: 600,
      folded: true,
    });
    expect(wrapper("b").style.width).toBe("400px");
  });

  it("a resize renders no body", () => {
    mount(row("a", "b"));
    counts.reset();
    boxes.set("a", { x: 100, y: 50, width: 250, height: 600 });
    boxes.set("b", { x: 350, y: 50, width: 550, height: 600 });
    FakeObserver.made[0].fire();
    expect(wrapper("b").style.width).toBe("550px");
    expect(counts.renders).toEqual({});
  });
});

describe("what a body reads", () => {
  it("TileKeyContext names its own tile, and useTileHost is the same value across renders", () => {
    const seen: Array<{ key: string | null; host: TileHostHandle }> = [];
    function Reader() {
      const key = useContext(TileKeyContext);
      const host = useTileHost();
      seen.push({ key, host });
      return null;
    }
    const handle = createRef<TileHostHandle>();
    const host = (node: MosaicNode) => (
      <TileHost
        node={node}
        renderBody={() => <Reader />}
        onSizesCommit={() => {}}
        handleRef={handle}
      />
    );
    const view = render(host(row("a", "b")));
    act(() => view.rerender(host(row("a", "b", "c"))));
    expect(new Set(seen.map((s) => s.key))).toEqual(new Set(["a", "b", "c"]));
    expect(new Set(seen.map((s) => s.host)).size).toBe(1);
    expect(seen[0].host).toBe(handle.current);
  });

  it("useTileHost outside a body throws", () => {
    function Outside() {
      useTileHost();
      return null;
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Outside />)).toThrow(/inside a tile body/);
  });

  it("wrapBody mounts once per body, across a resize and a new tree", () => {
    const wrapMounts: Record<string, number> = {};
    function Wrap({ tileKey, children }: { tileKey: string; children: ReactNode }) {
      useEffect(() => {
        wrapMounts[tileKey] = (wrapMounts[tileKey] ?? 0) + 1;
      }, [tileKey]);
      return <div data-wrap={tileKey}>{children}</div>;
    }
    const tree = row("a", "b");
    const { update } = mount(tree, { wrapBody: Wrap });
    FakeObserver.made[0].fire();
    update(swapLeaves(tree, "a", "b"));
    expect(wrapMounts).toEqual({ a: 1, b: 1 });
    expect(wrapper("a").querySelector('[data-wrap="a"] [data-testid="body-a"]')).toBeTruthy();
  });
});
