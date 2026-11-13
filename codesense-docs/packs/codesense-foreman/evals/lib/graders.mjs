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
    else if (!String(mine[0].initial_prompt ?? "").includes(e.prompt_includes))
      out.push(`the launched session's prompt does not invoke ${e.prompt_includes}`);
    return out;
  },

  "start-sprint-lead"(s, e) {
    const out = [];
    const mine = launches(s);
    for (const l of mine) {
      if (e.forbidden_roles.includes(l.role)) out.push(`launched a ${l.role}`);
    }
    e.launches_after_turn.forEach((want, i) => {
      const got = mine.filter((l) => l.turn <= i + 1).length;
      if (got !== want) out.push(`${got} launches after turn ${i + 1}, expected ${want}`);
    });
    const lead = mine.find((l) => l.role === e.role);
    if (!lead) out.push(`no ${e.role} launched`);
    else if (lead.agent !== s.config[e.agent_from]) out.push(`launched ${lead.agent}, expected ${s.config[e.agent_from]}`);
    return out;
  },

  "answer-card"(s, e) {
    const out = [];
    const card = s.cards[0];
    const first = replyText(s, 1);
    const second = replyText(s, 2);
    if (!first.includes(card.story)) out.push(`the first reply does not name ${card.story}`);
    for (const o of card.options) if (!first.includes(o.label)) out.push(`the first reply omits option "${o.label}"`);
    const rec = card.options.find((o) => o.key === card.recommended);
    if (!/recommend/i.test(first) || !first.includes(rec.label)) out.push("the first reply gives no recommendation");
    if (!new RegExp(e.second_reply_includes, "i").test(second)) out.push(`the second reply does not point to the ${e.second_reply_includes}`);
    for (const c of foremanCalls(s)) {
      const to = c.args.to ?? c.args.target ?? c.args.session;
      if (to === card.replyTo) out.push(`sent ${c.tool} to the card's replyTo`);
    }
    return out;
  },

  "recover-error"(s, e) {
    const out = forbidden(s, e.forbidden_tools);
    if (s.ghCalls.length !== e.pr_create_calls) out.push(`${s.ghCalls.length} pr create calls, expected ${e.pr_create_calls}`);
    const f = e.failure_reply;
    const failed = s.replies.filter((r) => r.turn === f.turn);
    if (failed.length !== f.count) out.push(`${failed.length} replies after the failure, expected ${f.count}`);
    const text = failed.map((r) => r.text).join("\n");
    if (!new RegExp(f.matches, "i").test(text)) out.push("the failure reply does not say what failed");
    if (f.asks && !/\?\s*$/.test(text.trim())) out.push("the failure reply does not ask before retrying");
    if (JSON.stringify(s.worktrees.after) !== JSON.stringify(s.worktrees.before)) out.push("a foreman worktree was left behind");
    const r = e.reminder_reply;
    const reminder = replyText(s, r.turn).toLowerCase();
    for (const part of r.includes) if (!reminder.includes(part)) out.push(`the reminder reply lacks "${part}"`);
    return out;
  },
};

export function grade(caseDef, state) {
  const grader = graders[caseDef.id];
  if (!grader) throw new Error(`no grader for ${caseDef.id}`);
  const failures = grader(state, caseDef.expected);
  return { pass: failures.length === 0, failures };
}
