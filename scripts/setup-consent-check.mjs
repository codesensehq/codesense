#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The consent check for the setup agent (ONB-6). The engine never runs a setup step, so
// "act only after the person's click" is the agent's own rule; this reads a recorded
// session (`session_read` with its conversation turns) and fails if a setup verb ran
// without one. A `clone_repo` with `stop: true` needs a live click but spends no use.
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
// `none`, a `read` card or an answer that is no label allows nothing. With step files
// (`stepActVerbs`), a card that names a step or act they lack, or another consent class than
// the act's, allows nothing either. A click's verbs run in the order its act lists them (its
// own, then its `then` acts'), so a write may not come before the switch that comes first. A
// `set_active_team` must name a team the latest `describe_setup` lists (a non-archived one
// outside the docs' org). The latest switch, or a `create_team` that activates, holds across
// clicks until another; with none, a file may lie in any listed team. Every file written must
// lie in `<orgRoot>/<team>/content/`, compared by path component, with no `..`. A command's
// `repo` must be one the team tracks, and a write whose `content` the step file fixes must carry
// exactly it. A `read_terminal_tab` must name, by `handle`, a tab an `open_terminal_tab` or
// `clone_repo` result returned. Without step files, an act named after a verb (`create-team`)
// allows that verb and a `run` act (`run`, `run-…`) allows `run_in_terminal_tab`. No setup
// call may name the docs' own org, `codesense/docs`, clicked or not. Ledger writes
// (`records_create`) and reads are not setup verbs: they record or look at what a click
// already allowed.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCardLine } from "./lib/card-line.mjs";
import { SETUP_VERBS, actAllowances, commandInputs } from "./lib/pack-steps.mjs";

export { SETUP_VERBS };

const DOCS_ORG = "codesense/docs";

// The file-writing verbs, and the argument that names the file.
const FILE_ARGS = { create_content_file: "path", set_epic_repos: "epicFilePath" };

/** The first verb a click allows before `name` that has not been used up yet. */
function earlierUnspent(allowed, name) {
  for (const [other, entry] of allowed) {
    if (other === name) return undefined;
    if (entry.used < entry.uses) return other;
  }
  return undefined;
}

/**
 * The teams a `describe_setup` result lists that the guide may work in (non-archived, outside
 * the docs' org, each `{org, orgRoot, team, repos}`) and every such org's folder; `undefined`
 * when the result lists no org.
 */
function listedSetup(result) {
  let orgs;
  const walk = (value) => {
    if (orgs || !value || typeof value !== "object") return;
    if (Array.isArray(value.orgs)) orgs = value.orgs;
    else Object.values(value).forEach(walk);
  };
  walk(json(result));
  // A result with no orgs (an error, a cut-off export, nobody set up) says nothing.
  if (!orgs?.length) return undefined;
  const teams = [];
  const roots = new Map(); // each non-docs org's folder, even when it has no team yet
  for (const org of orgs) {
    if (org.slug === DOCS_ORG) continue;
    roots.set(org.slug, org.orgRoot);
    for (const team of org.teams ?? [])
      if (team.archived === false)
        teams.push({
          org: org.slug,
          orgRoot: org.orgRoot,
          team: team.name,
          repos: (team.sourceRepos ?? []).map((r) => r.slug),
        });
  }
  return { teams, roots };
}

const nameOf = (t) => `${t.org}/${t.team}`;

/** Whether `file` lies in `<orgRoot>/<team>/content/`, by path component and with no `..`. */
function inTeamContent(file, { orgRoot, team }) {
  const parts = file.split("/").filter(Boolean);
  if (parts.includes("..")) return false;
  const root = typeof orgRoot === "string" ? orgRoot.split("/").filter(Boolean) : [];
  const folder = [...root, team, "content"];
  return parts.length > folder.length && folder.every((part, i) => parts[i] === part);
}

/** Every `handle` string a tool result carries. */
function handlesIn(result) {
  const found = [];
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object")
      for (const [key, inner] of Object.entries(value))
        if (key === "handle" && typeof inner === "string") found.push(inner);
        else walk(inner);
  };
  walk(json(result));
  return found;
}

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
 * `actVerbs` from a pack's step files: `(act, step, consent)` gives the verbs the click
 * allows, each `{verb, uses, cmd?}`, where `cmd` is the one command a `run` act may type. A
 * card the files don't back allows nothing: for a step or act they lack, or a class that is
 * not the act's own `consent`, it gives the reason as a string. Only a pack with no step
 * files falls back to `defaultActVerbs`.
 */
