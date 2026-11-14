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
//   * a card: a `send_message` to `human` with `kind: needs-you` whose text ends in a card
//     line (`parseCardLine` in the dashboard kit's `chat/chat-core.js`, the one parser). A needs-you message without one is a question, not
//     a card. Its message id comes from the call's result.
//   * its click: the person's first answer to it, read from a `read_messages` result (the
//     page's `replyAsHuman` lands there). When the thread carries `inReplyTo`, the answer is
//     the first human message replying to the card's id; when it never does (the spike's
//     fallback), the first human message with an id above the card's. A card without a
//     message id can't be answered. The answer is a click only when its text is one of the
//     card's labels.
//   * a setup verb: any call to a tool in `SETUP_VERBS`.
// A click allows the clicked act's verbs only, up to the next card. A new card closes it, and
// `none`, a `read` card or an answer that is no label allows nothing. Until step files map
// acts to verbs (`actVerbs`), an act named after a verb (`create-team`) allows that verb and
// a `run` act (`run`, `run-…`) allows `run_in_terminal_tab`. Ledger writes
// (`records_create`) and reads are not setup verbs: they record or look at what a click
// already allowed.
// `send_role_message` is bound too: it is allowed only as the Foreman hand-back (`HANDBACK`),
// once, after the last setup act and before `signal_done`. Nothing that acts (a setup verb, a
// ledger write, `open_workspace`) may follow the hand-back or `signal_done`; reads may.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCardLine } from "../src-tauri/src/http/routes/dashboard_kit/chat/chat-core.js";
import { SETUP_VERBS } from "./lib/pack-steps.mjs";

export { SETUP_VERBS };

// The one `send_role_message` the guide may send (the pack skill's `foreman-handback` block).
export const HANDBACK = Object.freeze({
  role: "codesense-foreman",
  org: "codesense/docs",
  team: "getting-started",
  prefix: "Setup done:",
});

// What may not follow the hand-back or `signal_done`: the setup verbs and these other writes.
const WRITES_AFTER_HANDBACK = [
  "records_create",
  "records_set_fields",
  "records_write",
  "records_delete",
  "open_workspace",
];

// The server's `role_name` strips one leading `role:` and trims, so both spellings name one queue.
const roleName = (role) =>
  typeof role === "string"
    ? role
        .trim()
        .replace(/^role:/, "")
        .trim()
    : role;

/** The reasons a `send_role_message` is not the Foreman hand-back. */
function handbackFaults(input) {
  const faults = [];
  if (roleName(input.role) !== HANDBACK.role)
    faults.push(`role is ${JSON.stringify(input.role)}, not ${HANDBACK.role}`);
  if (input.team?.org !== HANDBACK.org || input.team?.team !== HANDBACK.team)
    faults.push(`team is not ${HANDBACK.org} / ${HANDBACK.team}`);
  if (typeof input.text !== "string" || !input.text.startsWith(HANDBACK.prefix))
    faults.push(`text does not start with "${HANDBACK.prefix}"`);
  for (const field of ["replyTo", "reply_to", "attachFile", "attach_file"])
    if (input[field] !== undefined && input[field] !== null) faults.push(`${field} is set`);
  return faults;
}

// Claude names a tool `mcp__codesense__<tool>`, OpenCode `codesense_<tool>`, and the by-name
// wrapper is `codesense_call_tool` under either.
const bare = (name) => String(name ?? "").replace(/^(?:mcp__codesense__|codesense_)+/, "");

/** The setup verbs an act allows, when no step file says: its namesake verb, or a command. */
export function defaultActVerbs(act) {
  const verb = act.replaceAll("-", "_");
  if (SETUP_VERBS.includes(verb)) return [verb];
  if (act === "run" || act.startsWith("run-")) return ["run_in_terminal_tab"];
  return [];
}

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

