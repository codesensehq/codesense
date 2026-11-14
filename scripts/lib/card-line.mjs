// SPDX-License-Identifier: MIT
// The consent card line, the last line of a setup card's text (spike probe 4: `send_message`
// has no card fields, so a card's step, consent class and acts travel in its text):
//
//   card: <step> · <class> · <act>=<label> | <act>=<label> …
//
// The separator is ` · ` (U+00B7 with spaces). <class> is one of CONSENT_CLASSES; the act
// `none` is the decline. Each label is one button, and a click is a message whose text equals
// one label. The line starts at column 0 with `card: `, lower case. This is the twin of `parseCardLine` and `formatCardLine` in the dashboard kit's
// `chat/chat-core.js`, with the same grammar and limits; change both together.

export const CONSENT_CLASSES = Object.freeze([
  "read",
  "local-write",
  "install-or-sign-in",
  "external-write",
]);

const CARD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ID = 64;
const MAX_OPTIONS = 6;
const MAX_OPTION = 80;
const SEP = " · ";

const idOk = (id) => typeof id === "string" && id.length <= MAX_ID && CARD_ID.test(id);
const labelOk = (label) =>
  typeof label === "string" &&
  label.length > 0 &&
  label.length <= MAX_OPTION &&
  label === label.trim() &&
  !/[<>|\r\n]/.test(label);
const actsOk = (acts) =>
  Array.isArray(acts) &&
  acts.length >= 1 &&
  acts.length <= MAX_OPTIONS &&
  acts.every((item) => item && idOk(item.act) && labelOk(item.label)) &&
  new Set(acts.map((item) => item.label.toLowerCase())).size === acts.length;

/** The line for a card; a TypeError when it would not parse back. */
export function formatCardLine({ step, consent, acts }) {
  if (!idOk(step) || !CONSENT_CLASSES.includes(consent) || !actsOk(acts))
    throw new TypeError("not a card line");
  return `card: ${step}${SEP}${consent}${SEP}${acts.map((item) => `${item.act}=${item.label}`).join(" | ")}`;
}

/**
 * The card line that ends `text`: `{text (the message above it), step, consent,
 * acts: [{act, label}]}`, or null when the last non-blank line is not one.
 */
export function parseCardLine(text) {
  if (typeof text !== "string") return null;
  const lines = text.split(/\r?\n/);
  let at = lines.length - 1;
  while (at >= 0 && !lines[at].trim()) at--;
  // Exactly `card: ` at the start of the line: no indent, lower case.
  if (at < 0 || !lines[at].startsWith("card: ")) return null;
  const rest = lines[at].slice("card: ".length).trimEnd();
  const first = rest.indexOf(SEP);
  const second = first < 0 ? -1 : rest.indexOf(SEP, first + SEP.length);
  if (second < 0) return null;
  const step = rest.slice(0, first);
  const consent = rest.slice(first + SEP.length, second);
  const acts = rest
    .slice(second + SEP.length)
    .split(" | ")
    .map((part) => {
      const eq = part.indexOf("=");
      return eq < 0 ? null : { act: part.slice(0, eq), label: part.slice(eq + 1) };
    });
  if (!idOk(step) || !CONSENT_CLASSES.includes(consent) || acts.includes(null) || !actsOk(acts))
    return null;
  return { text: lines.slice(0, at).join("\n").trimEnd(), step, consent, acts };
}
