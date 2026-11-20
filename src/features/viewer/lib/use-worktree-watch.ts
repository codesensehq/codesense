// SPDX-License-Identifier: MIT
import { useEffect, useRef } from "react";
import { useViewerStore } from "@/shared/stores/viewer-store";
import { useScopeActive, type ScopeKey } from "@/shared/lib/warm-scopes";
import { detachWorktreeWatch, lazyAttachWorktreeWatch } from "@/tauri/commands";
import { logger } from "@/shared/lib/logger";

/**
 * SLW-WD-9 (RD-13): a REF-COUNTED worktree watcher shared by every consumer of a
 * workspace's `worktree-file-change` signal.
 *
 * The backend keeps ONE watch per `wsId` (token-matched detach). Before WD-9 only
 * `source-editor-inset.tsx` attached it — so the source-diff overlay saw no live
 * events unless the editor inset happened to be open, and a naive second attach
 * would replace the first's token, letting whichever consumer closed last tear
 * the watch out from under the other. This hook fixes that: a module-level
 * refcount attaches on 0→1 and detaches on 1→0, so the inset + the overlay (and
 * any future consumer) share exactly one OS watch with no strand.
 */

/**
 * How long one attach or detach may hold its key's queue. The backend runs attaches on the
 * blocking pool with no timeout, so a hung mount can leave one unsettled; after this the next
 * operation proceeds, and a late attach token is reconciled when it lands.
 */
export const WATCH_OP_SETTLE_BOUND_MS = 5_000;

interface WatchEntry {
  count: number;
  cwd: string;
  /** The token of the last attach that resolved for this entry; `null` until one does. */
  token: number | null;
  /** The attach this entry is waiting on, or `null` once it has settled. */
  pending: object | null;
  /** Late tokens of superseded attaches, compared with `pending` once it settles. */
  held: number[];
}

/** Live entries only: an entry leaves the map when its count drops to 0. */
const watches = new Map<string, WatchEntry>();

/**
 * Per-key queue of attach and detach calls. The backend keeps one watch per key and mints its
 * token when an attach lands, so attaches racing on the blocking pool could land out of order
 * and the older one would replace the newer watch. Issuing them one at a time per key keeps the
 * backend seeing them in issue order, so the last attach wins. An operation on an idle key is
 * issued synchronously.
 */
const queues = new Map<string, Op[]>();

/** An operation calls `finish` once it has settled; `late` turns true if the bound got there first. */
interface Link {
  late: boolean;
  finish: () => void;
}
type Op = (link: Link) => void;

function enqueue(wsId: string, op: Op): void {
  const queue = queues.get(wsId);
  if (queue) {
    queue.push(op);
    return;
  }
  queues.set(wsId, []);
  run(wsId, op);
}

function run(wsId: string, op: Op): void {
  const queue = queues.get(wsId);
  let done = false;
  const link: Link = {
    late: false,
    finish: () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!queue || queues.get(wsId) !== queue) return;
      const next = queue.shift();
      if (next) run(wsId, next);
      else queues.delete(wsId);
    },
  };
  const timer = setTimeout(() => {
    link.late = true;
    link.finish();
  }, WATCH_OP_SETTLE_BOUND_MS);
  op(link);
}

function detach(wsId: string, token: number): void {
  enqueue(wsId, (link) => {
    detachWorktreeWatch(wsId, token)
      .catch(() => {})
      .finally(link.finish);
  });
}

/**
 * Queue an attach for a live entry. `resume` marks a re-attach after a late attach replaced the
 * entry's watch: once it lands, the change nonce is bumped so the gap is caught up.
 */
