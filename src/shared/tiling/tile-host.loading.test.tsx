// SPDX-License-Identifier: MIT
/**
 * A loading tile shows its last frame greyed where its previous body is still mounted, else its
 * own kind's skeleton, else the host's plain one; the word Loading only after 400 ms; and the
 * body takes the skeleton's place with no change of size.
 */
import { act, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TILE_LOADING_WORD_MS, TileHost, type TileBodyContext } from "./tile-host";
import { bodyCounts, row } from "./tile-host.test-util";

vi.mock(
  "@/components/ui/resizable",
  async () => (await import("./tile-host.test-util")).resizableMock,
);

/** Each body's loading switch, set by the test. */
const loaders = new Map<string, (loading: boolean) => void>();
const counts = bodyCounts();

function LoadingBody({ tileKey, context }: { tileKey: string; context: TileBodyContext }) {
  // Before the first paint, as a real body does when its document starts loading.
  useLayoutEffect(() => {
    loaders.set(tileKey, context.reportLoading);
    context.reportLoading(true);
  }, [tileKey, context]);
  return <div data-testid={`body-${tileKey}`}>{tileKey}</div>;
}
const renderBody = (key: string, context: TileBodyContext) => (
  <LoadingBody tileKey={key} context={context} />
);
const renderSkeleton = (key: string) =>
  key.startsWith("doc:") ? <div data-tile-skeleton="doc">doc skeleton</div> : null;

function mount(keys: string[]) {
  return render(
    <TileHost
      node={row(...keys)}
      renderBody={renderBody}
      renderSkeleton={renderSkeleton}
      onSizesCommit={() => {}}
      renderProbe={counts.probe}
    />,
  );
}

const wrapper = (key: string) => document.querySelector<HTMLElement>(`[data-tile-body="${key}"]`)!;
const form = (key: string) => wrapper(key).querySelector("[data-tile-loading]");

beforeEach(() => {
  vi.useFakeTimers();
  loaders.clear();
  counts.reset();
});
afterEach(() => vi.useRealTimers());

describe("the loading form", () => {
  it("shows the kind's skeleton for a body never ready, else the plain one", () => {
    mount(["doc:core/a.md", "ws-1"]);
    expect(form("doc:core/a.md")?.getAttribute("data-tile-loading")).toBe("skeleton");
    expect(form("doc:core/a.md")?.querySelector('[data-tile-skeleton="doc"]')).toBeTruthy();
    expect(form("ws-1")?.querySelector('[data-tile-skeleton="plain"]')).toBeTruthy();
  });

  it('says "Loading" at 400 ms and not at 399', () => {
    mount(["ws-1"]);
    act(() => vi.advanceTimersByTime(TILE_LOADING_WORD_MS - 1));
    expect(screen.queryByText("Loading")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText("Loading")).toBeTruthy();
  });

  it("shows the last frame greyed when a ready body loads again in place", () => {
    mount(["ws-1"]);
    act(() => loaders.get("ws-1")!(false));
    expect(form("ws-1")).toBeNull();
    act(() => loaders.get("ws-1")!(true));
    const content = wrapper("ws-1").querySelector<HTMLElement>("[data-tile-content]")!;
    expect(content.dataset.tileLoading).toBe("last-frame");
    expect(content.style.filter).toContain("grayscale");
    // The body is still the one on screen, under no skeleton.
    expect(screen.getByTestId("body-ws-1")).toBeTruthy();
    expect(wrapper("ws-1").querySelector('[data-tile-loading="skeleton"]')).toBeNull();
    act(() => vi.advanceTimersByTime(TILE_LOADING_WORD_MS));
    expect(screen.getByText("Loading")).toBeTruthy();
  });

  it("the body takes the skeleton's place with no change of the wrapper's size", () => {
    mount(["ws-1"]);
    const before = wrapper("ws-1").getAttribute("style");
    act(() => loaders.get("ws-1")!(false));
    expect(form("ws-1")).toBeNull();
    expect(screen.queryByText("Loading")).toBeNull();
    // Skeleton and body fill the same wrapper: its box is untouched by the swap.
    expect(wrapper("ws-1").getAttribute("style")).toBe(before);
  });

  it("renders no other tile while one loads", () => {
    mount(["ws-1", "ws-2"]);
    act(() => loaders.get("ws-1")!(false));
    act(() => loaders.get("ws-2")!(false));
    counts.reset();
    act(() => loaders.get("ws-1")!(true));
    act(() => vi.advanceTimersByTime(TILE_LOADING_WORD_MS));
    expect(counts.renders["ws-2"]).toBeUndefined();
  });
});
