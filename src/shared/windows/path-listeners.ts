// SPDX-License-Identifier: MIT
/**
 * A satellite's side of a file change. Rust sends `context-file-change` to `main` and to
 * the satellites holding a tab the change covers (`src-tauri/src/windows/router.rs`), but
 * Tauri hands a global `listen` every emit whatever its target, so a satellite checks the
 * payload against its own items (`ownsPathEvent`) before it refreshes.
 *
 * The refresh bumps, in the window's own file-refresh store, the key each covered item's
 * viewer reads (`refreshKeyForItem`). The key comes from the item alone, since a satellite
 * loads no org list: the key `main`'s viewer reads for the same file, `team:{org}:{team}`,
 * or a private file's content root. There is no debounce: a satellite holds one item.
 */
import type { Event } from "@tauri-apps/api/event";
import { useEffect } from "react";

import { teamAllContextId } from "@/shared/lib/context-model";
import { parseTeamKey } from "@/shared/lib/parse-team-key";
import { isWithin } from "@/shared/lib/path";
import { privateFile } from "@/shared/lib/private-file";
import { bumpFileRefreshForSourceRepo } from "@/shared/lib/refresh-for-source-repo";
import { safeUnlisten } from "@/shared/lib/tauri-listeners";
import { CONTEXT_FILE_CHANGE_EVENT, type ContextFileChangePayload } from "@/tauri/events";

import { TAB_ITEM_KIND, type ItemKey } from "./item-key";
import { listenScoped } from "./listen-scoped";
import { sliceSource } from "./slice";

/** A tab item's path: its id up to the first `?`. The split is for matching only. */
function tabPath(id: string): string {
  const query = id.indexOf("?");
  return query === -1 ? id : id.slice(0, query);
}

/** The refresh key a tab item's viewer reads, from the item alone: a private file's content
 *  root, else its team's content (`main` reads the same key for the same file). `""` for a
 *  team key with no team. */
export function refreshKeyForItem(item: ItemKey): string {
  const contentRoot = privateFile(tabPath(item.id))?.contentRoot;
  if (contentRoot) return contentRoot;
  const { orgSlug, teamName } = parseTeamKey(item.team);
  return teamName ? teamAllContextId(orgSlug, teamName) : "";
}

/** The tabs this window's slice holds that the change covers: the changed path is the
 *  tab's path, or a directory or root that contains it. */
function coveredTabs(payload: ContextFileChangePayload): ItemKey[] {
  const changed = payload.file_path;
  if (!changed) return [];
  const items = sliceSource().current()?.items ?? [];
  return items.filter((item) => item.kind === TAB_ITEM_KIND && isWithin(changed, tabPath(item.id)));
}

/** True when this window's slice holds a tab the change covers. */
export function ownsPathEvent(payload: ContextFileChangePayload): boolean {
  return coveredTabs(payload).length > 0;
}

/** Bumps the key each covered tab's viewer reads, with the changed path. */
export function refreshItem(event: Event<ContextFileChangePayload>): void {
  const { file_path } = event.payload;
  if (!file_path) return;
  const keys = new Set(coveredTabs(event.payload).map(refreshKeyForItem));
  for (const key of keys) {
    if (key) bumpFileRefreshForSourceRepo(key, new Set([file_path]));
  }
}

/** Refreshes this satellite's held item when its file changes outside the window. */
export function useSatellitePathRefresh(): void {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    listenScoped<ContextFileChangePayload>(
      CONTEXT_FILE_CHANGE_EVENT,
      "owning-window",
      refreshItem,
      ownsPathEvent,
    )
      .then((fn) => {
        if (disposed) safeUnlisten(fn);
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      if (unlisten) safeUnlisten(unlisten);
    };
  }, []);
}
