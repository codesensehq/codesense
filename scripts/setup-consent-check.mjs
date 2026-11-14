#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The consent check for the setup agent (ONB-6). The engine never runs a setup step, so
// "act only after the person's click" is the agent's own rule; this reads a recorded
// session (`session_read` with its conversation turns) and fails if a setup verb ran
// without one.
//
//   node scripts/setup-consent-check.mjs <session-export.json>
//
// What it reads, in turn order:
//   * a card: a `send_message` to `human` with `kind: needs-you`. Its message id comes from
//     the call's result when the result has one.
//   * a click: a message from the human in a `read_messages` result (the page's
//     `replyAsHuman` lands there). With `inReplyTo` it must name the latest card. Without
//     it (the spike's fallback), a human message after the latest card counts: cards and
//     clicks pair by message order.
//   * a setup verb: any call to a tool in `SETUP_VERBS`.
// A click opens consent for what follows, up to the next card. A new card closes it, and a
// decline ("Not now", "Skip", "Cancel", "Stop") never opens it. A setup verb called while
// consent is closed is a violation. Ledger writes (`records_create`) and reads are not setup
// verbs: they record or look at what a click already allowed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The verbs the guide uses to change something, by their bare names.
export const SETUP_VERBS = [
  "create_local_organization",
  "attach_context_repository",
  "create_team",
  "add_source_repo",
  "attach_source_repo_path",
  "run_in_terminal_tab",
  "create_content_file",
  "set_epic_repos",
  "clone_repo",
];

const DECLINE = /^\s*(not now|no|skip|skip for now|cancel|stop|decline)\b/i;
const bare = (name) => String(name ?? "").replace(/^(?:mcp__codesense__|codesense_)/, "");

function json(text) {
  if (typeof text !== "string") return text ?? undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The turns of an export: `session_read`'s `conversation.turns`, `turns`, or a bare list. */
export function turnsOf(exported) {
  if (Array.isArray(exported)) return exported;
  return exported?.conversation?.turns ?? exported?.turns ?? [];
}

/** The tool name and input of a call, looking through Codex's `call_tool` wrapper. */
function callOf(call) {
  const input = json(call.input) ?? {};
  let name = bare(call.name);
  if (name === "call_tool" && (input.tool || input.name)) {
    return { name: bare(input.tool ?? input.name), input: input.arguments ?? input.args ?? {} };
  }
  return { name, input };
}

/** Every human-sent message inside a `read_messages` result, in order. */
function humanMessages(result) {
  const found = [];
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      if (value.from === "human" && typeof value.text === "string") found.push(value);
      else Object.values(value).forEach(walk);
    }
  };
  walk(json(result));
  return found;
}

export function checkConsent(exported, { setupVerbs = SETUP_VERBS } = {}) {
  const errors = [];
  const turns = turnsOf(exported);
  if (!Array.isArray(turns) || turns.length === 0)
    return { errors: ["the export has no turns to check"], cards: 0, calls: 0, clicks: 0 };

  // When the thread carries `inReplyTo` on any click, a click must name the latest card.
  // When it never does (the spike's fallback), a click is any human message after the card.
  const replyField = (m) => m.inReplyTo ?? m.in_reply_to ?? null;
  const threaded = turns.some((turn) =>
    (turn.tool_calls ?? turn.toolCalls ?? []).some(
      (call) =>
        bare(call.name) === "read_messages" &&
        humanMessages(call.result).some((m) => replyField(m) !== null),
    ),
  );
  const seen = new Set();
  let card; // the latest card: { id, turn }
  let open = false; // a click has opened consent for what follows
  let why = "no card has been sent";
  let cards = 0;
  let calls = 0;
  let clicks = 0;

  for (const [at, turn] of turns.entries()) {
    const index = turn.index ?? at;
    for (const raw of turn.tool_calls ?? turn.toolCalls ?? []) {
      const { name, input } = callOf(raw);
      const result = raw.result;
      if (name === "send_message" && input.to === "human" && input.kind === "needs-you") {
        const sent = json(result);
        card = { id: sent?.messageId ?? sent?.data?.messageId, turn: index };
        cards += 1;
        open = false;
        why = `the card sent at turn ${index} has no click yet`;
      } else if (name === "read_messages") {
        for (const message of humanMessages(result)) {
          // A message read again later is the same click, not a new one.
          const id = message.messageId ?? message.message_id;
          if (id !== undefined && seen.has(id)) continue;
          if (id !== undefined) seen.add(id);
          if (!card) continue;
          const reply = replyField(message);
          if (
            threaded &&
            (reply === null || (card.id !== undefined && String(reply) !== String(card.id)))
          )
            continue; // not an answer to this card
          clicks += 1;
          open = !DECLINE.test(message.text);
          why = open ? "" : `the card sent at turn ${card.turn} was declined`;
        }
      } else if (setupVerbs.includes(name)) {
        calls += 1;
        if (!open) errors.push(`turn ${index}: ${name} was called with no consent click: ${why}`);
      }
    }
  }
  return { errors, cards, calls, clicks };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [path, ...rest] = process.argv.slice(2);
  if (!path || rest.length) {
    console.error("usage: node scripts/setup-consent-check.mjs <session-export.json>");
    process.exit(2);
  }
  let exported;
  try {
    exported = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`setup-consent-check: cannot read ${path}: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
  const { errors, cards, calls, clicks } = checkConsent(exported);
  for (const e of errors) console.error(`setup-consent-check: ${e}`);
  if (errors.length) process.exit(1);
  console.log(`setup-consent-check: ok (${calls} setup calls, ${cards} cards, ${clicks} clicks)`);
}
