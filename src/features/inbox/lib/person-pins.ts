// SPDX-License-Identifier: MIT
// The person's pins of a chat's messages, without the DOM: a message's pin title, the quote
// its pin previews, the note at the cap and what the live region says. The overlay, the
// Inbox and the kit's chat say the same words.

import { HUMAN } from "../model";

/** A thread shows at most this many pins, the person's and its agent's together. */
export const PIN_CAP = 3;

type Said = { text: string; contentType?: string | null; summary?: string | null };

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** Tags dropped and entities read, as a heading or title shows: text only. */
function plainOf(markup: string): string {
  const doc = new DOMParser().parseFromString(`<body>${markup}</body>`, "text/html");
  return squash(doc.body.textContent ?? "");
}

function htmlTitle(markup: string): string | null {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(markup);
  if (title && plainOf(title[1]!)) return plainOf(title[1]!);
  for (const heading of markup.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = plainOf(heading[2]!);
    if (text) return text;
  }
  return null;
}

/** The first sentence of the first non-empty line: up to its first `.`, `!` or `?`. */
function firstSentence(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  const end = /^.*?[.!?](?=\s|$)/.exec(line.trim());
  return squash(end ? end[0] : line);
}

/**
 * What a pin of this message is called. An HTML message: its summary, then its `<title>`,
 * then its first heading, then "Dashboard from <sender>"; never its markup. Any other
 * message: its summary, else its first sentence.
 */
export function pinTitleOf(m: Said, sender: string): string {
  const summary = m.summary?.trim();
  if (summary) return summary;
  if (m.contentType === "html") return htmlTitle(m.text) ?? `Dashboard from ${sender}`;
  return firstSentence(m.text) || `Message from ${sender}`;
}

/** A plain message's pin preview: its title, then the rest of the message, quoted. */
export function quoteOf(m: Said, sender: string): { title: string; rest: string } {
  const title = pinTitleOf(m, sender);
  const all = squash(m.text);
  const rest = all.startsWith(title) ? all.slice(title.length).trim() : all;
  return { title, rest };
}

/** "you" for the person, else the agent's name. */
export function whoPinned(pinnedBy: string, labelOf: (from: string) => string): string {
  return pinnedBy === HUMAN ? "you" : labelOf(pinnedBy);
}

/** The dimmed Pin's accessible name and tooltip at the cap. */
export const capLabel = (count: number) => `${count} of ${PIN_CAP} pinned`;

/** The note at the cap: whose pins fill the list, the most first. Nothing is replaced. */
export function capNote(
  pins: ReadonlyArray<{ pinnedBy: string }>,
  labelOf: (from: string) => string,
): string {
  const counts = new Map<string, number>();
  for (const p of pins) {
    const who = whoPinned(p.pinnedBy, labelOf);
    counts.set(who, (counts.get(who) ?? 0) + 1);
  }
  const parts = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([who, n]) => `${n} by ${who}`)
    .join(", ");
  return `${capLabel(pins.length)} (${parts}). Unpin one to pin this.`;
}

/** A message named by its first words, as the line chip and the live region show it. */
export function firstWords(text: string, words = 4): string {
  const all = squash(text).split(" ");
  return all.length <= words ? all.join(" ") : `${all.slice(0, words).join(" ")}…`;
}

/** What the polite live region says after a pin, an unpin or an Undo. */
export function liveText(
  done: "pinned" | "unpinned" | "restored",
  title: string,
  count: number,
): string {
  const verb = done === "pinned" ? "Pinned" : done === "unpinned" ? "Unpinned" : "Restored";
  return `${verb} "${firstWords(title)}". ${capLabel(count)}.`;
}
