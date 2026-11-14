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
//     line (`scripts/lib/card-line.mjs`). A needs-you message without one is a question, not
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
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCardLine } from "./lib/card-line.mjs";
import { SETUP_VERBS, actAllowances } from "./lib/pack-steps.mjs";

export { SETUP_VERBS };

const GUIDE_PACK = join(
  dirname(fileURLToPath(import.meta.url)),
  "../codesense-docs/packs/codesense-guide",
);

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

/**
 * `actVerbs` from a pack's step files: `(act, step)` gives the verbs the click allows, each
 * `{verb, uses, cmd?}`, where `cmd` is the one command a `run` act may type. An act or step
 * the files don't hold falls back to `defaultActVerbs`, whose commands go unchecked.
 */
export function stepActVerbs(packDir) {
  const allowances = actAllowances(packDir);
  return (act, step) => allowances.get(`${step}/${act}`) ?? defaultActVerbs(act);
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
  let allowed = new Map(); // the verbs the latest click allows: name to {uses, used, cmd, click}
  let why = "no card has been sent";
  let cards = 0;
  let calls = 0;
  let clicks = 0;

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
        allowed = new Map();
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
            allowed = new Map();
            for (const entry of actVerbs(chosen.act, card.line.step)) {
              const { verb, uses = 1, cmd } = typeof entry === "string" ? { verb: entry } : entry;
              const had = allowed.get(verb);
              allowed.set(verb, {
                uses: (had?.uses ?? 0) + uses,
                used: 0,
                cmd: had ? undefined : cmd,
                act: chosen.act,
                step: card.line.step,
                click: `the click on ${card.label} sent at turn ${card.turn}`,
              });
            }
            const names = [...allowed.keys()].join(", ") || "no setup verb";
            for (const entry of allowed.values()) entry.names = names;
            why = `the click on ${card.label} sent at turn ${card.turn} allows act ${chosen.act} (${names}) only`;
          }
        }
      } else if (setupVerbs.includes(name)) {
        calls += 1;
        const entry = allowed.get(name);
        if (!entry) {
          errors.push(`turn ${index}: ${name} was called with no consent click for it: ${why}`);
        } else if (name === "run_in_terminal_tab" && input.key && !input.command) {
          // A bare key is no command. Ctrl-C stops the run the click started; it spends nothing.
          if (input.key !== "ctrl-c")
            errors.push(
              `turn ${index}: run_in_terminal_tab sent the key ${input.key}, which no click allows`,
            );
        } else if (entry.used >= entry.uses) {
          const nth = entry.used + 1 === 2 ? "second" : `${entry.used + 1}th`;
          const times = entry.uses === 1 ? "once" : `${entry.uses} times`;
          errors.push(
            `turn ${index}: ${name} was called a ${nth} time, but ${entry.click} allows act ${entry.act} (${entry.names}) ${times}`,
          );
        } else {
          entry.used += 1;
          if (entry.cmd !== undefined && input.command !== entry.cmd)
            errors.push(
              `turn ${index}: run_in_terminal_tab ran a command that is not the exact run.cmd of act ${entry.act} in step ${entry.step}`,
            );
        }
      }
    }
  }
  return { errors, cards, calls, clicks };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--pack");
  const packDir = flag < 0 ? GUIDE_PACK : args[flag + 1];
  if (flag >= 0) args.splice(flag, 2);
  const [path, ...rest] = args;
  if (!path || rest.length || !packDir) {
    console.error(
      "usage: node scripts/setup-consent-check.mjs <session-export.json> [--pack <pack folder>]",
    );
    process.exit(2);
  }
  let exported;
  try {
    exported = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`setup-consent-check: cannot read ${path}: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
  const { errors, cards, calls, clicks } = checkConsent(exported, {
    actVerbs: stepActVerbs(resolve(packDir)),
  });
  for (const e of errors) console.error(`setup-consent-check: ${e}`);
  if (errors.length) process.exit(1);
  console.log(`setup-consent-check: ok (${calls} setup calls, ${cards} cards, ${clicks} clicks)`);
}
