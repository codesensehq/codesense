// SPDX-License-Identifier: MIT
/**
 * The source's side of a move (`src-tauri/src/windows/moves.rs`). On `window:hand-off`
 * the source refuses an item with an unsaved edit, flushes the frames the item hosts
 * within the budget, checks the move is still current, lets the item go, and acks `ok`
 * only if the item is gone. The registry commits on that ack; until then the source
 * still owns the item, so an abort (`window:move-aborted`) during the flush means the
 * item is never let go, and one after it takes the item back.
 *
 * `main` lets a tab go through `closeTab`, which refuses a tab that became dirty during
 * the flush and retires every frame the tab hosts; an abort reopens it where it was (a tab
 * that was not open appends), as the preview tab if it was one. A
 * satellite hands its renderer `handed-off`, which retires the frame; an abort renders
 * the item again.
 */
import { flushFramesWhere } from "@/features/dashboard/lib/frame-lifecycle";
import { frameOf } from "@/features/dashboard/lib/frame-of";
import { logger } from "@/shared/lib/logger";
import {
  readTeamKeyed,
  updateTeamKeyed,
  useViewerStore,
  type TabState,
} from "@/shared/stores/viewer-store";

import { canonicalItemKey, type ItemKey } from "./item-key";
import { openItemTab, openWhenTeamReady, repoPathForItem } from "./items-returned";
import type { AckOutcome, HandOffAck, HandOffRequest, MoveAborted } from "./window-slice";

/** How a window lets an item go and takes it back. `R` is what `record` keeps for a
 *  take-back. */
export interface HandOffSide<R = unknown> {
  /** Runs when the hand-off arrives, before the flush. */
  record?(key: ItemKey): R;
  /** Lets the flushed item go; returns whether it is gone. */
  letGo(key: ItemKey, recorded: R | undefined): boolean;
  /** The move aborted after `letGo`: show the item again. */
  takeBack(key: ItemKey, recorded: R | undefined): void;
}

export interface HandOff {
  onHandOff(request: HandOffRequest): Promise<void>;
  onAborted(event: MoveAborted): void;
}

/** Whether `key` has an unsaved edit in this window. */
function isItemDirty(key: ItemKey): boolean {
  return readTeamKeyed(useViewerStore.getState().editingDirtyPaths, key.team, []).includes(key.id);
}

export function createHandOff<R>(
  side: HandOffSide<R>,
  ack: (ack: HandOffAck) => Promise<AckOutcome>,
): HandOff {
  // The moves this window is the source of, by moveId, until they commit or abort.
  const moves = new Map<string, { key: ItemKey; recorded?: R; released: boolean }>();
  const answer = async (reply: HandOffAck) => {
    if (!reply.ok) moves.delete(reply.moveId);
    try {
      if ((await ack(reply)) === "committed") moves.delete(reply.moveId);
    } catch (e) {
      logger.warn("windows", `hand-off ack for ${reply.moveId} not sent: ${String(e)}`);
    }
  };
  return {
    async onHandOff({ key, moveId, budgetMs }) {
      if (isItemDirty(key)) return answer({ moveId, ok: false, reason: "dirty" });
      const move = { key, recorded: side.record?.(key), released: false };
      moves.set(moveId, move);
      await flushFramesWhere((f) => frameOf(f, key.team, key.id), budgetMs);
      // An abort during the flush ends the move: the item stays.
      if (moves.get(moveId) !== move) return;
      if (!side.letGo(key, move.recorded)) return answer({ moveId, ok: false, reason: "dirty" });
      move.released = true;
      return answer({ moveId, ok: true });
    },
    onAborted({ moveId }) {
      const move = moves.get(moveId);
      if (!move) return;
      moves.delete(moveId);
      if (move.released) side.takeBack(move.key, move.recorded);
    },
  };
}

const tabsOf = (team: string): TabState[] =>
  readTeamKeyed(useViewerStore.getState().openTabs, team, []);

/** Where a tab was when its hand-off arrived. */
interface TabPlace {
  index: number;
  activePath: string | undefined;
  /** The team's content repo when the hand-off arrived, so a team that stops being ready
   *  before an abort still gets its tab back. */
  repoPath: string | null;
  /** The tab was the preview tab. */
  preview: boolean;
}

/** Marks `key`'s tab as the preview tab again. */
function repreview(key: ItemKey): void {
  useViewerStore.setState((s) => ({
    openTabs: updateTeamKeyed(
      s.openTabs,
      key.team,
      tabsOf(key.team).map((t) => (t.path === key.id ? { ...t, preview: true } : t)),
    ),
  }));
}

/** `main`'s side: the item is a viewer tab. */
export function mainTabSide(): HandOffSide<TabPlace> {
  return {
    record(key) {
      const tabs = tabsOf(key.team);
      const index = tabs.findIndex((t) => t.path === key.id);
      return {
        index,
        activePath: useViewerStore.getState().activeTab[key.team],
        repoPath: repoPathForItem(key),
        preview: tabs[index]?.preview === true,
      };
    },
    letGo(key, place) {
      const repoPath = place?.repoPath ?? repoPathForItem(key) ?? "";
      useViewerStore.getState().closeTab(key.team, repoPath, key.id);
      return !tabsOf(key.team).some((t) => t.path === key.id);
    },
    takeBack(key, place) {
      // `record` always runs on this side. Not open at hand-off (the user closed it during
      // the flush): nothing to give back.
      if (!place || place.index < 0) return;
      const repoPath = place.repoPath ?? repoPathForItem(key);
      if (repoPath === null) {
        // Queued until the team is ready; it comes back without its old position.
        openWhenTeamReady(key, place.preview);
        return;
      }
      openItemTab(key, repoPath, place.preview);
      const store = useViewerStore.getState();
      const tabs = tabsOf(key.team);
      const from = tabs.findIndex((t) => t.path === key.id);
      if (from >= 0 && from !== place.index) {
        store.reorderTab(key.team, from, Math.min(place.index, tabs.length - 1));
        // A reorder pins a preview tab; this one is going back as it was.
        if (place.preview) repreview(key);
      }
      const active = place.activePath;
      if (active !== undefined && active !== key.id && tabs.some((t) => t.path === active)) {
        store.setActiveTab(key.team, repoPath, active);
      }
    },
  };
}

/** The items a satellite has let go of while their move is in flight. */
export interface ReleasedItems {
  has(key: ItemKey): boolean;
  /** Changes whenever the set does, for `useSyncExternalStore`. */
  snapshot(): ReadonlySet<string>;
  subscribe(onChange: () => void): () => void;
  /** Forgets every released item the slice no longer holds (its move committed). */
  keepOnly(items: readonly ItemKey[]): void;
  /** A satellite's side: letting go marks the item released, taking back unmarks it. */
  side: HandOffSide<void>;
}

export function createReleasedItems(): ReleasedItems {
  let released: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  const change = (next: ReadonlySet<string>) => {
    released = next;
    for (const listener of listeners) listener();
  };
  return {
    has: (key) => released.has(canonicalItemKey(key)),
    snapshot: () => released,
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    keepOnly(items) {
      const held = new Set(items.map(canonicalItemKey));
      if ([...released].every((k) => held.has(k))) return;
      change(new Set([...released].filter((k) => held.has(k))));
    },
    side: {
      letGo(key) {
        change(new Set([...released, canonicalItemKey(key)]));
        return true;
      },
      takeBack(key) {
        const next = new Set(released);
        next.delete(canonicalItemKey(key));
        change(next);
      },
    },
  };
}
