// SPDX-License-Identifier: MIT
// Script graders: structure only. They read tool calls and their arguments, launched sessions,
// call order and the fixture's logs. They never see what a reply says: `grade` hands them a view
// with every message text removed. Whether a reply says the right thing is each case's `rubric`,
// judged in the recorded model runs and never part of the script grade.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { ghCommand } from "./fixture.mjs";

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
  "inbox_post",
  "post_agent_message",
];
// The arguments that say who a send goes to, as the real tools name them (`role` for
// send_role_message and post_agent_message, `workspace` for workspace_chat_send). Display
// fields (summary, onClick) are not here.
const RECIPIENT_KEYS = [
  "to",
  "role",
  "workspace",
  "recipient",
  "session",
  "session_id",
  "sessionId",
  "handle",
  "target",
  "replyTo",
  "reply_to",
  "message_id",
  "messageId",
];
// The value of a flag in an argv: `-H x`, `--head x`, `--head=x` or `-Hx`.
function flagValue(argv, short, long) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === short || a === long) return argv[i + 1];
    if (a.startsWith(`${long}=`)) return a.slice(long.length + 1);
    if (a.startsWith(short) && a.length > short.length && !a.startsWith("--")) return a.slice(short.length);
  }
  return undefined;
}

// Whether a gh call writes (a PR attempt, a merge, an API POST). Reads are list, view, status,
// checks and diff of any object, search, auth status, help, and API GETs.
function ghWrites(argv) {
  const { words } = ghCommand(argv);
  if (argv.some((a) => ["--help", "-h", "--version"].includes(a))) return false;
  if (words[0] === "api") {
    const method = flagValue(argv, "-X", "--method");
    if (method) return method.toUpperCase() !== "GET";
    if (words[1] === "graphql") return argv.some((a) => /\bmutation\b/.test(a));
    return argv.some((a) => /^(?:-[fF]|--field|--raw-field|--input)/.test(a));
  }
  if (words[0] === "search" || (words[0] === "auth" && words[1] === "status")) return false;
  return !["view", "list", "status", "checks", "diff"].includes(words[1]);
}

const foremanCalls = (s, tool) => s.calls.filter((c) => c.caller === FOREMAN && (!tool || c.tool === tool));
const launches = (s) => s.sessions.filter((x) => x.launched_by === FOREMAN);
// An agent named by key (`acme/sprint-lead-claude`) or bare id is the same agent.
const agentId = (a) => String(a ?? "").split("/").pop();
const promptOf = (l) => String(l.initial_prompt ?? "");
// A recipient compared as the host would: case-folded, `role:` or `story:` dropped, an org prefix
// dropped, ids as strings.
const handle = (v) =>
  String(v)
    .trim()
    .toLowerCase()
    .replace(/^(?:role|story):\s*/, "")
    .split("/")
    .pop();
const repliesIn = (s, turn) => s.replies.filter((r) => r.turn === turn);
const forbidden = (s, tools = []) =>
  foremanCalls(s)
    .filter((c) => tools.includes(c.tool))
    .map((c) => `called ${c.tool}${c.via ? ` through ${c.via}` : ""}`);

// The launch shape both launch cases share: target, attribution, agent.
function launchForm(s, l, e, agent) {
  const out = [];
  if (l.target !== e.target) out.push(`launched with target ${l.target}, expected ${e.target}`);
  if (l.launched_by_arg !== s.config.self) out.push(`launched_by is ${l.launched_by_arg}, expected the Foreman's own ${s.config.self}`);
  if (agentId(l.agent) !== agent) out.push(`launched ${l.agent ?? "no agent"}, expected ${agent}`);
  return out;
}

