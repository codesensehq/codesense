// SPDX-License-Identifier: MIT
/**
 * Pane focus detection utilities.
 *
 * Determines which pane type has focus based on the active element's
 * DOM ancestry. Extensible: to add a new pane type, add a `.closest()`
 * check and extend the PaneType union.
 */

import { isInHiddenTeam, queryAllShown } from "@/shared/lib/warm-scopes";

export type PaneType = "file" | "terminal" | "scratch-note";

/** Marks a popup that shows a terminal outside the CLI (the Agents pane's quick view). Its
 *  terminal is not a CLI tab: the CLI's terminal verbs (close tab, cycle tabs, find) leave it be. */
export const TERMINAL_POPUP_ATTR = "data-terminal-popup";

/** Marks a row popup of the Agents pane (the quick view and the inbox chat). It closes itself on
 *  ⌘W, and while focus is inside one no shortcut acts on the CLI, its tiles, the tray or the
 *  workspaces behind it (see `isDispatchable`): only a short list of global ones that open on top. */
export const ROW_POPUP_ATTR = "data-row-popup";

/** True when keyboard focus is inside a row popup (the quick view or the inbox chat). */
export function isRowPopupFocused(): boolean {
  return document.activeElement?.closest(`[${ROW_POPUP_ATTR}]`) != null;
}

/** The ⌘W chord: ⌘ alone (no ⌃, ⌥ or ⇧) on the key that types `w`, as the app's other shortcuts
 *  read the letter. A layout with no Latin letters (Cyrillic, Greek…) puts a letter of its own
 *  script on W's place, and then that place counts. A Latin letter or a sign there is never ⌘W:
 *  AZERTY's `z` there is ⌘Z (undo), Lithuanian's `ž` is its own letter, Dvorak's `,` there is ⌘,
 *  (Settings), and each types `w` with another key. The one matcher every ⌘W reader goes through. */
export function isCmdW(
  e: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "key" | "code">,
): boolean {
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  // A synthesized or IME event can carry no key at all.
  const key = typeof e.key === "string" ? e.key.toLowerCase() : "";
  if (key === "w") return true;
  return e.code === "KeyW" && /^\p{L}$/u.test(key) && !/^\p{Script=Latin}$/u.test(key);
}

/** True when keyboard focus is inside a terminal popup (its terminal or its own controls). */
export function isTerminalPopupFocused(): boolean {
  return document.activeElement?.closest(`[${TERMINAL_POPUP_ATTR}]`) != null;
}

/** Returns which pane type currently has focus.
 *  - "terminal" if the active element is inside a CLI terminal's xterm container
 *    (a terminal popup's xterm is not one)
 *  - "scratch-note" if the active element is inside the scratch note editor
 *  - "file" as the default fallback
 */
export function getActivePaneType(): PaneType {
  const active = document.activeElement;
  if (active?.closest(".xterm") && !isTerminalPopupFocused()) return "terminal";
  if (active?.closest(".scratch-note-editor")) return "scratch-note";
  return "file";
}

/** Convenience: returns true if a CLI terminal has focus. */
export function isTerminalFocused(): boolean {
  return getActivePaneType() === "terminal";
}

/** Whether a keyboard target is in an editor that owns indent/outdent and text formatting. */
export function isTextEditorTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('.cm-editor, .ProseMirror, [contenteditable]:not([contenteditable="false"])') !==
      null
  );
}

/** Back and forward yield to an editor's bracket shortcuts on every dispatch path. */
export function editorOwnsShortcut(
  actionId: string,
  target: EventTarget | null,
  editorTarget = isTextEditorTarget(target),
): boolean {
  return (actionId === "nav.context-back" || actionId === "nav.context-forward") && editorTarget;
}

const OVERLAY = '[data-fullscreen="true"]';

/** Focus in a field that keeps its own keys: an input, a textarea, a contenteditable or a terminal. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      !!el.isContentEditable ||
      !!el.closest?.(".xterm"))
  );
}

/** Asks a maximize overlay (`FullscreenOverlayShell`) to exit: the one event Esc and ⌘W from a
 *  dashboard frame both send. */
export function requestOverlayExit(overlay: Element): void {
  overlay.dispatchEvent(new CustomEvent("codesense:frame-escape", { bubbles: true }));
}

/** Leaves a maximize overlay by the same event Esc from a frame sends, so ⌘W and Esc share one
 *  exit. With `within` (the element a forwarded ⌘W came from) only the overlay containing it
 *  exits; without, the topmost shown one does (the last in document order). Typing keeps its
 *  chord: focus in a field is left alone, as the overlay's own Esc handler does. Returns whether
 *  it acted. */
export function exitTopmostOverlay(within?: Element | null): boolean {
  const overlay = within
    ? within.closest<HTMLElement>(OVERLAY)
    : (queryAllShown(OVERLAY).at(-1) ?? null);
  if (!overlay || isInHiddenTeam(overlay) || isTypingTarget(document.activeElement)) return false;
  requestOverlayExit(overlay);
  return true;
}
