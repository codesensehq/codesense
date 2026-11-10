// SPDX-License-Identifier: MIT
import type { AgentSessionRow } from "@/tauri/commands";

import { HAND_STARTED_KIND } from "./hand-agents";

/**
 * What a session says about how CodeSense reaches it, from facts every CLI's session carries:
 * the roster kind, whether an inbox waiter is armed, and the release its launch recorded. No
 * rule here names a CLI.
 */

/** The words a session typed by hand wears on its row and tab. */
export const TYPED_BY_HAND = "Typed by hand";
/** What a session whose CLI release is outside the qualified range says. */
export const RELEASE_NOT_SUPPORTED = "Release not supported";
/** The tab's mail-off glyph: its name and its tooltip. */
export const TYPED_BY_HAND_TAB = `${TYPED_BY_HAND} · Mail waits; CodeSense can't wake it`;
/** A tab a person typed a CLI into, which CodeSense can't wake: mail waits for it unannounced.
 *  One whose CLI armed a waiter says nothing extra. */
export function isTypedByHand(row: Pick<AgentSessionRow, "kind" | "inboxWaiter">): boolean {
  return row.kind === HAND_STARTED_KIND && row.inboxWaiter === false;
}
