// SPDX-License-Identifier: MIT

/** What the host's `session-text` event carries for one session (see `session_text.rs`). */
export type SessionTextEvent =
  | { kind: "prose"; turn: string; key: string; text: string }
  | { kind: "tool"; turn: string }
  | { kind: "end"; turn: string };

/** What a page hears (`codesense:session-text`): prose as it is written, then exactly one final
 *  message per turn. Never a tool call or the model's thinking. */
export type SessionTextMessage = {
  sessionId: string;
  kind: "prose" | "final";
  turn: string;
  key: string;
  text: string;
};

/** How many turns a session's router remembers (a late Stop of an older turn ends nothing). */
const TURNS_KEPT = 8;

/**
 * Routes a session's assistant-prose events to what pages hear. Prose passes on as it comes. A
 * tool call marks the prose before it as progress, so the turn's final message is the last prose
 * after its last tool call, sent once on the turn's first end: a second Stop sends nothing, and a
 * turn whose last act was a tool call has no final.
 */
export function createSessionTextRouter() {
  const turns = new Map<string, { last: { key: string; text: string } | null; ended: boolean }>();
  return (sessionId: string, event: SessionTextEvent): SessionTextMessage[] => {
    const id = JSON.stringify([sessionId, event.turn]);
    let turn = turns.get(id);
    if (!turn) {
      turn = { last: null, ended: false };
      turns.set(id, turn);
      if (turns.size > TURNS_KEPT * 4) turns.delete(turns.keys().next().value!);
    }
    if (event.kind === "tool") {
      turn.last = null;
      return [];
    }
    if (event.kind === "prose") {
      turn.last = { key: event.key, text: event.text };
      return [{ sessionId, kind: "prose", turn: event.turn, key: event.key, text: event.text }];
    }
    if (turn.ended) return [];
    turn.ended = true;
    return turn.last
      ? [{ sessionId, kind: "final", turn: event.turn, key: turn.last.key, text: turn.last.text }]
      : [];
  };
}
