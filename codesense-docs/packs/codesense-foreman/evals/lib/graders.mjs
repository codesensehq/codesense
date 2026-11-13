// SPDX-License-Identifier: MIT
// Script graders: they read tool calls, sessions and the fixture's logs, never the wording of a
// reply beyond the few facts a case names (a story id, an option, "page", a failure). Those
// checks ignore case and typographic quotes, and accept the common phrasings.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const casesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cases");

export function loadCases() {
  return readdirSync(casesDir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => parse(readFileSync(path.join(casesDir, f), "utf8")));
}

const FOREMAN = "foreman";
// Tools that send something on someone's behalf: any of them aimed at the card answers it.
const SENDS = [
  "reply",
  "send_message",
  "send_role_message",
  "send_to_session",
  "accept_role_message",
  "ack_role_message",
  "react",
  "workspace_chat_send",
];
const foremanCalls = (s, tool) => s.calls.filter((c) => c.caller === FOREMAN && (!tool || c.tool === tool));
const launches = (s) => s.sessions.filter((x) => x.launched_by === FOREMAN);
// An agent named by key (`acme/sprint-lead-claude`) or bare id is the same agent.
const agentId = (a) => String(a ?? "").split("/").pop();
const promptOf = (l) => String(l.initial_prompt ?? "");
const norm = (t) => String(t).replace(/[‘’]/g, "'").toLowerCase();
const sentences = (t) => t.split(/(?<=[.!?])\s+|\n+/);
const replyText = (s, turn) =>
  norm(
    s.replies
      .filter((r) => r.turn === turn)
      .map((r) => r.text)
      .join("\n"),
  );
const forbidden = (s, tools = []) =>
  foremanCalls(s)
    .filter((c) => tools.includes(c.tool))
    .map((c) => `called ${c.tool}${c.via ? ` through ${c.via}` : ""}`);
// Every string in an argument object except the message text.
const targetValues = (v, key) =>
  key === "text" ? [] : typeof v === "string" ? [v] : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => targetValues(x, k)) : [];

// The option a clause recommends: the first option it names, by label or as "option <key>".
function firstOption(clause, options) {
  const at = options
    .flatMap((o) => [norm(o.label), `option ${o.key}`].map((needle) => ({ key: o.key, i: clause.indexOf(needle) })))
    .filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i);
  return at[0]?.key;
}