function attach(wsId: string, entry: WatchEntry, resume: boolean): void {
  const attempt = {};
  entry.pending = attempt;
  enqueue(wsId, (link) => {
    lazyAttachWorktreeWatch(wsId, entry.cwd).then(
      (token) => {
        const current = entry.pending === attempt;
        if (current) entry.pending = null;
        if (current && entry.count > 0) {
          entry.token = token;
          settleHeld(wsId, entry, token);
          if (resume) useViewerStore.getState().bumpWorktreeChangedPath(wsId, "", true);
          link.finish();
        } else if (!link.late) {
          // Everyone released before the attach resolved: detach before the next operation runs.
          detachWorktreeWatch(wsId, token)
            .catch(() => {})
            .finally(link.finish);
        } else {
          // Past the bound, the next attach may already have landed.
          reconcileLate(wsId, token);
        }
      },
      (err) => {
        logger.warn("useWorktreeWatch", `worktree watch attach failed for ${wsId} — ${err}`);
        if (entry.pending === attempt) {
          entry.pending = null;
          settleHeld(wsId, entry, null);
        }
        link.finish();
      },
    );
  });
}

/**
 * A superseded attach resolved after the queue moved on. Tokens follow the order attaches landed
 * in, so a token above the live entry's means this attach replaced the live watch.
 */
function reconcileLate(wsId: string, token: number): void {
  const live = watches.get(wsId);
  if (live?.pending) {
    live.held.push(token);
    return;
  }
  detach(wsId, token);
  if (live && live.token !== null && token > live.token) attach(wsId, live, true);
}

/** The entry's attach settled with `token` (`null` if it failed): reconcile the held tokens. */
function settleHeld(wsId: string, entry: WatchEntry, token: number | null): void {
  const held = entry.held.splice(0);
  for (const late of held) detach(wsId, late);
  if (token !== null && held.some((late) => late > token)) attach(wsId, entry, true);
}

function acquire(wsId: string, cwd: string): void {
  const existing = watches.get(wsId);
  if (existing) {
    existing.count++;
    return;
  }
  const entry: WatchEntry = { count: 1, cwd, token: null, pending: null, held: [] };
  watches.set(wsId, entry);
  // Fire-and-forget so a watch failure never blocks the mount.
  attach(wsId, entry, false);
}

function release(wsId: string): void {
  const entry = watches.get(wsId);
  if (!entry) return;
  entry.count--;
  if (entry.count > 0) return;
  watches.delete(wsId);
  for (const late of entry.held.splice(0)) detach(wsId, late);
  // An attach still in flight sees count 0 when it resolves and detaches its own token.
  if (entry.pending === null && entry.token !== null) detach(wsId, entry.token);
}

/**
 * Attach the worktree watcher for `wsId` while `enabled` (and detach on cleanup),
 * ref-counted so multiple consumers share one watch. Idempotent per consumer —
 * each mount acquires exactly one reference. Workspace ids repeat across teams while the backend
 * keeps one watch per id, so a retained hidden team (`scope` not active) holds none: the shown
 * team's worktree is the one watched. When the team is shown again the hook signals "resumed"
 * (a change-nonce bump) so consumers catch up on what the missed window changed.
 */
export function useWorktreeWatch(
  wsId: string,
  cwd: string,
  enabled: boolean,
  scope?: ScopeKey | null,
): void {
  const ownsWatch = useScopeActive(scope);
  const suspendedRef = useRef(false);
  useEffect(() => {
    if (!enabled || !wsId || !cwd) return;
    if (!ownsWatch) {
      suspendedRef.current = true;
      return;
    }
    acquire(wsId, cwd);
    // The native attach emits no catch-up, so edits made while this team was hidden are
    // invisible. Resume signals the shared per-workspace change nonce once; every consumer
    // reconciles through its existing disk-change path (a dirty editor takes its conflict path).
    if (suspendedRef.current) {
      suspendedRef.current = false;
      useViewerStore.getState().bumpWorktreeChangedPath(wsId, "", true);
    }
    return () => release(wsId);
  }, [enabled, ownsWatch, wsId, cwd]);
}

/** Test-only: reset the shared refcount map and per-key queues between cases. */
export function __resetWorktreeWatch(): void {
  watches.clear();
  queues.clear();
}
