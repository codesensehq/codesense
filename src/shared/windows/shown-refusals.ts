// SPDX-License-Identifier: MIT
/**
 * The items whose move refusal this window has shown already. `main` lets a tab go
 * through `closeTab`, which shows its own toast when it refuses a tab that turned dirty
 * during the hand-off; the abort that follows then adds no second one
 * (`move-commands.ts`). A new hand-off of the item clears its mark.
 */
import { canonicalItemKey, type ItemKey } from "./item-key";

const shown = new Set<string>();

/** This window has shown why `key` can't move. */
export function markRefusalShown(key: ItemKey): void {
  shown.add(canonicalItemKey(key));
}

/** Whether this window has shown why `key` can't move; clears the mark. */
export function takeRefusalShown(key: ItemKey): boolean {
  return shown.delete(canonicalItemKey(key));
}
