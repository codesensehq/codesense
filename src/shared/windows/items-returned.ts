// SPDX-License-Identifier: MIT
/**
 * `main`'s side of an item coming back (`window:items-returned`, sent by
 * `src-tauri/src/windows/moves.rs` after `main`'s owner map): each tab item opens in its
 * origin team, through `openFile` with `keepLayout`, so the active team and the layout
 * stay as they are. `openFile`'s exact-path match dedupes a tab that is already open. An
 * item whose team is not ready yet is queued and opens when the team is.
 */
import { logger } from "@/shared/lib/logger";
import { resolveTeamContentContext } from "@/shared/lib/team-content-context";
import { useOrgStore } from "@/shared/stores/org-store";
import { useViewerStore } from "@/shared/stores/viewer-store";

import { canonicalItemKey, TAB_ITEM_KIND, type ItemKey } from "./item-key";
import type { ItemsReturned } from "./window-slice";

/** The content repo `openFile` takes for `key`'s team, or `null` while the team's
 *  context is not ready. */
export function repoPathForItem(key: ItemKey): string | null {
  const { orgs, discoveryComplete } = useOrgStore.getState();
  const content = resolveTeamContentContext(key.team, orgs, discoveryComplete);
  return content.kind === "ready" ? content.source.repoPath : null;
}

/** Opens `key`'s tab now: pinned, or as the preview tab when it was one. */
export function openItemTab(key: ItemKey, repoPath: string, preview = false): void {
  const store = useViewerStore.getState();
  const open = preview ? store.openFilePreview : store.openFile;
  open(key.team, repoPath, key.id, { keepLayout: true });
}

interface Waiting {
  key: ItemKey;
  preview: boolean;
}

// Items whose team was not ready when they came back, opened when it becomes ready.
const waiting: Waiting[] = [];
let stopWatching: (() => void) | null = null;

function openWaiting(): void {
  for (const item of waiting.splice(0)) {
    const repoPath = repoPathForItem(item.key);
    if (repoPath === null) waiting.push(item);
    else openItemTab(item.key, repoPath, item.preview);
  }
  if (waiting.length === 0) {
    stopWatching?.();
    stopWatching = null;
  }
}

/** Opens `key` in its origin team, or queues it until that team is ready: an item that
 *  came back is never dropped. */
export function openWhenTeamReady(key: ItemKey, preview = false): void {
  const repoPath = repoPathForItem(key);
  if (repoPath !== null) {
    openItemTab(key, repoPath, preview);
    return;
  }
  logger.warn("windows", `returned item ${key.id} waits: ${key.team} is not ready`);
  if (!waiting.some((w) => canonicalItemKey(w.key) === canonicalItemKey(key))) {
    waiting.push({ key, preview });
  }
  stopWatching ??= useOrgStore.subscribe(openWaiting);
}

/** Forgets every queued item. */
export function resetWaitingItemsForTests(): void {
  waiting.length = 0;
  stopWatching?.();
  stopWatching = null;
}

/** Opens every returned tab item in its origin team. */
export function openReturnedItems({ items }: ItemsReturned): void {
  for (const key of items) {
    if (key.kind === TAB_ITEM_KIND) openWhenTeamReady(key);
  }
}
