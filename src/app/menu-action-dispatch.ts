// SPDX-License-Identifier: MIT
import { beginContextNavigation } from "@/shared/lib/context-navigation";
import { handlePanelMenuAction } from "@/features/shell/right-pane/panel-menu";
import { isRowPopupFocused, editorOwnsShortcut } from "@/shared/lib/focus-utils";
import { isDispatchable } from "@/shared/lib/shortcuts/is-dispatchable";
import { findShortcutAction } from "@/shared/lib/shortcuts/registry";
import { NO_TEAM_SENTINEL } from "@/shared/lib/team-key";
import { getActiveWorkspaceContext } from "@/shared/hooks/use-active-workspace-context";
import { useUiStore } from "@/shared/stores/ui-store";

/** Where a dispatch came from: the native menu (`menu:action`) or a key a frame forwarded. */
type DispatchSource = "menu" | "frame";

/**
 * How long a registry action's second arrival, by the OTHER path, still counts as the same
 * keystroke. A chord pressed with focus in a frame arrives twice: the frame shim cannot
 * cancel a host chord, so it forwards it (after a zero-delay timer) AND WebKit, seeing the
 * key unhandled, fires the menu accelerator. The two land within a few milliseconds of each
 * other, but the menu event crosses the native bridge and either can be delayed by a busy
 * main thread, so allow 150 ms. That stays well under the gap between two deliberate presses
 * (a held key's first repeat comes after about 250 ms or more, and two deliberate taps of the
 * same chord are further apart than that), so a real second press is not swallowed.
 */
const SAME_KEYSTROKE_WINDOW_MS = 150;

/** The last action that ran, and how, so its other-path twin can be recognised. */
let lastRun: { id: string; source: DispatchSource; at: number } | null = null;

/**
 * Whether this arrival is the other path's copy of the keystroke that just ran. Only a
 * different source pairs: a repeat by the same path is a real second press and always runs.
 * A recognised copy consumes the pair, so a later arrival starts afresh.
 */
function isTwinOfLastRun(id: string, source: DispatchSource, now: number): boolean {
  const last = lastRun;
  const elapsed = last ? now - last.at : 0;
  if (
    last &&
    last.id === id &&
    last.source !== source &&
    elapsed >= 0 &&
    elapsed <= SAME_KEYSTROKE_WINDOW_MS
  ) {
    lastRun = null;
    return true;
  }
  lastRun = { id, source, at: now };
  return false;
}

/**
 * Dispatch a native `menu:action` payload through the shortcut registry.
 *
 * With focus in the host DOM, a menu key-equivalent is consumed before the page sees it
 * (the host keydown handler prevents default), so the action arrives once. With focus in a
 * frame the key is not prevented, so it arrives by BOTH paths, the frame's forwarded key
 * (`dispatchFrameShortcut`) and this menu event, and a toggle would cancel itself. Each
 * registry action therefore runs once per keystroke across the two paths; see
 * `isTwinOfLastRun`. A menu-triggered action must also obey the SAME gate the
 * keyboard handler enforces: workspace-scope actions need a focused workspace
 * in the active team, only a few global actions fire while focus is in a row popup of the Agents pane,
 * and on the Settings tab only the terminal-section workspace actions
 * (`SETTINGS_TAB_WORKSPACE_ALLOWED`) and the team actions outside
 * `SETTINGS_TAB_BLOCKED` dispatch, exactly as on the keyboard.
 * This routes through the same `isDispatchable` gate as `useShortcutHandler`,
 * sourcing the gate state imperatively because it runs outside the React tree.
 */
export function dispatchMenuAction(payload: string, source: DispatchSource = "menu"): void {
  // Panel toggles (id `panel:<id>`) route to the right-pane layout; everything
  // else dispatches via the shortcut registry.
  if (payload.startsWith("panel:")) beginContextNavigation();
  if (handlePanelMenuAction(payload)) return;
  const action = findShortcutAction(payload);
  if (!action || editorOwnsShortcut(action.id, document.activeElement)) return;

  // The active team's focused workspace (`focusedWorkspaceOf`), the same read the keyboard
  // handler gates on.
  const dispatchable = isDispatchable(action, getMenuActionGate());
  if (!dispatchable) return;

  if (isTwinOfLastRun(action.id, source, Date.now())) return;

  action.run();
}

/** Run an action for a key a frame forwarded; the other half of a keystroke the menu also saw. */
export function dispatchFrameShortcut(payload: string): void {
  dispatchMenuAction(payload, "frame");
}

/** Read the current UI gate for imperative menu and iframe shortcut handlers. */
export function getMenuActionGate() {
  const { teamKey, workspace } = getActiveWorkspaceContext();
  return {
    settingsPanelOpen: useUiStore.getState().settingsPanelOpen,
    hasActiveWorkspace: workspace !== null,
    hasTeam: teamKey !== NO_TEAM_SENTINEL,
    rowPopupFocused: isRowPopupFocused(),
  };
}
