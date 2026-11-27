// SPDX-License-Identifier: MIT
/**
 * `main`'s side of an item coming back (`window:items-returned`, sent by
 * `src-tauri/src/windows/moves.rs` after `main`'s owner map): each tab item opens in its
 * origin team, through `openFile` with `keepLayout`, so the active team and the layout
 * stay as they are. `openFile`'s exact-path match dedupes a tab that is already open.
 */
import { logger } from "@/shared/lib/logger";
import { resolveTeamContentContext } from "@/shared/lib/team-content-context";
import { useOrgStore } from "@/shared/stores/org-store";
import { useViewerStore } from "@/shared/stores/viewer-store";

import { TAB_ITEM_KIND, type ItemKey } from "./item-key";
import type { ItemsReturned } from "./window-slice";

/** The content repo `openFile` takes for `key`'s team, or `null` while the team's
 *  context is not ready. */
export function repoPathForItem(key: ItemKey): string | null {
  const { orgs, discoveryComplete } = useOrgStore.getState();
  const content = resolveTeamContentContext(key.team, orgs, discoveryComplete);
  return content.kind === "ready" ? content.source.repoPath : null;
}

/** Opens every returned tab item in its origin team. */
export function openReturnedItems({ items }: ItemsReturned): void {
  for (const key of items) {
    if (key.kind !== TAB_ITEM_KIND) continue;
    const repoPath = repoPathForItem(key);
    if (repoPath === null) {
      logger.warn("windows", `returned item ${key.id} not opened: ${key.team} is not ready`);
      continue;
    }
    useViewerStore.getState().openFile(key.team, repoPath, key.id, { keepLayout: true });
  }
}
