// SPDX-License-Identifier: MIT
/**
 * A tile body's frame: its cell's tab bar above the body. The tile host mounts it once around
 * each body (`wrapBody`), so a tab added, closed or shown redraws the bars and never the bodies:
 * a body is the frame's `children`, the same element across those redraws.
 *
 * The window hands the tabs and their actions down through `TileTabsContext`.
 */
import { createContext, useContext, type ReactNode } from "react";

import { tabsOf, type CellTabsMap } from "@/shared/tiling/tile-tabs";

import { TileTabBar, type TileTab } from "./tile-tab-bar";

export interface TileTabsView {
  /** Each cell's tabs, the same map the host is given as `cellTabs`. */
  cells: CellTabsMap;
  /** A tab's face in the bar. */
  describe(key: string): TileTab;
  onSelect(cell: string, key: string): void;
  onClose(cell: string, key: string): void;
  onReorder?(cell: string, from: number, to: number): void;
  onNewTab?(cell: string): void;
  /** The active tab's controls and identity, by its key. */
  controlsOf?(key: string): ReactNode;
  identityOf?(key: string): ReactNode;
  /** A tab's menu items, by its key: ⋯ shows the active tab's, a right-click any tab's. */
  menuOf?(key: string): ReactNode;
}

export const TileTabsContext = createContext<TileTabsView | null>(null);

/** The cell whose tabs hold `key`: the cell listing it, else the key's own one-tab cell. */
function cellOf(cells: CellTabsMap, key: string): string {
  for (const [cell, tabs] of cells) if (tabs.keys.includes(key)) return cell;
  return key;
}

export function TileTabFrame({ tileKey, children }: { tileKey: string; children: ReactNode }) {
  const view = useContext(TileTabsContext);
  if (!view) return <>{children}</>;
  const cell = cellOf(view.cells, tileKey);
  const tabs = tabsOf(view.cells, cell);
  const { onReorder, onNewTab } = view;
  return (
    <div data-tile-frame={cell} className="flex h-full w-full flex-col">
      <TileTabBar
        tabs={tabs.keys.map((key) => view.describe(key))}
        activeKey={tabs.active}
        onSelect={(key) => view.onSelect(cell, key)}
        onClose={(key) => view.onClose(cell, key)}
        onReorder={onReorder && ((from, to) => onReorder(cell, from, to))}
        onNewTab={onNewTab && (() => onNewTab(cell))}
        controls={view.controlsOf?.(tabs.active)}
        identity={view.identityOf?.(tabs.active)}
        menuOf={view.menuOf && ((key) => view.menuOf?.(key))}
      />
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}