export function checkConsent(
  exported,
  { setupVerbs = SETUP_VERBS, actVerbs = defaultActVerbs } = {},
) {
  const errors = [];
  const turns = turnsOf(exported);
  if (!Array.isArray(turns) || turns.length === 0)
    return { errors: ["the export has no turns to check"], cards: 0, calls: 0, clicks: 0 };

  const replyField = (m) => m.inReplyTo ?? m.in_reply_to ?? null;
  const idOf = (m) => m.messageId ?? m.message_id;
  const threaded = turns.some((turn) =>
    (turn.tool_calls ?? turn.toolCalls ?? []).some(
      (call) =>
        bare(call.name) === "read_messages" &&
        humanMessages(call.result).some((m) => replyField(m) !== null),
    ),
  );
  const seen = new Set();
  let card; // the latest card: { id, turn, name, line, answered }
  let allowed = []; // the verbs the latest click allows
  let why = "no card has been sent";
  let cards = 0;
  let calls = 0;
  let clicks = 0;
  let handback; // the turn of the hand-back, once sent
  let done = false; // signal_done has been called

  for (const [at, turn] of turns.entries()) {
    const index = turn.index ?? at;
    for (const raw of turn.tool_calls ?? turn.toolCalls ?? []) {
      const { name, input } = callOf(raw);
      const line =
        name === "send_message" && input.to === "human" && input.kind === "needs-you"
          ? parseCardLine(input.text ?? input.message)
          : null;
      if (line) {
        const sent = json(raw.result);
        const id = sent?.messageId ?? sent?.data?.messageId;
        const label = `"${line.step} · ${line.consent}"`;
        card = { id, turn: index, label, line, answered: false };
        cards += 1;
        allowed = [];
        why =
          id === undefined
            ? `the card ${label} sent at turn ${index} has no messageId, so no click can answer it`
            : `the card ${label} sent at turn ${index} has no click yet`;
      } else if (name === "read_messages") {
        for (const message of humanMessages(raw.result)) {
          // A message read again later is the same answer, not a new one.
          const id = idOf(message);
          if (id !== undefined && seen.has(id)) continue;
          if (id !== undefined) seen.add(id);
          if (!card || card.answered || card.id === undefined) continue;
          const answers = threaded
            ? String(replyField(message)) === String(card.id)
            : id !== undefined && Number(id) > Number(card.id);
          if (!answers) continue;
          card.answered = true;
          const chosen = card.line.acts.find((item) => item.label === message.text.trim());
          if (!chosen) {
            why = `the answer to the card ${card.label} sent at turn ${card.turn} is none of its labels`;
            continue;
          }
          clicks += 1;
          if (chosen.act === "none") {
            why = `the card ${card.label} sent at turn ${card.turn} was declined`;
          } else if (card.line.consent === "read") {
            why = `the card ${card.label} sent at turn ${card.turn} is a read card and allows no change`;
          } else {
            allowed = actVerbs(chosen.act);
            why = `the click on ${card.label} sent at turn ${card.turn} allows act ${chosen.act} (${allowed.join(", ") || "no setup verb"}) only`;
          }
        }
      } else if (name === "send_role_message") {
        const faults = handbackFaults(input);
        if (handback !== undefined)
          faults.push(`a second hand-back (the first was at turn ${handback})`);
        if (done) faults.push("sent after signal_done");
        if (faults.length)
          errors.push(
            `turn ${index}: send_role_message is not the Foreman hand-back: ${faults.join("; ")}`,
          );
        handback ??= index;
      } else if (name === "signal_done") {
        done = true;
      } else if (setupVerbs.includes(name) || WRITES_AFTER_HANDBACK.includes(name)) {
        const setup = setupVerbs.includes(name);
        if (setup) calls += 1;
        if (handback !== undefined)
          errors.push(`turn ${index}: ${name} came after the hand-back at turn ${handback}`);
        else if (done) errors.push(`turn ${index}: ${name} came after signal_done`);
        if (setup && !allowed.includes(name))
          errors.push(`turn ${index}: ${name} was called with no consent click for it: ${why}`);
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
