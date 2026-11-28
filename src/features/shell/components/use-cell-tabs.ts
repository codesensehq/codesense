// SPDX-License-Identifier: MIT
/**
 * A window's tabs per tile cell, for the tile host mount: each cell's ordered tabs and the one it
 * shows, and the tab bar's actions on them. These are the tiles' own tabs, not the viewer's.
 */
import { useMemo, useState } from "react";

import { tabFaceOfKey } from "@/features/viewer/components/tile-tab-faces";
import type { TileTabsView } from "@/features/viewer/components/tile-tab-frame";
import {
  activateTab,
  closeTab,
  moveTab,
  tabsOf,
  type CellTabsMap,
} from "@/shared/tiling/tile-tabs";

const NO_TABS: CellTabsMap = new Map();

/** The window's tabs per cell and the bar's actions on them. Closing a cell's last tab leaves
 *  the cell as it is: the tree is the team view's to change. */
export function useCellTabs(): TileTabsView {
  const [cells, setCells] = useState(NO_TABS);
  return useMemo(
    () => ({
      cells,
      describe: tabFaceOfKey,
      onSelect: (cell, key) => setCells((c) => activateTab(c, cell, key)),
      onClose: (cell, key) => setCells((c) => closeTab(c, cell, key).cells),
      onReorder: (cell, from, to) =>
        setCells((c) => {
          const key = tabsOf(c, cell).keys[from];
          return key === undefined ? c : moveTab(c, cell, key, to);
        }),
    }),
    [cells],
  );
}
