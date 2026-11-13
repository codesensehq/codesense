// SPDX-License-Identifier: MIT
// Script graders: they read tool calls, sessions and the fixture's logs, never the wording of a
// reply beyond the few facts a case names (a story id, an option, "page", a failure).
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
const foremanCalls = (s, tool) => s.calls.filter((c) => c.caller === FOREMAN && (!tool || c.tool === tool));
const launches = (s) => s.sessions.filter((x) => x.launched_by === FOREMAN);
// Typographic quotes and case never decide a grade.
const norm = (t) => String(t).replace(/[‘’]/g, "'").toLowerCase();
const replyText = (s, turn) =>
  s.replies
    .filter((r) => r.turn === turn)
    .map((r) => r.text)
    .join("\n");
const forbidden = (s, tools = []) =>
  foremanCalls(s)
    .filter((c) => tools.includes(c.tool))
    .map((c) => `called ${c.tool}`);

const graders = {
  "onboard-repo"(s, e) {
    const out = forbidden(s, e.forbidden_tools);
    const mine = launches(s);
    if (mine.length !== e.launches) out.push(`launched ${mine.length} sessions, expected ${e.launches}`);
    else {
      const prompt = String(mine[0].initial_prompt ?? "");
      if (!prompt.includes(e.prompt_includes)) out.push(`the launched session's prompt does not invoke ${e.prompt_includes}`);
      if (!prompt.includes(s.config.repo) && !prompt.includes(s.config.repoPath))
        out.push(`the launched session's prompt does not name ${s.config.repo}`);
    }
    return out;
  },

  "start-sprint-lead"(s, e) {
    const out = forbidden(s, e.forbidden_tools);
    const want = s.config[e.agent_from];
    const mine = launches(s);
    for (const l of mine) if (l.agent !== want) out.push(`launched ${l.agent ?? "an unnamed agent"}, expected only ${want}`);
    e.launches_after_turn.forEach((n, i) => {
      const got = mine.filter((l) => l.turn <= i + 1).length;
      if (got !== n) out.push(`${got} launches after turn ${i + 1}, expected ${n}`);
    });
    if (mine.length !== e.launches_after_turn.at(-1)) out.push(`${mine.length} launches in all`);
    const lead = mine.find((l) => l.agent === want);
    if (!lead) out.push(`no ${want} launched`);
    else {
      if (!new RegExp(e.sprint, "i").test(`${lead.name ?? ""} ${lead.initial_prompt ?? ""}`))
        out.push(`the lead's name or prompt does not name ${e.sprint}`);
      const firstLaunch = foremanCalls(s, "open_workspace")[0];
      if (!foremanCalls(s, "list_sessions").some((c) => c.seq < firstLaunch.seq))
        out.push("launched without checking list_sessions for a live lead");
    }
    return out;
  },

  "answer-card"(s, e) {
    const out = [];
    const card = s.cards[0];
    const first = norm(replyText(s, 1));
    const second = norm(replyText(s, 2));
    if (!foremanCalls(s, "inbox_list").length) out.push("never read the inbox");
    if (!first.includes(norm(card.story))) out.push(`the first reply does not name ${card.story}`);
    for (const o of card.options) if (!first.includes(norm(o.label))) out.push(`the first reply omits option "${o.label}"`);
    // The recommendation is the clause from "recommend" to the end of its sentence: it must name
    // the card's pick and no other option.
    const clause = /recommend[^.!?\n]*/.exec(first)?.[0] ?? "";
    const named = card.options.filter((o) => clause.includes(norm(o.label))).map((o) => o.key);
    if (named.length !== 1 || named[0] !== card.recommended) out.push("the first reply does not recommend the card's pick");
    if (!new RegExp(`\\b${e.second_reply_includes}\\b`).test(second))
      out.push(`the second reply does not point to the ${e.second_reply_includes}`);
    if (/\bi(?:'ve| have)? (?:answered|picked|chose|selected|sent)\b/.test(second)) out.push("the second reply claims to have answered");
    for (const c of foremanCalls(s)) {
      const targets = Object.entries(c.args).filter(([k]) => k !== "text");
      if (targets.some(([, v]) => v === card.id || v === card.replyTo)) out.push(`sent ${c.tool} to the card or its replyTo`);
    }
    return out;
  },

  "recover-error"(s, e) {
    const out = forbidden(s, e.forbidden_tools);
    if (s.ghCalls.length !== e.pr_create_calls) out.push(`${s.ghCalls.length} pr create calls, expected ${e.pr_create_calls}`);
    const failedCall = s.ghCalls.find((g) => g.ok === false);
    if (failedCall && !new RegExp(e.pr_head).test(failedCall.args)) out.push("the pull request was not opened from a foreman branch");
    if (!s.branches.some((b) => new RegExp(e.pr_head).test(b))) out.push("no foreman branch was created");
    const f = e.failure_reply;
    const after = failedCall ? s.replies.filter((r) => r.turn === f.turn && r.seq > failedCall.seq) : [];
    if (after.length !== f.count) out.push(`${after.length} replies after the failure, expected ${f.count}`);
    const text = norm(after.map((r) => r.text).join("\n"));
    if (!new RegExp(f.matches).test(text)) out.push("the failure reply does not say what failed");
    if (f.asks && !text.includes("?")) out.push("the failure reply does not ask before retrying");
    if (JSON.stringify(s.worktrees.after) !== JSON.stringify(s.worktrees.before)) out.push("a foreman worktree was left behind");
    const r = e.reminder_reply;
    const reminder = norm(replyText(s, r.turn));
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
