// SPDX-License-Identifier: MIT
/**
 * A tile's tabs: an ordered list of tile keys and the one it shows, per cell, in the form the
 * tile host reads (`cellTabs`). A cell with no entry holds one tab, its own leaf id.
 *
 * Every op is pure and returns new objects only where it changed: an op that changes nothing
 * returns the map it was given, and the other cells' entries keep their identity.
 */
import type { CellTabs } from "./tile-host";

export type CellTabsMap = ReadonlyMap<string, CellTabs>;

/** A cell's tabs, as the host reads them. */
export function tabsOf(cells: CellTabsMap, cell: string): CellTabs {
  return cells.get(cell) ?? { keys: [cell], active: cell };
}

function withCell(cells: CellTabsMap, cell: string, tabs: CellTabs | null): CellTabsMap {
  const next = new Map(cells);
  if (tabs) next.set(cell, tabs);
  else next.delete(cell);
  return next;
}

/** Adds `key` as a tab of `cell`, after the active tab unless `index` says where, and shows it
 *  unless `activate` is false. A key the cell already holds is only shown. */
export function openTab(
  cells: CellTabsMap,
  cell: string,
  key: string,
  options: { index?: number; activate?: boolean } = {},
): CellTabsMap {
  const tabs = tabsOf(cells, cell);
  if (tabs.keys.includes(key)) return activateTab(cells, cell, key);
  const at = options.index ?? tabs.keys.indexOf(tabs.active) + 1;
  const keys = [...tabs.keys];
  keys.splice(Math.max(0, Math.min(at, keys.length)), 0, key);
  return withCell(cells, cell, { keys, active: options.activate === false ? tabs.active : key });
}

/** Shows `key` in `cell`. A key the cell does not hold changes nothing. */
export function activateTab(cells: CellTabsMap, cell: string, key: string): CellTabsMap {
  const tabs = tabsOf(cells, cell);
  if (tabs.active === key || !tabs.keys.includes(key)) return cells;
  return withCell(cells, cell, { keys: tabs.keys, active: key });
}

/** Closes `key` in `cell`. Closing the shown tab shows the next one, else the one before.
 *  `emptied` says the cell held only that tab: its entry is gone and the caller prunes the leaf. */
export function closeTab(
  cells: CellTabsMap,
  cell: string,
  key: string,
): { cells: CellTabsMap; emptied: boolean } {
  const tabs = tabsOf(cells, cell);
  const at = tabs.keys.indexOf(key);
  if (at < 0) return { cells, emptied: false };
  if (tabs.keys.length === 1) return { cells: withCell(cells, cell, null), emptied: true };
  const keys = tabs.keys.filter((k) => k !== key);
  const active = tabs.active === key ? keys[Math.min(at, keys.length - 1)] : tabs.active;
  return { cells: withCell(cells, cell, { keys, active }), emptied: false };
}

/** Moves `key` to `index` among `cell`'s tabs. The shown tab stays shown. */
export function moveTab(cells: CellTabsMap, cell: string, key: string, index: number): CellTabsMap {
  const tabs = tabsOf(cells, cell);
  const from = tabs.keys.indexOf(key);
  const to = Math.max(0, Math.min(index, tabs.keys.length - 1));
  if (from < 0 || from === to) return cells;
  const keys = tabs.keys.filter((k) => k !== key);
  keys.splice(to, 0, key);
  return withCell(cells, cell, { keys, active: tabs.active });
}
