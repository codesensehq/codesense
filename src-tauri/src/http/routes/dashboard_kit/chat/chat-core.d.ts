// SPDX-License-Identifier: MIT
// Types for chat-core.js, the DOM-free chat rules the kit's chat and the app's typed module share.
export interface ChatLeadRow {
  state?: string;
  unread?: number;
  mailNotice?: string | null;
  notifiedAt?: string | null;
  [key: string]: unknown;
}
export interface ChatCard {
  question: string;
  options: string[];
  pick: string | null;
  reason: string | null;
}
/** The agent's trailing `Next:` line: the message text above it and the suggested prompts. */
export interface ChatNext {
  text: string;
  chips: string[];
}
export interface ChatThreadRow {
  messageId?: string | number;
  from?: string;
  inReplyTo?: string | number | null;
  text?: string;
  createdAtMs?: number;
  [key: string]: unknown;
}
/** Only an idle lead takes a message at once; anything else holds it. */
export function isBusy(lead: ChatLeadRow | null | undefined): boolean;
/** Queued or Delivered for one sent message. */
export function deliveryMark(input: {
  sentAt: number;
  busyAtSend: boolean;
  lead: ChatLeadRow | null | undefined;
  newestLeadAt?: number;
}): "queued" | "delivered";
/** A mark rule that latches Delivered per message key: a later change in the lead never un-delivers it. */
export function createMarkLatch(): (
  key: string | number,
  input: {
    sentAt: number;
    busyAtSend: boolean;
    lead: ChatLeadRow | null | undefined;
    newestLeadAt?: number;
  },
) => "queued" | "delivered";
/** A needs-you message read as buttons, or null when it is not in the card format. */
export function parseCard(text: unknown): ChatCard | null;
/** The trailing `Next:` line of a message as chips (one to four), or null when it does not end with one. */
export function parseNext(text: unknown): ChatNext | null;
/** The person's own row replying to the card, from whichever place sent it. */
export function cardAnswer(
  cardId: string | number,
  thread: readonly ChatThreadRow[] | null | undefined,
): { text: string; at: number } | null;
