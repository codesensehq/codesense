// SPDX-License-Identifier: MIT
import { useLayoutEffect, useState, type RefObject } from "react";

/** What a message can hold that Tab would stop on: its actions, links and framed dashboards. */
const FOCUSABLE = "button, a[href], input, select, textarea, iframe, [tabindex]";
/** The tabindex a control had before the thread took it out of the Tab order ("" for none). */
const HELD = "data-roving-tabindex";
const ROW = "[data-mid]";

/** Put `el` (a message's control) in the Tab order when its message is the stop, else out. */
function setControl(el: HTMLElement, on: boolean) {
  if (on && el.hasAttribute(HELD)) {
    const was = el.getAttribute(HELD)!;
    el.removeAttribute(HELD);
    if (was === "") el.removeAttribute("tabindex");
    else el.setAttribute("tabindex", was);
  } else if (!on && !el.hasAttribute(HELD)) {
    el.setAttribute(HELD, el.getAttribute("tabindex") ?? "");
    el.setAttribute("tabindex", "-1");
  }
}

/** Apply the Tab order to `node` and what it holds: rows by `active`, controls by their row. */
function applyTo(node: Element, active: string | null) {
  const rows = node.matches(ROW)
    ? [node, ...node.querySelectorAll(ROW)]
    : node.querySelectorAll(ROW);
  for (const row of rows)
    (row as HTMLElement).tabIndex = (row as HTMLElement).dataset.mid === active ? 0 : -1;
  const controls = node.matches(FOCUSABLE) && !node.matches(ROW) ? [node] : [];
  for (const el of [...controls, ...node.querySelectorAll(FOCUSABLE)]) {
    if (el.matches(ROW)) continue;
    const row = el.closest<HTMLElement>(ROW);
    if (row) setControl(el as HTMLElement, row.dataset.mid === active);
  }
}

/**
 * The chat's thread as one Tab stop (the roving tabindex): the active message, by default the
 * newest, and that message's own actions are in the Tab order; every other message and its
 * controls are not. Up and Down move between messages, Home and End go to the first and the
 * newest, and focusing anything inside a message makes it the active one (so a Pin's note and
 * Undo stay reachable where the person acted). Messages are the scroller's `[data-mid]` rows.
 */
export function useRovingThread(
  scroller: RefObject<HTMLElement | null>,
  keys: string[],
  /** Off, the rows keep their own Tab order (the Inbox pane's conversation). */
  enabled = true,
): {
  /** Where focus goes when the thread is entered from outside it (Jump to latest). */
  focusNewest: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  onFocus: (e: React.FocusEvent<HTMLElement>) => void;
} {
  const [picked, setPicked] = useState<string | null>(null);
  // A message that left the thread (trimmed at the cap) hands the stop back to the newest.
  const active = picked !== null && keys.includes(picked) ? picked : (keys.at(-1) ?? null);

  // The whole thread once when the stop moves; after that only what is added (a new message, or
  // a dashboard's frame or an image a message draws after the render).
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root || !enabled) return;
    applyTo(root, active);
    const watch = new MutationObserver((changes) => {
      for (const change of changes)
        for (const node of change.addedNodes) if (node instanceof Element) applyTo(node, active);
    });
    watch.observe(root, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [scroller, active, enabled]);

  const moveTo = (key: string | undefined) => {
    const root = scroller.current;
    if (key === undefined || !root) return;
    setPicked(key);
    const row = root.querySelector<HTMLElement>(`[data-mid="${CSS.escape(key)}"]`);
    if (!row) return;
    // The new stop takes the tabindex before it takes focus, so focus never sits on a -1 row.
    row.tabIndex = 0;
    row.focus({ preventScroll: true });
    row.scrollIntoView?.({ block: "nearest" });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const row = e.target as HTMLElement;
    // Only on a message itself: inside it, the keys belong to its controls.
    if (!enabled || !row.matches(ROW) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const at = keys.indexOf(row.dataset.mid ?? "");
    if (at < 0) return;
    const to =
      e.key === "ArrowUp"
        ? Math.max(0, at - 1)
        : e.key === "ArrowDown"
          ? Math.min(keys.length - 1, at + 1)
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? keys.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    moveTo(keys[to]);
  };

  const onFocus = (e: React.FocusEvent<HTMLElement>) => {
    if (!enabled) return;
    const key = (e.target as HTMLElement).closest<HTMLElement>(ROW)?.dataset.mid;
    if (key) setPicked(key);
  };

  return { focusNewest: () => moveTo(keys.at(-1)), onKeyDown, onFocus };
}
