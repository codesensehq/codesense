// SPDX-License-Identifier: MIT
/**
 * The one-item host: a satellite whose slice has no layout (`layoutRef` is `null`) shows
 * its one item full-window, with no tab strip of other items.
 *
 * The host draws no item itself. Each item kind registers its renderer here once, and an
 * item whose kind has none is not mounted. No kind is registered yet.
 */
import type { ReactNode } from "react";

import type { ItemKey } from "./item-key";

export type SatelliteItemRenderer = (item: ItemKey) => ReactNode;

const renderers = new Map<string, SatelliteItemRenderer>();

/** Registers the renderer for `kind`. Each kind registers once. */
export function registerSatelliteItemRenderer(kind: string, render: SatelliteItemRenderer): void {
  if (renderers.has(kind)) throw new Error(`a renderer for ${kind} is already registered`);
  renderers.set(kind, render);
}

export function resetSatelliteItemRenderersForTests(): void {
  renderers.clear();
}

export interface SatelliteItemHostProps {
  /** The slice's layout; the host shows an item only when there is none. */
  layoutRef: string | null;
  item: ItemKey | null;
}

export function SatelliteItemHost({ layoutRef, item }: SatelliteItemHostProps): ReactNode {
  if (layoutRef !== null || !item) return null;
  const render = renderers.get(item.kind);
  if (!render) return null;
  return (
    <div data-satellite-item className="h-full w-full">
      {render(item)}
    </div>
  );
}
