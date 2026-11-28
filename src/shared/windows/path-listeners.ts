// SPDX-License-Identifier: MIT
/**
 * A satellite's side of a file change. Rust sends `context-file-change` to `main` and to
 * the satellites holding a tab the change covers (`src-tauri/src/windows/router.rs`), but
 * Tauri hands a global `listen` every emit whatever its target, so a satellite checks the
 * payload against its own items (`ownsPathEvent`) before it refreshes.
 *
 * The refresh is `main`'s own bump without its debounce: a satellite holds one item, so
 * one change is one bump of its own file-refresh store, which its viewer reads.
 */
import type { Event } from "@tauri-apps/api/event";
import { useEffect } from "react";

import { bumpKeyForContextFileChange } from "@/shared/lib/build-synthetic-repo";
import { isWithin } from "@/shared/lib/path";
import { bumpFileRefreshForSourceRepo } from "@/shared/lib/refresh-for-source-repo";
import { safeUnlisten } from "@/shared/lib/tauri-listeners";
import { CONTEXT_FILE_CHANGE_EVENT, type ContextFileChangePayload } from "@/tauri/events";

import { TAB_ITEM_KIND } from "./item-key";
import { listenScoped } from "./listen-scoped";
import { sliceSource } from "./slice";

/** A tab item's path: its id up to the first `?`. The split is for matching only. */
function tabPath(id: string): string {
  const query = id.indexOf("?");
  return query === -1 ? id : id.slice(0, query);
}

/** True when this window's slice holds a tab the change covers: the changed path is the
 *  tab's path, or a directory or root that contains it. */
export function ownsPathEvent(payload: ContextFileChangePayload): boolean {
  const changed = payload.file_path;
  if (!changed) return false;
  const items = sliceSource().current()?.items ?? [];
  return items.some((item) => item.kind === TAB_ITEM_KIND && isWithin(changed, tabPath(item.id)));
}

/** Bumps the refresh key the change resolves to, with the changed path, as `main` does. */
export function refreshItem(event: Event<ContextFileChangePayload>): void {
  const key = bumpKeyForContextFileChange(event.payload);
  if (key === null) return;
  const { file_path } = event.payload;
  bumpFileRefreshForSourceRepo(key, file_path ? new Set([file_path]) : undefined);
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
