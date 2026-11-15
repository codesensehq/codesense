// SPDX-License-Identifier: MIT
// The person's pins of a chat's messages, without the DOM: a message's pin title, the quote
// its pin previews, the note at the cap and what the live region says. The words live in
// chat-core, so the overlay, the Inbox and the kit's chat say the same thing.

import {
  PIN_CAP,
  pinCapLabel,
  pinCapNote,
  pinFirstWords,
  pinLiveText,
  pinTitleOf as coreTitle,
  pinWho,
} from "./chat-core";

export { PIN_CAP };

type Said = { text: string; contentType?: string | null; summary?: string | null };

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * What a pin of this message is called (chat-core's rule, so the kit says the same). An HTML
 * message: its summary, then its `<title>`, then its first heading, then "Dashboard from
 * <sender>"; never its markup. Any other message: its summary, else its first sentence.
 */
export function pinTitleOf(m: Said, sender: string): string {
  return coreTitle(m, sender);
}

/** A plain message's pin preview: its title, then the rest of the message, quoted. */
export function quoteOf(m: Said, sender: string): { title: string; rest: string } {
  const title = pinTitleOf(m, sender);
  const all = squash(m.text);
  const rest = all.startsWith(title) ? all.slice(title.length).trim() : all;
  return { title, rest };
}

/** "you" for the person, else the agent's name. */
export const whoPinned = pinWho;
/** The dimmed Pin's accessible name and tooltip at the cap. */
export const capLabel = pinCapLabel;
/** The note at the cap: whose pins fill the list, the most first. Nothing is replaced. */
export const capNote = pinCapNote;
/** A message named by its first words, as the line chip and the live region show it. */
export const firstWords = pinFirstWords;
/** What the polite live region says after a pin, an unpin or an Undo. */
export const liveText = pinLiveText;

// ── At the cap: Pin… asks which pin to replace ─────────────────────────────────
// The overlay's words for the chooser. They move into chat-core with the kit's half of it, so
// the kit's chat says the same.

/** Pin…'s accessible name and tooltip at the cap. */
export const replaceLabel = (count: number) => `Pin, replacing one (${pinCapLabel(count)})`;
/** The chooser's heading, which names its group. */
export const chooserHeading = (count: number) =>
  `Replace a pin with this message · ${pinCapLabel(count)}`;
/** A row's line: who pinned it, and when (the pin, not the message). */
export const pinnedAtLine = (who: string, at: string) => `Pinned by ${who} at ${at}`;
/** "your" for the person, else the agent's name with 's. */
const whose = (who: string) => (who === "you" ? "your" : `${who}'s`);
/** The note and live line after a replace. */
export const replacedText = (who: string, title: string) =>
  `Replaced ${whose(who)} pin “${title}”.`;
/** A row the agent added while the chooser was open, before the person arrives on it. */
export const newRowText = (title: string) => `“${title}” is new. Choose it again to replace it.`;
/** What changed in the list while the chooser was open. */
export const listChangeText = (added: string[], left: string[]) =>
  [...added.map((t) => `“${t}” is new.`), ...left.map((t) => `“${t}” left the list.`)].join(" ");
/** A replace that failed. */
export const REPLACE_FAILED = "Couldn't replace. Nothing changed.";
/** The chooser when a pin left and there's room. */
export const ROOM_NOW = "There's room now.";
/** The agent pinned this message while the chooser was open. */
export const pinnedMeanwhileText = (who: string) =>
  `${who} pinned this message. Nothing was replaced.`;
/** An Undo of a replace that can't happen any more, and why. */
export const UNDO_FULL = "Can't undo: the list is full again.";
export const UNDO_GONE = "Can't undo: that message was archived or withdrawn.";