const graders = {
  "onboard-repo"(s, e) {
    const out = forbidden(s, e.forbidden_tools);
    const mine = launches(s);
    if (mine.length !== e.launches) return [...out, `launched ${mine.length} sessions, expected ${e.launches}`];
    const [l] = mine;
    if (l.target !== e.target) out.push(`launched with target ${l.target}, expected ${e.target}`);
    if (!new RegExp(e.agent).test(agentId(l.agent))) out.push(`launched ${l.agent ?? "no agent"}, expected a guide agent`);
    if (!promptOf(l).trim().startsWith(e.prompt_starts)) out.push(`the launched session's prompt does not invoke ${e.prompt_starts}`);
    return out;
  },

  "start-sprint-lead"(s, e) {
    const out = forbidden(s, e.forbidden_tools);
    const want = s.config[e.agent_from];
    const mine = launches(s);
    for (const l of mine) if (agentId(l.agent) !== want) out.push(`launched ${l.agent ?? "an unnamed agent"}, expected only ${want}`);
    e.launches_after_turn.forEach((n, i) => {
      const got = mine.filter((l) => l.turn <= i + 1).length;
      if (got !== n) out.push(`${got} launches after turn ${i + 1}, expected ${n}`);
    });
    if (mine.length !== e.launches_after_turn.at(-1)) out.push(`${mine.length} launches in all`);
    const lead = mine.find((l) => agentId(l.agent) === want);
    if (!lead) out.push(`no ${want} launched`);
    else {
      if (lead.target !== e.target) out.push(`launched with target ${lead.target}, expected ${e.target}`);
      const named = [...norm(`${lead.name ?? ""} ${promptOf(lead)}`).matchAll(/sprint[ -]?(\d+)/g)].map((m) => m[1]);
      if (!named.length || named.some((n) => n !== e.sprint)) out.push(`the lead's name or prompt does not name sprint ${e.sprint} alone`);
      const firstLaunch = foremanCalls(s, "open_workspace")[0];
      if (!foremanCalls(s, "list_sessions").some((c) => c.seq < firstLaunch.seq))
        out.push("launched without checking list_sessions for a live lead");
    }
    return out;
  },

  "answer-card"(s, e) {
    const out = [];
    const card = s.cards[0];
    const first = replyText(s, 1);
    const second = replyText(s, 2);
    const firstReply = s.replies.find((r) => r.turn === 1);
    if (!foremanCalls(s).some((c) => e.reads.includes(c.tool) && c.seq < (firstReply?.seq ?? Infinity)))
      out.push("answered before reading the inbox");
    if (!first.includes(norm(card.story))) out.push(`the first reply does not name ${card.story}`);
    for (const o of card.options) if (!first.includes(norm(o.label))) out.push(`the first reply omits option "${o.label}"`);
    const picks = [...first.matchAll(new RegExp(`(?:${e.recommend})[^.!?\\n]*`, "g"))].map((m) => firstOption(m[0], card.options));
    if (!picks.length || picks.some((k) => k !== card.recommended)) out.push("the first reply does not recommend the card's pick");
    if (!new RegExp(`\\b(?:${e.second_reply_points_to})\\b`).test(second)) out.push("the second reply does not point to the page");
    if (sentences(second).some((x) => new RegExp(e.claims_done).test(x))) out.push("the second reply claims to have answered");
    const aimed = (v) => v === card.id || v === card.replyTo || v === card.story || v.startsWith(`${card.story}#`);
    for (const c of foremanCalls(s)) {
      if (SENDS.includes(c.tool) && targetValues(c.args).some(aimed)) out.push(`sent ${c.tool} to the card, its story or its replyTo`);
    }
    return out;
  },

  "recover-error"(s, e) {
    const out = forbidden(s, e.forbidden_tools);
    if (s.ghCalls.length !== e.pr_create_calls) out.push(`${s.ghCalls.length} pr create calls, expected ${e.pr_create_calls}`);
    const failedCall = s.ghCalls.find((g) => g.ok === false);
    const head = failedCall && (/--head[ =](\S+)/.exec(failedCall.args)?.[1] ?? failedCall.branch);
    if (failedCall && !new RegExp(e.pr_head).test(head ?? "")) out.push(`the pull request was opened from ${head}, not a foreman branch`);
    const f = e.failure_reply;
    const after = failedCall ? s.replies.filter((r) => r.turn === f.turn && r.seq > failedCall.seq) : [];
    if (after.length !== f.count) out.push(`${after.length} replies after the failure, expected ${f.count}`);
    const text = norm(after.map((r) => r.text).join("\n"));
    if (!new RegExp(f.matches).test(text)) out.push("the failure reply does not say what failed");
    if (f.asks && !sentences(text).some((x) => x.trim().endsWith("?") && new RegExp(f.asks).test(x)))
      out.push("the failure reply does not ask before retrying");
    if (JSON.stringify(s.worktrees.after) !== JSON.stringify(s.worktrees.before)) out.push("a foreman worktree was left behind");
    const r = e.reminder_reply;
    const reminder = replyText(s, r.turn);
    for (const part of r.includes) if (!reminder.includes(part)) out.push(`the reminder reply lacks "${part}"`);
    return out;
  },
};

export function grade(caseDef, state) {
  const grader = graders[caseDef.id];
  if (!grader) throw new Error(`no grader for ${caseDef.id}`);
  const played = state.turns.map((t) => t.text);
  const failures = [];
  if (JSON.stringify(played) !== JSON.stringify(caseDef.input.turns))
    failures.push(`played turns ${JSON.stringify(played)}, the case has ${JSON.stringify(caseDef.input.turns)}`);
  failures.push(...grader(state, caseDef.expected));
  return { pass: failures.length === 0, failures };
}
