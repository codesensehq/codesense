// SPDX-License-Identifier: MIT
/**
 * What a satellite window renders in place of `App` (`main.tsx` picks it when
 * `isMainWindow()` is false, inside the same providers). It renders the boot rows
 * a satellite runs (`SATELLITE_ROWS`) and one content renderer, and nothing else:
 * no splash, no boot-gate watchdog, and no `show()` (Rust shows the window once it
 * is placed).
 *
 * Its content comes only from its registry slice, never from the app state, and it
 * refreshes its item when Rust routes it a change to that item's file. It
 * takes its dependencies as props: the slice source, the content renderer and the
 * items it has let go of in a move. The renderer gets the slice's item when
 * `layoutRef` is null, the `layoutRef` otherwise, and a move state while a move to or
 * from this window is in flight or once its item has moved out.
 *
 * Nothing here imports `App.tsx` or a `skip` row (`boot-inventory.test.ts`).
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { useRetiringFrames } from "@/features/dashboard/components/use-retiring-frames";
import type { LiveFrame } from "@/features/dashboard/lib/frame-lifecycle";
import { frameOf } from "@/features/dashboard/lib/frame-of";
import { closeCurrentWindow } from "@/shared/lib/current-window";
import { logger } from "@/shared/lib/logger";
import { renderViewer } from "@/shared/lib/render-viewer";
import { useFileRefreshStore } from "@/shared/stores/file-refresh-store";

import { BOOT_EXPORTS, BootRows, SATELLITE_ROWS } from "./boot-inventory";
import type { ReleasedItems } from "./hand-off";
import { canonicalItemKey, itemName, TAB_ITEM_KIND, type ItemKey } from "./item-key";
import { refreshKeyForItem, useSatellitePathRefresh } from "./path-listeners";
import { EMPTY_SLICE_SOURCE, installSliceSource, type SliceSource, type SliceView } from "./slice";

// The module rows (the virtual-tab registrations) run before the first render, so a
// `virtual://` item a slice hands over synchronously resolves at once.
for (const row of SATELLITE_ROWS) {
  if (row.kind === "module") BOOT_EXPORTS[row.id]?.();
}

/** What the renderer is handed: the one item, the layout the slice names, or a move state.
 *  `pending`: the window is a move's target and the item is not here yet (no frame mounts
 *  until the move commits). `handed-off`: this window let its item go and the move has not
 *  committed yet. `empty`: the window holds nothing (its item moved out). */
export type SatelliteContent =
  | { item: ItemKey }
  | { layoutRef: string }
  | { state: "pending"; caption: { name: string; sourceWindowN: number } }
  | { state: "handed-off" }
  | { state: "empty"; windowNumber: number };

type SatelliteRenderer = (content: SatelliteContent) => ReactNode;

/** What the default renderer's empty placeholder offers. Without `focusMain` it draws
 *  Close window alone. */
export interface SatelliteActions {
  closeWindow: () => void;
  focusMain?: () => void;
}

/** The content a slice hands the renderer, given the items this window has let go. */
export function satelliteContent(
  slice: SliceView | null,
  released: ReleasedItems | undefined,
): SatelliteContent | null {
  if (!slice) return null;
  if (slice.pending) {
    if (!slice.incoming) return null;
    const { key, fromNumber } = slice.incoming;
    return { state: "pending", caption: { name: itemName(key), sourceWindowN: fromNumber } };
  }
  if (slice.layoutRef != null) return { layoutRef: slice.layoutRef };
  const item = slice.items[0];
  if (!item) return { state: "empty", windowNumber: slice.number ?? 0 };
  if (released?.has(item)) return { state: "handed-off" };
  return { item };
}

/** A tab item's tab body, reloading on the key `refreshKeyForItem` derives from the item,
 *  which the satellite's file-change listener bumps. */
function SatelliteViewer({ item }: { item: ItemKey }): ReactNode {
  const refreshPath = refreshKeyForItem(item);
  const refreshKey = useFileRefreshStore((s) => s.contentRefreshKeys[refreshPath] ?? 0);
  const changedPaths = useFileRefreshStore((s) => s.lastChangedContextFile[refreshPath] ?? null);
  return renderViewer(
    { hostTeamKey: item.team, filePath: item.id, refreshKey, teamContentPath: "" },
    { changedPaths },
  );
}

const ownsItem = (frame: LiveFrame, item: ItemKey) => frameOf(frame, item.team, item.id);

function DefaultSatelliteContent({
  content,
  actions,
}: {
  content: SatelliteContent;
  actions: SatelliteActions;
}): ReactNode {
  const item = "item" in content && content.item.kind === TAB_ITEM_KIND ? content.item : null;
  const shown = useMemo(() => (item ? [item] : []), [item]);
  // A handed-off item stays mounted, hidden, until its frames have flushed and retired.
  const mounted = useRetiringFrames(shown, canonicalItemKey, ownsItem);
  return (
    <>
      {mounted.map((each) => (
        <div
          key={canonicalItemKey(each)}
          data-viewer-path={each.id}
          className="h-full w-full"
          style={each === item ? undefined : { display: "none" }}
        >
          <SatelliteViewer item={each} />
        </div>
      ))}
      {"state" in content && content.state === "pending" && (
        <div role="status" className={PLACEHOLDER}>
          <p>
            Moving {content.caption.name}… It opens here when window {content.caption.sourceWindowN}{" "}
            lets go.
          </p>
        </div>
      )}
      {"state" in content && content.state === "empty" && (
        <div className={PLACEHOLDER}>
          <p className="text-foreground">Nothing in this window</p>
          <div className="flex gap-2">
            {actions.focusMain && (
              <Button variant="outline" size="sm" onClick={actions.focusMain}>
                Go to main window
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={actions.closeWindow}>
              Close window
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

const PLACEHOLDER =
  "flex h-full w-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground";

/** The provisional renderer: a tab item's existing tab body with no chrome, inside the
 *  `[data-viewer-path]` element `frameOf` reads, and the move placeholders. A layout draws
 *  nothing yet; the story that shows the window replaces this renderer. */
export function satelliteRenderer(actions: SatelliteActions): SatelliteRenderer {
  return (content) => <DefaultSatelliteContent content={content} actions={actions} />;
}

export const defaultSatelliteRenderer: SatelliteRenderer = satelliteRenderer({
  closeWindow: () =>
    void closeCurrentWindow().catch((e) => logger.warn("windows", `close window failed: ${e}`)),
});

export interface SatelliteRootProps {
  /** Where the slice comes from: the window registry in the app, a stub in tests. */
  source?: SliceSource;
  renderer?: SatelliteRenderer;
  /** The items this window has let go of in a move (`hand-off.ts`). */
  released?: ReleasedItems;
}

const NOTHING_RELEASED = {
  snapshot: () => null,
  subscribe: () => () => {},
};

export function SatelliteRoot({
  source = EMPTY_SLICE_SOURCE,
  renderer = defaultSatelliteRenderer,
  released,
}: SatelliteRootProps): ReactNode {
  // Installed before the rows first render, so they read this window's slice.
  useState(() => installSliceSource(source));
  useEffect(() => installSliceSource(source), [source]);
  useSatellitePathRefresh();
  const slice = useSyncExternalStore(source.subscribe, source.current);
  const releases = released ?? NOTHING_RELEASED;
  useSyncExternalStore(releases.subscribe, releases.snapshot);
  const content = satelliteContent(slice, released);
  return (
    <div data-satellite-root className="h-screen w-screen overflow-hidden">
      <BootRows rows={SATELLITE_ROWS} />
      {content && renderer(content)}
    </div>
  );
}
