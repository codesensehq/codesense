// SPDX-License-Identifier: MIT
/**
 * `main`'s side of a move: the hand-off of a tab it lets go (`hand-off.ts`), the abort that
 * takes it back, and the items that come back to it (`items-returned.ts`). Each event is
 * sent to `main` alone, so the listeners sit on `main`'s own webview.
 */
import { useEffect } from "react";
import { windowHandOffAck } from "@/tauri/commands";
import { currentWebviewWindow, isMainWindow } from "@/shared/lib/current-window";
import { safeUnlisten } from "@/shared/lib/tauri-listeners";
import { createHandOff, mainTabSide } from "./hand-off";
import { openReturnedItems } from "./items-returned";
import {
  HAND_OFF_EVENT,
  ITEMS_RETURNED_EVENT,
  MOVE_ABORTED_EVENT,
  type HandOffRequest,
  type ItemsReturned,
  type MoveAborted,
} from "./window-slice";

export function useMainWindowMoves() {
  useEffect(() => {
    if (!isMainWindow()) return;
    const handOff = createHandOff(mainTabSide(), windowHandOffAck);
    const offs = [
      currentWebviewWindow().listen<HandOffRequest>(HAND_OFF_EVENT, (event) => {
        void handOff.onHandOff(event.payload);
      }),
      currentWebviewWindow().listen<MoveAborted>(MOVE_ABORTED_EVENT, (event) =>
        handOff.onAborted(event.payload),
      ),
      currentWebviewWindow().listen<ItemsReturned>(ITEMS_RETURNED_EVENT, (event) =>
        openReturnedItems(event.payload),
      ),
    ];
    return () => {
      for (const off of offs) void off.then(safeUnlisten, () => {});
    };
  }, []);
}
