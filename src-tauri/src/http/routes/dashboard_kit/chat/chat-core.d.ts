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
/** The message's own row on the `messageDelivery` topic, when the host pushes it. */
export interface ChatDelivery {
  state: "queued" | "delivered";
  deliveredAtMs?: number | null;
}
export function deliveryMark(input: {
  sentAt: number;
  busyAtSend: boolean;
  lead: ChatLeadRow | null | undefined;
  newestLeadAt?: number;
  delivery?: ChatDelivery | null;
}): "queued" | "delivered";
/** A mark rule that latches Delivered per message key: a later change in the lead never un-delivers it. */
export function createMarkLatch(): (
  key: string | number,
  input: {
    sentAt: number;
    busyAtSend: boolean;
    lead: ChatLeadRow | null | undefined;
    newestLeadAt?: number;
    delivery?: ChatDelivery | null;
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
/** A thread shows at most this many pins, the person's and its agent's together. */
export const PIN_CAP: number;
/** The first sentence of a message's first non-empty line. */
export function pinFirstSentence(text: string): string;
/** "you" for the person, else the agent's name. */
export function pinWho(pinnedBy: string, nameOf: (pinnedBy: string) => string): string;
/** The dimmed Pin's accessible name at the cap: "3 of 3 pinned". */
export function pinCapLabel(count: number): string;
/** The note at the cap: whose pins fill the list, the most first. */
export function pinCapNote(
  pins: ReadonlyArray<{ pinnedBy: string }>,
  nameOf: (pinnedBy: string) => string,
): string;
/** A message named by its first words. */
export function pinFirstWords(text: string, words?: number): string;
/** What the polite live region says after a pin, an unpin or an Undo. */
export function pinLiveText(
  done: "pinned" | "unpinned" | "restored",
  title: string,
  count: number,
): string;
/** Pin…'s accessible name and tooltip at the cap: "Pin, replacing one (3 of 3 pinned)". */
export function pinReplaceLabel(count: number): string;
/** The replace chooser's heading, which names its group. */
export function pinChooserHeading(count: number): string;
/** A chooser row's line: who pinned it, and when. */
export function pinPinnedAtLine(who: string, at: string): string;
/** The note and live line after a replace. */
export function pinReplacedText(who: string, title: string): string;
/** A row the agent added while the chooser was open, before the person arrives on it. */
export function pinNewRowText(title: string): string;
/** What changed in the list while the chooser was open. */
export function pinListChangeText(added: readonly string[], left: readonly string[]): string;
/** The agent pinned this message while the chooser was open. */
export function pinPinnedMeanwhileText(who: string): string;
/** A replace that failed. */
export const PIN_REPLACE_FAILED: string;
/** The chooser when a pin left and there's room. */
export const PIN_ROOM_NOW: string;
/** The replace chooser's state: the pins it opened on plus the rows arrived on since, the list as last drawn, the current row, what changed, a failed replace. */
export interface PinChooserState<P extends { messageId: number } = { messageId: number }> {
  known: ReadonlySet<number>;
  last: readonly P[];
  current: number | null;
  change: string | null;
  error: string | null;
}
/** A chooser opened on `pins`: the first row current. */
export function pinChooserOpen<P extends { messageId: number }>(pins: readonly P[]): PinChooserState<P>;
/** The row a key moves the current row to, or null for any other key. */
export function pinChooserStep(key: string, at: number, count: number, fromChange: boolean): number | null;
/** The person arrived on a row: current and known, and a failed replace's line goes. */
export function pinChooserArrive<S extends PinChooserState<{ messageId: number }>>(state: S, id: number): S;
/** Choose a row: replace it if arrived on, else arrive on it first and say it is new. */
export function pinChooserChoose<S extends PinChooserState<{ messageId: number }>, P extends { messageId: number }>(
  state: S,
  pin: P,
  titleOf: (pin: P) => string,
): { state: S; replace: boolean };
/** Follow the live list: null when nothing changed, {pinned} when the agent pinned this message, else the next state. */
export function pinChooserSync<S extends PinChooserState<P>, P extends { messageId: number }>(
  state: S,
  pins: readonly P[],
  messageId: number,
  titleOf: (pin: P) => string,
): { pinned: P } | { state: S } | null;
/** The chooser's room line below the cap, else null. */
export function pinChooserRoom(count: number): string | null;
/** An Undo of a replace refused because the list is full again. */
export const PIN_UNDO_FULL: string;
/** An Undo of a replace refused because the old pin's message is gone. */
export const PIN_UNDO_GONE: string;
/** What a pin of this message is called: an HTML message by its summary, `<title>`, first heading, else "Dashboard from <sender>"; any other by its summary, else its first sentence. */
export function pinTitleOf(
  m: { text?: string | null; contentType?: string | null; summary?: string | null },
  sender: string,
): string;