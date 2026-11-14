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
/** One of the four consent classes a card line names. */
export type ChatConsent = "read" | "local-write" | "install-or-sign-in" | "external-write";
export interface ChatCardAct {
  /** The act's id; `none` is the decline. */
  act: string;
  /** The button's label, and the text a click sends. */
  label: string;
}
/** A card line: the message above it, the step, the consent class and the acts (one button each). */
export interface ChatCardLine {
  text: string;
  step: string;
  consent: ChatConsent;
  acts: ChatCardAct[];
}
/** The four consent classes, in the contract's order. */
export const CONSENT_CLASSES: readonly ChatConsent[];
/** `card: <step> · <class> · <act>=<label> | <act>=<label>`, the line that ends a card's text. Throws when it would not parse back. */
export function formatCardLine(line: {
  step: string;
  consent: ChatConsent;
  acts: readonly ChatCardAct[];
}): string;
/** The card line that ends a message, with the text above it, or null when the last line is not one. */
export function parseCardLine(text: unknown): ChatCardLine | null;
/** The person's own row replying to the card, from whichever place sent it. */
export function cardAnswer(
  cardId: string | number,
  thread: readonly ChatThreadRow[] | null | undefined,
): { text: string; at: number } | null;