const graders = {
  "onboard-repo"(s, e) {
    const out = forbidden(s, e.forbidden_tools);
    const mine = launches(s);
    if (mine.length !== e.launches) return [...out, `launched ${mine.length} sessions, expected ${e.launches}`];
    const [l] = mine;
    out.push(...launchForm(s, l, e, `guide-${s.config.runtime}`));
    if (l.mode !== e.mode) out.push(`launched with mode ${l.mode}, expected ${e.mode}`);
    if (promptOf(l).trim().split(/\s+/)[0] !== e.command) out.push(`the launched session's prompt does not invoke ${e.command}`);
    return out;
  },

  "start-sprint-lead"(s, e) {
    const out = forbidden(s, e.forbidden_tools);
    const want = s.config[e.agent_from];
    const mine = launches(s);
    e.launches_after_turn.forEach((n, i) => {
      const got = mine.filter((l) => l.turn <= i + 1).length;
      if (got !== n) out.push(`${got} launches after turn ${i + 1}, expected ${n}`);
    });
    for (const l of mine) out.push(...launchForm(s, l, e, want));
    const lead = mine.find((l) => agentId(l.agent) === want);
    if (!lead) out.push(`no ${want} launched`);
    else {
      const named = [...`${lead.name ?? ""} ${promptOf(lead)}`.toLowerCase().matchAll(/sprint[ -]?(\d+)/g)].map((m) => m[1]);
      if (!named.length || named.some((n) => n !== e.sprint)) out.push(`the lead's name or prompt does not name sprint ${e.sprint} alone`);
      const firstLaunch = foremanCalls(s, "open_workspace")[0];
      if (!foremanCalls(s, "list_sessions").some((c) => c.seq < firstLaunch.seq))
        out.push("launched without checking list_sessions for a live lead");
    }
    return out;
  },

  "answer-card"(s, e) {
    const out = forbidden(s, e.forbidden_tools);
    const card = s.cards[0];
    const [firstReply] = repliesIn(s, 1);
    if (!firstReply) out.push("no reply to the person's question");
    if (!repliesIn(s, 2).length) out.push("no reply to the person's answer");
    if (!foremanCalls(s).some((c) => e.reads.includes(c.tool) && c.seq < (firstReply?.seq ?? Infinity)))
      out.push("answered before reading the inbox");
    const story = handle(card.story);
    const aimed = (v) => [handle(card.id), handle(card.replyTo), story].includes(handle(v)) || handle(v).startsWith(`${story}#`);
    for (const c of foremanCalls(s)) {
      if (!SENDS.includes(c.tool)) continue;
      // A send to the person is fine; its other recipient arguments still count.
      const keys = RECIPIENT_KEYS.filter((k) => !(k === "to" && handle(c.args.to ?? "") === "human"));
      const recipients = keys.flatMap((k) => [c.args[k]].flat(Infinity)).filter((v) => typeof v === "string" || typeof v === "number");
      if (recipients.some(aimed)) out.push(`sent ${c.tool} to the card, its story or its replyTo`);
    }
    return out;
  },

  "recover-error"(s, e) {
    const out = forbidden(s, e.forbidden_tools);
    const writes = s.ghCalls.filter((g) => ghWrites(g.argv));
    if (writes.length !== e.gh_writes) out.push(`${writes.length} gh writes, expected ${e.gh_writes} (the failed pr create)`);
    const failedCall = s.ghCalls.find((g) => g.create && g.ok === false);
    if (!failedCall) return [...out, "no pr create was attempted"];
    // `--head owner:branch` names the same branch.
    const head = (flagValue(failedCall.argv, "-H", "--head") ?? failedCall.branch)?.replace(/^[^:/]+:/, "");
    if (!new RegExp(e.pr_head).test(head ?? "")) out.push(`the pull request was opened from ${head}, not a foreman branch`);
    else if (!s.branches.includes(head)) out.push(`the head ${head} was never created`);
    if (!(failedCall.foremanWorktrees >= 1)) out.push("the pull request was attempted with no foreman worktree");
    const f = e.failure_reply;
    const after = s.replies.filter((r) => r.turn === f.turn && r.seq > failedCall.seq);
    if (after.length !== f.count) out.push(`${after.length} replies after the failure, expected ${f.count}`);
    if (JSON.stringify(s.worktrees.after) !== JSON.stringify(s.worktrees.before)) out.push("a foreman worktree was left behind");
    if (!repliesIn(s, e.reminder_turn).length) out.push("no reply to the reminder request");
    return out;
  },
};

// What a script grader may see: the state with every message text removed.
const withoutText = ({ text: _text, ...rest }) => rest;
export const scriptView = (state) => ({
  ...state,
  replies: state.replies.map(withoutText),
  calls: state.calls.map((c) => ({ ...c, args: withoutText(c.args ?? {}) })),
  sessions: state.sessions.map(withoutText),
});

export function grade(caseDef, state) {
  const grader = graders[caseDef.id];
  if (!grader) throw new Error(`no grader for ${caseDef.id}`);
  const played = state.turns.map((t) => t.text);
  const failures = [];
  if (JSON.stringify(played) !== JSON.stringify(caseDef.input.turns))
    failures.push(`played turns ${JSON.stringify(played)}, the case has ${JSON.stringify(caseDef.input.turns)}`);
  failures.push(...grader(scriptView(state), caseDef.expected));
  return { pass: failures.length === 0, failures };
}
