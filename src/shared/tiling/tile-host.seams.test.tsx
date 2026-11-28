// SPDX-License-Identifier: MIT
/**
 * The host's side of the window seam: an owner gate decides whether this window mounts a body,
 * and the host answers `isBodyVisible` and `framesOf` for the window code that moves a body
 * between windows.
 */
import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MosaicNode } from "./mosaic-tree";
import {
  TileHost,
  type CellTabs,
  type TileBodyContext,
  type TileHostHandle,
  type TileOwnerGate,
  type WindowShownSource,
} from "./tile-host";
import { bodyCounts, FakeBody, leaf, row, split } from "./tile-host.test-util";

vi.mock(
  "@/components/ui/resizable",
  async () => (await import("./tile-host.test-util")).resizableMock,
);

const counts = bodyCounts();
const renderBody = (key: string, context: TileBodyContext) => (
  <>
    <FakeBody tileKey={key} context={context} counts={counts} />
    <iframe title={key} data-frame-of={key} />
  </>
);
const renderSurface = (key: string) => <span data-testid={`surface-${key}`}>elsewhere</span>;

/** A gate over a set of keys another window owns, with a change it can announce. */
function fakeGate(elsewhere: string[] = []) {
  const others = new Set(elsewhere);
  const listeners = new Set<(keys: readonly string[]) => void>();
  const gate: TileOwnerGate & { move(key: string, here: boolean): void; listeners: number } = {
    owns: (key) => !others.has(key),
    subscribe: (changed) => {
      listeners.add(changed);
      return () => listeners.delete(changed);
    },
    move(key, here) {
      if (here) others.delete(key);
      else others.add(key);
      act(() => listeners.forEach((changed) => changed([key])));
    },
    get listeners() {
      return listeners.size;
    },
  };
  return gate;
}

function fakeShown(initial = true): WindowShownSource & { set(shown: boolean): void } {
  let shown = initial;
  return { get: () => shown, subscribe: () => () => {}, set: (next) => void (shown = next) };
}

interface Props {
  node: MosaicNode;
  gate?: TileOwnerGate;
  shown?: WindowShownSource;
  pins?: ReadonlySet<string>;
  tabs?: ReadonlyMap<string, CellTabs>;
}

function mount({ node, gate, shown, pins, tabs }: Props) {
  const handle = createRef<TileHostHandle>();
  const view = render(
    <TileHost
      node={node}
      renderBody={renderBody}
      renderSurface={renderSurface}
      onSizesCommit={() => {}}
      ownerGate={gate}
      windowShown={shown}
      pins={pins}
      cellTabs={tabs}
      handleRef={handle}
      renderProbe={counts.probe}
    />,
  );
  return { view, host: handle.current! };
}

beforeEach(() => counts.reset());

describe("the owner gate", () => {
  it("with no gate wired every tile is owned and mounts once", () => {
    mount({ node: row("a", "b") });
    expect(counts.mounts).toEqual({ a: 1, b: 1 });
  });

  it("a tile another window owns mounts no body and draws its skeleton and surface", () => {
    mount({ node: row("a", "b"), gate: fakeGate(["b"]) });
    expect(counts.mounts).toEqual({ a: 1 });
    expect(screen.queryByTestId("body-b")).toBeNull();
    expect(document.querySelector('iframe[data-frame-of="b"]')).toBeNull();
    const held = document.querySelector('[data-tile-body="b"] [data-tile-held]');
    expect(held?.querySelector("[data-tile-skeleton]")).toBeTruthy();
    expect(screen.getByTestId("surface-b")).toBeTruthy();
  });

  it("a gate change for one key swaps that tile's body for its skeleton, rendering no other", () => {
    const gate = fakeGate();
    mount({ node: row("a", "b", "c"), gate });
    counts.reset();
    gate.move("b", false);
    expect(screen.queryByTestId("body-b")).toBeNull();
    expect(counts.unmounts).toEqual({ b: 1 });
    expect(counts.renders).toEqual({ b: 1 });
    gate.move("b", true);
    expect(screen.getByTestId("body-b")).toBeTruthy();
    expect(counts.renders).toEqual({ b: 2 });
  });

  it("unsubscribes from the gate on unmount", () => {
    const gate = fakeGate();
    const { view } = mount({ node: row("a"), gate });
    expect(gate.listeners).toBe(1);
    view.unmount();
    expect(gate.listeners).toBe(0);
  });

  it("a pin's body mounts whatever the gate says", () => {
    mount({ node: row("a", "p"), gate: fakeGate(["p"]), pins: new Set(["p"]) });
    expect(counts.mounts).toEqual({ a: 1, p: 1 });
  });
});

describe("isBodyVisible", () => {
  const tabs = new Map<string, CellTabs>([["a", { keys: ["a", "a2"], active: "a" }]]);

  it("is true for a cell's active tab in the shown tree", () => {
    const { host } = mount({ node: row("a", "b"), tabs });
    expect(host.isBodyVisible("a")).toBe(true);
    expect(host.isBodyVisible("b")).toBe(true);
  });

  it("is false for a background tab, a tile outside the tree and a pin", () => {
    const { host } = mount({ node: row("a", "p"), tabs, pins: new Set(["p"]) });
    expect(host.isBodyVisible("a2")).toBe(false);
    expect(host.isBodyVisible("elsewhere")).toBe(false);
    expect(host.isBodyVisible("p")).toBe(false);
  });

  it("is false while the app hides the window, and true for a minimized (shown) one", () => {
    const shown = fakeShown(true);
    const { host } = mount({ node: row("a"), shown });
    expect(host.isBodyVisible("a")).toBe(true);
    shown.set(false);
    expect(host.isBodyVisible("a")).toBe(false);
  });

  it("is true behind an Expand: the cell is still the active tab in the shown tree", () => {
    const node = split("row", [leaf("a"), leaf("b")]);
    const handle = createRef<TileHostHandle>();
    render(
      <TileHost
        node={node}
        renderBody={renderBody}
        onSizesCommit={() => {}}
        zoomPath={[0]}
        handleRef={handle}
      />,
    );
    expect(handle.current!.isBodyVisible("b")).toBe(true);
    expect(document.querySelector('[data-tile-body="b"]')).toBeNull();
  });
});

describe("framesOf", () => {
  it("lists the frames of that body only", () => {
    const { host } = mount({ node: row("a", "b") });
    const frames = host.framesOf("a");
    expect(frames).toHaveLength(1);
    expect(frames[0].dataset.frameOf).toBe("a");
  });

  it("lists none for a body never mounted", () => {
    const { host } = mount({ node: row("a", "b"), gate: fakeGate(["b"]) });
    expect(host.framesOf("b")).toEqual([]);
    expect(host.framesOf("never")).toEqual([]);
  });
});
