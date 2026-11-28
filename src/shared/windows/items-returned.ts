// SPDX-License-Identifier: MIT
/**
 * `main`'s side of an item coming back (`window:items-returned`, sent by
 * `src-tauri/src/windows/moves.rs` and `returns.rs` after `main`'s owner map). What
 * happens to an item depends on its kind and its team, never on the window it left:
 * - a tab opens in its origin team, through `openFile` with `keepLayout`, so the active
 *   team and the layout stay as they are. `openFile`'s exact-path match dedupes a tab
 *   that is already open. An item whose team is not ready yet is queued and opens when
 *   the team is;
 * - a kind this build does not know (a newer version's) opens nothing, and one notice
 *   lists how many; a move posts none, since the item was live a moment ago;
 * - an item whose team was removed (`removed_team`) is closed, with one "team was removed"
 *   notice per team. One whose team is otherwise unavailable when it comes back, or once
 *   it is ready to open (archived, a malformed key, no org root, no teams), is not
 *   reopened, with one "team isn't available" notice per team.
 */
import { toast } from "sonner";

import { logger } from "@/shared/lib/logger";
import { parseTeamKey } from "@/shared/lib/parse-team-key";
import { resolveTeamContentContext } from "@/shared/lib/team-content-context";
import { useOrgStore } from "@/shared/stores/org-store";
import { useViewerStore } from "@/shared/stores/viewer-store";

import { canonicalItemKey, TAB_ITEM_KIND, type ItemKey } from "./item-key";
import type { ItemsReturned } from "./window-slice";

/** The kinds `main` knows. Only a tab has an opener so far; a workspace, tile or notes
 *  item gets its branch with the window that shows it. */
const KNOWN_KINDS: ReadonlySet<string> = new Set([TAB_ITEM_KIND, "workspace", "tile", "notes"]);

/** The content repo `openFile` takes for `key`'s team, or `null` while the team's
 *  context is not ready. */
export function repoPathForItem(key: ItemKey): string | null {
  const content = contentOfItem(key);
  return content.kind === "ready" ? content.source.repoPath : null;
}

function contentOfItem(key: ItemKey) {
  const { orgs, discoveryComplete } = useOrgStore.getState();
  return resolveTeamContentContext(key.team, orgs, discoveryComplete);
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
  const gone: ItemKey[] = [];
  for (const item of waiting.splice(0)) {
    const content = contentOfItem(item.key);
    if (content.kind === "ready") {
      openItemTab(item.key, content.source.repoPath, item.preview);
    } else if (content.kind === "loading") {
      waiting.push(item);
    } else {
      // `unavailable` and `no-teams` last until the org list changes: do not wait on them.
      gone.push(item.key);
    }
  }
  noticeUnavailable(gone);
  if (waiting.length === 0) {
    stopWatching?.();
    stopWatching = null;
  }
}

/** Opens `key` in its origin team, or queues it while that team is loading. A queued item
 *  is dropped, with the team-unavailable notice, if its team turns out unavailable or there
 *  are no teams. */
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

function plural(n: number): string {
  return `${n} ${n === 1 ? "item" : "items"}`;
}

/** One notice per team of `keys`, worded by `say`. */
function noticePerTeam(keys: readonly ItemKey[], say: (items: string, team: string) => string) {
  const byTeam = new Map<string, number>();
  for (const key of keys) byTeam.set(key.team, (byTeam.get(key.team) ?? 0) + 1);
  for (const [team, n] of byTeam) {
    toast.info(say(plural(n), parseTeamKey(team).teamName ?? team));
  }
}

/** The notice for items closed because their team was removed. */
function noticeRemoved(keys: readonly ItemKey[]): void {
  noticePerTeam(keys, (items, team) => `Closed ${items} of ${team}: the team was removed`);
}

/** The notice for items not reopened because their team is unavailable. */
function noticeUnavailable(keys: readonly ItemKey[]): void {
  noticePerTeam(
    keys,
    (items, team) => `Couldn't reopen ${items} of ${team}: the team isn't available`,
  );
}

function teamIsGone(key: ItemKey): boolean {
  const { kind } = contentOfItem(key);
  return kind === "unavailable" || kind === "no-teams";
}

/** Opens, closes or lists each returned item by its kind and its team (see above). */
export function openReturnedItems({ items, reason }: ItemsReturned): void {
  const removed: ItemKey[] = [];
  const unavailable: ItemKey[] = [];
  let newer = 0;
  for (const key of items) {
    if (reason === "removed_team") removed.push(key);
    else if (!KNOWN_KINDS.has(key.kind)) newer += 1;
    else if (teamIsGone(key)) unavailable.push(key);
    else if (key.kind === TAB_ITEM_KIND) openWhenTeamReady(key);
  }
  if (newer > 0 && reason !== "move") {
    toast.info(`Couldn't reopen ${plural(newer)} from a newer version`);
  }
  noticeRemoved(removed);
  noticeUnavailable(unavailable);
}
