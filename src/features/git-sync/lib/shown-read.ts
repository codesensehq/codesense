// SPDX-License-Identifier: MIT
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { trimTrailingSeparators } from "@/shared/lib/path";
import { createListenerGroup } from "@/shared/lib/tauri-listeners";
import { listenScoped } from "@/shared/windows/listen-scoped";
import { CONTEXT_GIT_MOVED_EVENT, type ContextGitMovedPayload } from "@/tauri/events";

export interface ShownRead<T> {
  /** The last answer, kept while a newer read is pending, hidden or failed. */
  value: T | null;
  /** The last read failed; it reads again when the key moves. */
  error: string | null;
  /** The answer is for an older key: the key moved while hidden, or the read for the
   *  current key failed. The next show or key move reads again. */
  stale: boolean;
  loading: boolean;
}

/**
 * Read only while `shown`, once per `key`. A key that moves while shown reads again
 * at once; one that moves while hidden marks the answer stale and reads on the next
 * show. A hidden reader never reads, and a show with an unchanged key reads nothing.
 * A failed read keeps the last answer, marks it stale, and is tried again on the next
 * key move.
 */
export function useShownRead<T>(shown: boolean, key: string, read: () => Promise<T>): ShownRead<T> {
  const [state, setState] = useState<{
    key: string | null;
    value: T | null;
    error: string | null;
    failed: string | null;
  }>({ key: null, value: null, error: null, failed: null });
  const readRef = useRef(read);
  useLayoutEffect(() => {
    readRef.current = read;
  });
  const { key: readKey, failed } = state;
  useEffect(() => {
    if (!shown || readKey === key || failed === key) return;
    let cancelled = false;
    readRef.current().then(
      (value) => {
        if (!cancelled) setState({ key, value, error: null, failed: null });
      },
      (e: unknown) => {
        if (!cancelled)
          setState((s) => ({
            ...s,
            error: e instanceof Error ? e.message : String(e),
            failed: key,
          }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [shown, key, readKey, failed]);
  return {
    value: state.value,
    error: state.error,
    stale: state.key !== null && state.key !== key,
    loading: shown && state.key !== key && state.failed !== key,
  };
}

/**
 * How many times a head or a branch ref moved in one of `paths` (repo roots), counted
 * from mount. Paths are one string, joined by newlines, so a caller's fresh array never
 * re-subscribes; a move elsewhere changes nothing.
 */
export function useHeadMoves(paths: string): number {
  const [moves, setMoves] = useState(0);
  useEffect(() => {
    const watched = new Set(paths.split("\n").filter(Boolean).map(trimTrailingSeparators));
    if (watched.size === 0) return;
    const group = createListenerGroup();
    group.track(
      listenScoped<ContextGitMovedPayload>(CONTEXT_GIT_MOVED_EVENT, "every-window", (event) => {
        const { repoPath, kinds } = event.payload;
        if (!watched.has(trimTrailingSeparators(repoPath))) return;
        if (kinds.some((k) => k === "head" || k === "refs")) setMoves((n) => n + 1);
      }),
    );
    return () => group.dispose();
  }, [paths]);
  return moves;
}
