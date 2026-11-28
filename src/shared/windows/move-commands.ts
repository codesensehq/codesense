// SPDX-License-Identifier: MIT
/**
 * The shared move commands: "Move to New Window" and "Move into Main Window" for any item.
 * The context menu, the palette and the shortcuts all come here, so the `tiles` flag is
 * checked in one place and a refusal reads the same wherever it shows.
 *
 * A move is one `window_move_item` call. The registry raises and focuses the target once
 * the move commits, so a commit shows nothing here. An abort arrives at this window as
 * `window:move-aborted` and shows as a toast; `hand-off.ts` keeps the item in place.
 *
 * A refusal found before the move (the `window_can_move_bodies` answer, passed in as
 * `check`) disables the entry with its text, and running it anyway shows that text as the
 * toast without calling `window_move_item`. A terminal's refusal carries its own text from
 * the terminal check; every other reason's text is in `refusalText`.
 */
import { toast } from "sonner";

import { currentWebviewWindow, isMainWindow } from "@/shared/lib/current-window";
import { tilesEnabled } from "@/shared/lib/tiles-enabled";
import { windowMoveItem } from "@/tauri/commands";

import type { ItemKey } from "./item-key";
import { MOVE_ABORTED_EVENT, type MoveAborted, type MoveStart } from "./window-slice";

export const MOVE_TO_NEW_WINDOW = "Move to New Window";
export const MOVE_INTO_MAIN_WINDOW = "Move into Main Window";

/** One item's answer from `window_can_move_bodies`. `text` is set when the refusing check
 *  wrote its own, as the terminal check does. */
export interface CanMoveResult {
  key: ItemKey;
  ok: boolean;
  reason?: string;
  text?: string;
}

export interface MoveOptions {
  /** The up-front check's answers for the item, or for each tile of a group. */
  check?: readonly CanMoveResult[];
}

export interface MoveEntry {
  id: "move-to-new-window" | "move-into-main-window";
  label: string;
  /** Set when the move is refused; the entry shows disabled with this text. */
  disabledReason?: string;
  run(): Promise<void>;
}

/** The text a refusal or an abort shows for `name`, or `null` for one that shows nothing. */
function refusalText(reason: string, name: string): string | null {
  switch (reason) {
    case "self":
    case "tiles_off":
      return null;
    case "dirty":
      return `${name} has an unsaved edit; finish or discard it first`;
    case "moving":
    case "pending_target":
      return `${name} is already moving`;
    case "no_ack":
      return `Couldn’t move ${name}: the other window didn’t answer`;
    case "timeout":
    case "window_failed":
      return `Couldn’t move ${name}: the new window didn’t open`;
    case "occupied":
      return "That window already has an item open";
    case "gone":
    case "unknown_target":
      return `Couldn’t move ${name}: the other window closed`;
    default:
      return `Couldn’t move ${name}`;
  }
}

/** The first refusal's text in `check`, or `null` when every answer passes. */
function checkRefusal(check: readonly CanMoveResult[], name: string): string | null {
  const refused = check.find((result) => !result.ok);
  if (!refused) return null;
  return refused.text ?? refusalText(refused.reason ?? "", name);
}

/** The entries to offer for `key` in this window: none with the `tiles` flag off. */
export async function moveEntries(key: ItemKey, options: MoveOptions = {}): Promise<MoveEntry[]> {
  if (!(await tilesEnabled())) return [];
  const disabledReason = refusalFor(key, options) ?? undefined;
  const entries: MoveEntry[] = [
    {
      id: "move-to-new-window",
      label: MOVE_TO_NEW_WINDOW,
      disabledReason,
      run: async () => void (await moveItemToNewWindow(key, options)),
    },
  ];
  if (!isMainWindow()) {
    entries.push({
      id: "move-into-main-window",
      label: MOVE_INTO_MAIN_WINDOW,
      disabledReason,
      run: async () => void (await moveItemToMain(key, options)),
    });
  }
  return entries;
}

/** Moves `key` into a new window. `null` when nothing was asked of the registry. */
export function moveItemToNewWindow(
  key: ItemKey,
  options: MoveOptions = {},
): Promise<MoveStart | null> {
  return move(key, "new", options);
}

/** Moves `key` into the main window. `null` when nothing was asked of the registry. */
export function moveItemToMain(key: ItemKey, options: MoveOptions = {}): Promise<MoveStart | null> {
  return move(key, "main", options);
}

async function move(key: ItemKey, to: string, options: MoveOptions): Promise<MoveStart | null> {
  if (!(await tilesEnabled())) return null;
  const name = itemName(key);
  const refused = refusalFor(key, options);
  if (refused) {
    toast.error(refused);
    return null;
  }
  await listenForAborts();
  let start: MoveStart;
  try {
    start = await windowMoveItem(key, to);
  } catch {
    toast.error(`Couldn’t move ${name}`);
    return null;
  }
  if (start.status === "refused") {
    const text = refusalText(start.reason, name);
    if (text) toast.error(text);
  }
  return start;
}

function refusalFor(key: ItemKey, options: MoveOptions): string | null {
  return options.check ? checkRefusal(options.check, itemName(key)) : null;
}

/** The name a toast uses: the last segment of the item's path. */
function itemName(key: ItemKey): string {
  return key.id.slice(key.id.lastIndexOf("/") + 1) || key.id;
}

let abortListener: Promise<unknown> | null = null;

/** Starts listening for this window's aborts once, before its first move. */
function listenForAborts(): Promise<unknown> {
  abortListener ??= currentWebviewWindow()
    .listen<MoveAborted>(MOVE_ABORTED_EVENT, ({ payload }) => {
      const text = refusalText(payload.reason, itemName(payload.key));
      if (text) toast.error(text);
    })
    .catch(() => {
      abortListener = null;
    });
  return abortListener;
}

export function resetMoveCommandsForTests(): void {
  abortListener = null;
}
