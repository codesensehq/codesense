// SPDX-License-Identifier: MIT
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { appendLeaf, splitAt, type MosaicNode } from "./mosaic-tree";
import { TileHost, type TileBodyContext } from "./tile-host";
import { bodyCounts, FakeBody, row } from "./tile-host.test-util";
import { fixtureRefs } from "./tile-host.test-util";

vi.mock(
  "@/components/ui/resizable",
  async () => (await import("./tile-host.test-util")).resizableMock,
);

// Another team's agent and doc, read from the leaf-key fixture rather than typed here.
const AGENT = fixtureRefs("agent:").find((key) => !key.startsWith("agent:core/"))!;
const DOC = fixtureRefs("doc:")[0];

const counts = bodyCounts();
const renderBody = (key: string, context: TileBodyContext) => (
  <FakeBody tileKey={key} context={context} counts={counts} />
);
const onSizesCommit = vi.fn();

function Host({ node, cap }: { node: MosaicNode | null; cap?: number }) {
  return (
    <TileHost
      node={node}
      renderBody={renderBody}
      onSizesCommit={onSizesCommit}
      keepAliveCap={cap}
      renderProbe={counts.probe}
    />
  );
}

function mount(node: MosaicNode, cap?: number) {
  const view = render(<Host node={node} cap={cap} />);
  counts.reset();
  return (next: MosaicNode | null, nextCap = cap) =>
    act(() => view.rerender(<Host node={next} cap={nextCap} />));
}

beforeEach(() => counts.reset());

describe("the tile host renders only what changed", () => {
  it("reads another team's agent and doc keys from the fixture", () => {
    expect(AGENT).toMatch(/^agent:[^/]+\/.+/);
    expect(DOC).toMatch(/^doc:[^/]+\/.+/);
  });

  it("opening another team's agent beside two tiles mounts one body and renders no other", () => {
    const tree = row("a", "b");
    const update = mount(tree);
    update(splitAt(tree, "a", "row", "after", AGENT));
    expect(screen.getByTestId(`body-${AGENT}`)).toBeTruthy();
    expect(counts.mounts).toEqual({ [AGENT]: 1 });
    expect(counts.renders).toEqual({ [AGENT]: 1 });
  });

  it("tiling another team's doc mounts one body and renders no other", () => {
    const tree = row("a", AGENT);
    const update = mount(tree);
    update(appendLeaf(tree, DOC));
    expect(counts.mounts).toEqual({ [DOC]: 1 });
    expect(counts.renders).toEqual({ [DOC]: 1 });
  });

  it("a team chip change (a new tree of the same keys) renders no body", () => {
    const update = mount(row("a", AGENT, DOC));
    update(row("a", AGENT, DOC));
    expect(counts.renders).toEqual({});
    expect(counts.mounts).toEqual({});
  });

  it("an eviction unmounts only hidden bodies and renders no visible one", () => {
    // Show three, then hide two of them by closing: with a cap of 1 the older one goes.
    const update = mount(row("a", "b", "c"), 1);
    update(row("a", "b"));
    update(row("a"));
    expect(counts.unmounts).toEqual({ c: 1 });
    expect(counts.renders.a).toBeUndefined();
    expect(screen.queryByTestId("body-c")).toBeNull();
    expect(screen.getByTestId("body-b")).toBeTruthy();
  });
});
