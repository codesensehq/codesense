// SPDX-License-Identifier: MIT
/**
 * What a satellite window renders in place of `App` (`main.tsx` picks it when
 * `isMainWindow()` is false, inside the same providers). It renders the boot rows
 * a satellite runs (`SATELLITE_ROWS`) and one content renderer, and nothing else:
 * no splash, no boot-gate watchdog, and no `show()` (Rust shows the window once it
 * is placed).
 *
 * Its content comes only from its registry slice, never from the app state. It
 * takes two dependencies: the slice source and the content renderer. The renderer
 * gets the slice's item when `layoutRef` is null, and the `layoutRef` otherwise.
 *
 * Nothing here imports `App.tsx` or a `skip` row (`boot-inventory.test.ts`).
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { renderViewer } from "@/shared/lib/render-viewer";

import { BOOT_EXPORTS, BootRows, SATELLITE_ROWS } from "./boot-inventory";
import {
  EMPTY_SLICE_SOURCE,
  installSliceSource,
  TAB_ITEM_KIND,
  type SliceItem,
  type SliceSource,
} from "./slice";

// The module rows (the virtual-tab registrations) run before the first render, so a
// `virtual://` item a slice hands over synchronously resolves at once.
for (const row of SATELLITE_ROWS) {
  if (row.kind === "module") BOOT_EXPORTS[row.id]?.();
}

/** What the renderer is handed: the one item, or the layout the slice names. */
export type SatelliteContent = { item: SliceItem } | { layoutRef: string };

type SatelliteRenderer = (content: SatelliteContent) => ReactNode;

/** The provisional renderer: a tab item's existing tab body with no chrome. A layout
 *  draws nothing yet; the story that shows the window replaces this renderer. */
const defaultSatelliteRenderer: SatelliteRenderer = (content) => {
  if (!("item" in content) || content.item.kind !== TAB_ITEM_KIND) return null;
  const { item } = content;
  return renderViewer({ hostTeamKey: item.team, filePath: item.id, teamContentPath: "" }, {});
};

export interface SatelliteRootProps {
  /** Where the slice comes from: the window registry in the app, a stub in tests. */
  source?: SliceSource;
  renderer?: SatelliteRenderer;
}

export function SatelliteRoot({
  source = EMPTY_SLICE_SOURCE,
  renderer = defaultSatelliteRenderer,
}: SatelliteRootProps): ReactNode {
  // Installed before the rows first render, so they read this window's slice.
  useState(() => installSliceSource(source));
  useEffect(() => installSliceSource(source), [source]);
  const slice = useSyncExternalStore(source.subscribe, source.current);
  let content: SatelliteContent | null = null;
  if (slice?.layoutRef != null) content = { layoutRef: slice.layoutRef };
  else if (slice?.items[0]) content = { item: slice.items[0] };
  return (
    <div data-satellite-root className="h-screen w-screen overflow-hidden">
      <BootRows rows={SATELLITE_ROWS} />
      {content && renderer(content)}
    </div>
  );
}