export function stepActVerbs(packDir) {
  const { steps, allowances } = actAllowances(packDir);
  if (steps.size === 0) return defaultActVerbs;
  return (act, step, consent) => {
    if (!steps.has(step)) return `the step files have no step ${step}`;
    const found = allowances.get(`${step}/${act}`);
    if (!found) return `step ${step} has no act ${act}`;
    if (consent !== undefined && consent !== found.consent)
      return `act ${act} in step ${step} is ${found.consent}, but the card says ${consent}`;
    return found.verbs;
  };
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
  let listed = []; // the teams the latest good describe_setup lists
  let roots = new Map(); // the orgs it lists, with their folders
  let switched; // {org, team, seen}: the latest set_active_team (or activating create_team)
  const seenHandles = new Set(); // the tabs an open_terminal_tab or clone_repo result returned
  let cards = 0;
  let calls = 0;
  let clicks = 0;

  for (const [at, turn] of turns.entries()) {
    const index = turn.index ?? at;
    for (const raw of turn.tool_calls ?? turn.toolCalls ?? []) {
      const { name, input } = callOf(raw);
      if (name === "open_terminal_tab" || name === "clone_repo")
        for (const handle of handlesIn(raw.result)) seenHandles.add(handle);
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
            const verbs = actVerbs(chosen.act, card.line.step, card.line.consent);
            if (typeof verbs === "string") {
              why = `the click on ${card.label} sent at turn ${card.turn} allows nothing: ${verbs}`;
              errors.push(`turn ${index}: ${why}`);
              continue;
            }
            for (const entry of verbs) {
              const {
                verb,
                uses = 1,
                cmd,
                inputs,
                content,
              } = typeof entry === "string" ? { verb: entry } : entry;
              const had = allowed.get(verb);
              allowed.set(verb, {
                uses: (had?.uses ?? 0) + uses,
                used: 0,
                cmd: had ? undefined : cmd,
                inputs: had ? undefined : inputs,
                content: had ? undefined : content,
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
      } else if (name === "describe_setup") {
        const setup = listedSetup(raw.result);
        if (setup) ({ teams: listed, roots } = setup);
      } else if (name === "read_terminal_tab") {
        if (typeof input.handle !== "string" || input.handle === "")
          errors.push(
            input.tab !== undefined
              ? `turn ${index}: read_terminal_tab names the tab ${input.tab}, not a handle, so it could read any tab`
              : `turn ${index}: read_terminal_tab names no handle`,
          );
        else if (!seenHandles.has(input.handle))
          errors.push(
            `turn ${index}: read_terminal_tab names handle ${input.handle}, which no open_terminal_tab in this session returned`,
          );
      } else if (setupVerbs.includes(name)) {
        calls += 1;
        const entry = allowed.get(name);
        if (
          String(input.org ?? "")
            .trim()
            .toLowerCase() === DOCS_ORG
        ) {
          // The docs are the guide's own context; no click makes them the place a setup writes.
          errors.push(`turn ${index}: ${name} names org ${DOCS_ORG}, which setup never writes to`);
        } else if (!entry) {
          errors.push(`turn ${index}: ${name} was called with no consent click for it: ${why}`);
        } else if (name === "run_in_terminal_tab" && input.key && !input.command) {
          // A bare key is no command. Ctrl-C stops the run the click started; it spends nothing.
          if (input.key !== "ctrl-c")
            errors.push(
              `turn ${index}: run_in_terminal_tab sent the key ${input.key}, which no click allows`,
            );
        } else if (name === "clone_repo" && input.stop === true) {
          // Stop ends the clone the click started; like Ctrl-C it spends nothing.
        } else if (earlierUnspent(allowed, name)) {
          errors.push(
            `turn ${index}: ${name} was called before ${earlierUnspent(allowed, name)}, which ${entry.click} allows first`,
          );
        } else if (entry.used >= entry.uses) {
          const nth = entry.used + 1 === 2 ? "second" : `${entry.used + 1}th`;
          const times = entry.uses === 1 ? "once" : `${entry.uses} times`;
          errors.push(
            `turn ${index}: ${name} was called a ${nth} time, but ${entry.click} allows act ${entry.act} (${entry.names}) ${times}`,
          );
        } else {
          entry.used += 1;
          if (name === "set_active_team") {
            const org = String(input.org ?? "").trim();
            const team = String(input.team ?? "").trim();
            const found = listed.find((t) => t.org === org && t.team === team);
            if (found) switched = { org, team, seen: found };
            else
              errors.push(
                `turn ${index}: set_active_team switched to ${org}/${team}, but describe_setup listed ${listed.length ? `only ${listed.map(nameOf).join(", ")}` : "no team"}`,
              );
          } else if (name === "create_team" && input.activate === true) {
            const org = String(input.org ?? "").trim();
            const team = String(input.name ?? "").trim();
            switched = { org, team, seen: { org, team, repos: [] } };
          }
          // The switch is the team's name; its folder and repos are the latest listing's.
          const inForce = switched && {
            ...switched.seen,
            ...listed.find((t) => t.org === switched.org && t.team === switched.team),
          };
          if (inForce && inForce.orgRoot === undefined) inForce.orgRoot = roots.get(inForce.org);
          const teams = inForce ? [inForce] : listed;
          const file = input[FILE_ARGS[name]];
          if (typeof file === "string" && !teams.length)
            errors.push(
              `turn ${index}: ${name} wrote ${file}, but no describe_setup listed a team to write in`,
            );
          else if (typeof file === "string" && !teams.some((t) => inTeamContent(file, t)))
            errors.push(
              `turn ${index}: ${name} wrote ${file}, outside the content folder of ${teams.map(nameOf).join(" or ")}`,
            );
          if (entry.content !== undefined && input.content !== entry.content)
            errors.push(
              `turn ${index}: ${name} wrote content that is not the exact content of act ${entry.act} in step ${entry.step}`,
            );
          if (entry.cmd !== undefined) {
            const typed = commandInputs(entry.cmd, input.command, entry.inputs);
            if (!typed)
              errors.push(
                `turn ${index}: run_in_terminal_tab ran a command that is not the exact run.cmd of act ${entry.act} in step ${entry.step}`,
              );
            else if (typed.repo !== undefined && !teams.some((t) => t.repos.includes(typed.repo)))
              errors.push(
                `turn ${index}: run_in_terminal_tab typed the repo ${typed.repo}, which describe_setup did not list for the team`,
              );
          }
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
  const actVerbs = stepActVerbs(resolve(packDir));
  if (actVerbs === defaultActVerbs) {
    console.error(`setup-consent-check: ${packDir} has no setup/steps/index.yml to check against`);
    process.exit(2);
  }
  const { errors, cards, calls, clicks } = checkConsent(exported, { actVerbs });
  for (const e of errors) console.error(`setup-consent-check: ${e}`);
  if (errors.length) process.exit(1);
  console.log(`setup-consent-check: ok (${calls} setup calls, ${cards} cards, ${clicks} clicks)`);
}
