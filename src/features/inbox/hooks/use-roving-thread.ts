// SPDX-License-Identifier: MIT
import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

import {
  rovingThread,
  type RovingThread,
} from "../../../../src-tauri/src/http/routes/dashboard_kit/chat/roving.js";

/**
 * The chat's thread as one Tab stop (the roving tabindex), by the kit's rule (`roving.js`, which the
 * kit's chat runs too): the active message, by default the newest, and that message's own actions
 * are in the Tab order; every other message and its controls are not. Up and Down move between
 * messages, Home and End go to the first and the newest, and focusing anything inside a message
 * makes it the active one (so a Pin's note and Undo stay reachable where the person acted). A
 * message focus is on that a render rebuilds keeps it, and one that leaves hands it to the newest.
 * Messages are the scroller's `[data-mid]` rows; `keys` changes when they do.
 */
export function useRovingThread(
  scroller: RefObject<HTMLElement | null>,
  keys: readonly string[],
  /** Off, the rows keep their own Tab order (the Inbox pane's conversation). */
  enabled = true,
): {
  /** Where focus goes when the thread is entered from outside it (Jump to latest). */
  focusNewest: () => void;
} {
  const nav = useRef<RovingThread | null>(null);
  // Whether focus was in the thread before a render: React may drop or rebuild the focused
  // message's node without a focusout, so this is what the kit's refresh is told.
  const inside = useRef<string | null>(null);

  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root || !enabled) return;
    const thread = rovingThread(root);
    nav.current = thread;
    const onIn = () => {
      inside.current = thread.focused();
    };
    const onOut = (e: FocusEvent) => {
      if (!(e.relatedTarget instanceof Node) || !root.contains(e.relatedTarget))
        inside.current = null;
    };
    root.addEventListener("focusin", onIn);
    root.addEventListener("focusout", onOut);
    thread.refresh();
    return () => {
      root.removeEventListener("focusin", onIn);
      root.removeEventListener("focusout", onOut);
      thread.release();
      nav.current = null;
    };
  }, [scroller, enabled]);

  useLayoutEffect(() => {
    nav.current?.refresh(inside.current);
  }, [keys]);

  return { focusNewest: useCallback(() => nav.current?.focusNewest(), []) };
}
