// SPDX-License-Identifier: MIT
/**
 * Shared pieces of the tile host's tests: the resizable wrapper as plain divs (its measuring
 * isn't available in the test DOM), small tree builders, a fake body that counts its renders
 * and mounts, and the leaf-key fixture's tile refs.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useEffect, type ReactNode } from "react";

import type { MosaicNode } from "./mosaic-tree";
import type { TileBodyContext, TileBodyProbe } from "./tile-host";

/** `vi.mock("@/components/ui/resizable", () => resizableMock)`. */
export const resizableMock = {
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div data-testid="group">{children}</div>
  ),
  ResizablePanel: ({ children, id }: { children: ReactNode; id: string }) => (
    <div data-testid={`panel-${id}`}>{children}</div>
  ),
  ResizableHandle: () => <div data-testid="handle" />,
};

export const leaf = (id: string): MosaicNode => ({ kind: "leaf", id });
export const split = (axis: "row" | "column", children: MosaicNode[]): MosaicNode => ({
  kind: "split",
  axis,
  children,
  sizes: children.map(() => 100 / children.length),
});
export const row = (...ids: string[]) => split("row", ids.map(leaf));

/** Body render and mount counts, by key. */
export interface BodyCounts {
  renders: Record<string, number>;
  mounts: Record<string, number>;
  unmounts: Record<string, number>;
}

export function bodyCounts(): BodyCounts & { reset(): void; probe: TileBodyProbe } {
  const counts = { renders: {}, mounts: {}, unmounts: {} } as BodyCounts;
  const clear = (of: Record<string, number>) => Object.keys(of).forEach((key) => delete of[key]);
  return Object.assign(counts, {
    reset() {
      clear(counts.renders);
      clear(counts.mounts);
      clear(counts.unmounts);
    },
    probe: ((key, phase) => {
      if (phase === "render") counts.renders[key] = (counts.renders[key] ?? 0) + 1;
    }) as TileBodyProbe,
  });
}

const bump = (of: Record<string, number>, key: string) => void (of[key] = (of[key] ?? 0) + 1);

/** A body that counts its own mounts and unmounts, with an instance id that a remount changes. */
export function FakeBody({
  tileKey,
  context,
  counts,
}: {
  tileKey: string;
  context: TileBodyContext;
  counts?: BodyCounts;
}) {
  useEffect(() => {
    if (counts) bump(counts.mounts, tileKey);
    return () => {
      if (counts) bump(counts.unmounts, tileKey);
    };
  }, [tileKey, counts]);
  return (
    <div data-testid={`body-${tileKey}`} data-visible={context.visible ? "true" : "false"}>
      {tileKey}
    </div>
  );
}

interface LeafKeyRow {
  leaf: string;
  layer: string;
  valid: boolean;
}

/** The valid shared-layer tile refs of `tests/fixtures/leaf-keys.json` with `prefix`. */
export function fixtureRefs(prefix: "agent:" | "doc:"): string[] {
  const path = resolve(__dirname, "../../../tests/fixtures/leaf-keys.json");
  const { refs } = JSON.parse(readFileSync(path, "utf8")) as { refs: LeafKeyRow[] };
  return refs
    .filter((r) => r.valid && r.layer === "shared" && r.leaf.startsWith(prefix))
    .map((r) => r.leaf);
}
