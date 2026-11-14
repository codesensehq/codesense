// SPDX-License-Identifier: MIT
// Script graders: structure only. They read tool calls and their arguments, launched sessions,
// call order and the fixture's logs. They never see what a reply says: `grade` hands them a view
// with every message text removed. Whether a reply says the right thing is each case's `rubric`,
// judged in the recorded model runs and never part of the script grade.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { agentId, ghCommand, GIT_ACCESS_PATH, GITHUB_PR, PRIOR_BRANCH, sha256, SKILL_PATH } from "./fixture.mjs";

const casesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cases");

const loadDir = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => parse(readFileSync(path.join(dir, f), "utf8")));

// The floor's four cases.
export const loadCases = () => loadDir(casesDir);
// The behaviour cases and the variants of the floor's: run and reported, never part of the floor.
export const loadExtraCases = () => loadDir(path.join(casesDir, "outside-floor"));

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

const gitLines = (s) => foremanCalls(s, "git").map((c) => ({ seq: c.seq, line: c.args.argv.join(" ") }));
const BRANCH = /^foreman\/[a-z0-9.-]+-[0-9a-f]{4}$/;
const ADD = /^worktree add -b (foreman\/\S+) \.\.\/(foreman-\S+) (\S+)$/;
// The branches this run made (the planted one from a "previous run" is not).
const newBranches = (s, where) => s.foremanBranches.filter((b) => b.where === where && b.name !== PRIOR_BRANCH);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// A PR head without an `owner:` prefix, and the branch a gh argv's --head names.
const bareHead = (head) => head?.replace(/^[^:/]+:/, "");
const headOf = (argv) => bareHead(flagValue(argv, "-H", "--head"));
// A path as the file system sees it (macOS temp dirs sit behind a /private symlink), through its
// nearest existing parent, since a removed worktree's files are gone by the time it is graded.
const real = (p) => {
  const abs = path.resolve(p);
  for (let dir = abs; ; dir = path.dirname(dir)) {
    if (existsSync(dir)) return path.join(realpathSync(dir), path.relative(dir, abs));
    if (dir === path.dirname(dir)) return abs;
  }
};
const firstSeq = (calls, test) => calls.find(test)?.seq ?? Infinity;
// Every send to the person, or to a card, its story or its replyTo.
function sendsToCards(s) {
  const out = [];
  const sends = foremanCalls(s).filter((c) => SENDS.includes(c.tool));
  for (const card of s.cards) {
    const story = handle(card.story);
    const aimed = (v) => [handle(card.id), handle(card.replyTo), story].includes(handle(v)) || handle(v).startsWith(`${story}#`);
    for (const c of sends) {
      // A send to the person is fine; its other recipient arguments still count.
      const keys = RECIPIENT_KEYS.filter((k) => !(k === "to" && handle(c.args.to ?? "") === "human"));
      const recipients = keys.flatMap((k) => [c.args[k]].flat(Infinity)).filter((v) => typeof v === "string" || typeof v === "number");
      if (recipients.some(aimed)) out.push(`sent ${c.tool} to the card, its story or its replyTo`);
    }
  }
  return out;
}

// The home update every wake runs, and the reads before a worktree: not acting on a request.
const HOME_ONLY = /^(?:fetch(?: origin)?|merge --ff-only origin\/main|remote|worktree list|ls-remote --heads origin(?: \S+)?)$/;

// Checks shared by every *new-story* variant. Turns alternate: the request, then "Create".
function newStory(s, e) {
  const out = forbidden(s, e.forbidden_tools);
  const git = gitLines(s);
  const acting = (c) => ["git", "script", "write_file"].includes(c.tool) && !(c.tool === "git" && HOME_ONLY.test(c.args.argv.join(" ")));
  // A pull request through the GitHub MCP tool counts like one through gh.
  const mcpPrs = foremanCalls(s, GITHUB_PR);
  const acts = [...s.calls.filter((c) => c.caller === FOREMAN && acting(c)), ...s.scriptCalls, ...s.ghCalls, ...mcpPrs];
  if (!repliesIn(s, 1).length) out.push("no reply to the request");
  if (s.variant === "docs") {
    if (acts.length || newBranches(s, "origin").length || newBranches(s, "home").length)
      out.push("created a worktree, a branch, a file or a pull request in the docs team");
    if (!same(s.home.after, s.home.before)) out.push("the home worktree changed");
    return out;
  }
  const creates = e.creates ?? 1;
  const turnSeq = (n) => s.turns.find((t) => t.index === n)?.seq ?? Infinity;
  // Nothing happens in a request turn: it only asks. Each Create turn gets a reply.
  for (let n = 1; n <= 2 * creates; n += 2) {
    const [from, to] = [turnSeq(n), turnSeq(n + 1)];
    if (!repliesIn(s, n).length) out.push(`no confirmation in turn ${n}`);
    if (!repliesIn(s, n + 1).length) out.push(`no reply in turn ${n + 1}`);
    if (acts.some((c) => c.seq > from && c.seq < to)) out.push(`did something in turn ${n}, before the person said Create`);
  }
  const adds = git.filter((g) => g.line.startsWith("worktree add"));
  if (adds.length !== creates) out.push(`${adds.length} worktree adds, expected ${creates}`);
  const base = s.variant === "no-remote" ? "main" : "origin/main";
  const calls = foremanCalls(s);
  const made = [];
  adds.forEach((add, i) => {
    // This story's window: from its Create turn to the next story's worktree add.
    const end = adds[i + 1]?.seq ?? Infinity;
    const m = ADD.exec(add.line);
    if (!m) {
      out.push(`\`git ${add.line}\` is not \`git worktree add -b foreman/<slug> ../foreman-<slug> <base>\``);
      return;
    }
    made.push(m[1]);
    if (!BRANCH.test(m[1]) || m[2] !== `foreman-${m[1].slice(8)}`) out.push(`the branch ${m[1]} and worktree ${m[2]} are not foreman/<slug>-<4 hex> and foreman-<slug>-<4 hex>`);
    if (m[1] === PRIOR_BRANCH) out.push("reused the previous run's branch name");
    if (m[3] !== base) out.push(`the worktree is based on ${m[3]}, expected ${base}`);
    // The one order an AC names here: with a remote, its branches are read before the worktree.
    // This story starts after the previous story's commit (or its worktree add, with none).
    const since = adds[i - 1] ? Math.min(firstSeq(git, (g) => g.seq > adds[i - 1].seq && /\bcommit\b/.test(g.line)), add.seq) : 0;
    if (s.variant !== "no-remote" && !git.some((g) => g.seq > since && g.seq < add.seq && g.line.startsWith("ls-remote --heads origin")))
      out.push(`${m[1]}: did not read the remote's branches (git ls-remote --heads origin) before adding the worktree`);
    if (s.variant !== "scripted") {
      // Outcomes, not order: the format was read, and the story was checked (inline, or by a path
      // that resolves to the written file) before its commit.
      const inside = (c) => c.seq > since && c.seq < end;
      const write = calls.find((c) => c.seq > add.seq && c.seq < end && c.tool === "write_file" && /\/stories\/[^/]+\.md$/.test(c.args.file));
      const commit = firstSeq(git, (g) => g.seq > add.seq && g.seq < end && /\bcommit\b/.test(g.line));
      const written = write && real(write.args.file);
      const resolves = (p) => write && typeof p === "string" && real(path.resolve(s.homeDir, p)) === written;
      const sameText = (text) => write && typeof text === "string" && sha256(text) === write.args.sha256;
      const checked = calls.some((c) => inside(c) && c.seq < commit && c.tool === "validate_story" && (sameText(c.args.content) || resolves(c.args.path)));
      if (!calls.some((c) => c.tool === "get_story_format" && c.seq < end)) out.push(`${m[1]}: never read get_story_format`);
      if (!write || commit === Infinity || !checked) out.push(`${m[1]}: did not check the story with validate_story before its commit`);
    }
  });
  if (new Set(made).size !== made.length) out.push("two stories got the same branch name");
  if (!same(s.worktrees.after, s.worktrees.before)) out.push("a foreman worktree was left behind");
  if (!same(s.home.after, s.home.before) || s.home.after.status) out.push("the home worktree changed");
  const remote = s.variant !== "no-remote";
  const mine = newBranches(s, remote ? "origin" : "home");
  if (mine.length !== creates) out.push(`${mine.length} foreman branches ${remote ? "pushed" : "made"}, expected ${creates}`);
  for (const branch of mine) {
    const files = branch.added.filter((f) => /^stories\/.+\.md$/.test(f));
    if (branch.added.length !== 1 || files.length !== 1) out.push(`${branch.name} adds ${branch.added.join(", ") || "nothing"}, expected one story file`);
    else {
      const text = branch.files[files[0]];
      if (!/^sprint:\s*backlog\s*$/m.test(text) || !/^status:\s*planning\s*$/m.test(text)) out.push(`${files[0]} is not sprint: backlog, status: planning`);
    }
    if (!made.includes(branch.name)) out.push(`${branch.name} is not a branch a worktree was made on`);
  }
  if (remote) {
    // The recorded method opens each PR: gh's, or the GitHub MCP tool's. None recorded, or a
    // method that can't open a PR: the branch is pushed and handed over, with no gh call.
    const viaGh = s.ghCalls.filter((g) => g.create).map((g) => ({ seq: g.seq, head: headOf(g.argv) }));
    const viaMcp = mcpPrs.map((c) => ({ seq: c.seq, head: bareHead(c.args.head) }));
    if (s.gitAccess !== "gh" && s.ghCalls.length) out.push(`${s.ghCalls.length} gh calls with no gh git-access method`);
    const wanted = (method) => (s.gitAccess === method ? creates : 0);
    if (viaGh.length !== wanted("gh")) out.push(`${viaGh.length} pr create calls, expected ${wanted("gh")}`);
    if (viaMcp.length !== wanted("github-mcp")) out.push(`${viaMcp.length} GitHub MCP pull requests, expected ${wanted("github-mcp")}`);
    const prs = [...viaGh, ...viaMcp].sort((a, b) => a.seq - b.seq);
    if (prs.length && !same(prs.map((p) => p.head).sort(), mine.map((b) => b.name).sort())) out.push("the pull requests were not opened from the story branches");
    // The record is read before each PR (after the one before it), and at least once.
    const isRead = (c) => c.tool === "read_content_file" && c.args.path === GIT_ACCESS_PATH;
    if (!calls.some(isRead)) out.push("never read the recorded git-access method");
    else
      prs.forEach((pr, i) => {
        if (!calls.some((c) => isRead(c) && c.seq > (prs[i - 1]?.seq ?? 0) && c.seq < pr.seq))
          out.push(`opened a pull request before reading the recorded git-access method (${pr.head})`);
      });
  } else {
    if (s.ghCalls.length || mcpPrs.length) out.push("opened a pull request with no remote");
    if (git.some((g) => /^(?:-C \S+ )?push\b/.test(g.line))) out.push("pushed with no remote");
  }
  if (s.variant === "scripted") {
    const wts = made.map((b) => `foreman-${b.slice(8)}`);
    const id = s.scriptCalls.find((c) => c.script === "next-id");
    const story = s.scriptCalls.find((c) => c.script === "new-story");
    if (!id || !story) out.push("did not run the team's next-id and new-story scripts");
    else {
      if (!s.scriptCalls.every((c) => wts.includes(path.basename(c.cwd)))) out.push("the team scripts did not run inside the foreman-* worktree");
      if (story.id !== "ACME-42") out.push(`the story id is ${story.id}, the id script printed ACME-42`);
    }
    const read = firstSeq(calls, (c) => c.tool === "read_content_file" && c.args.path === SKILL_PATH);
    if (read === Infinity || !foremanCalls(s, "query_context").some((c) => c.seq < read)) out.push("never found and read the story-create skill");
    if (foremanCalls(s, "write_file").some((c) => /\/stories\//.test(c.args.file))) out.push("wrote the story itself when the team has a story-create skill");
  } else if (s.scriptCalls.length) out.push("ran team scripts the team does not have");
  return out;
}

// What a case of a kind must hold to be gradable: a broken case is refused, not failed.
const checks = {
  "new-story"(caseDef) {
    const creates = caseDef.expected?.creates ?? 1;
    const turns = caseDef.input?.turns?.length ?? 0;
    const docs = caseDef.fixture?.story_team === "docs";
    if (docs ? turns !== 1 : turns !== 2 * creates) throw new Error(`${caseDef.id}: ${turns} turns do not fit creates ${creates}`);
  },
};

const graders = {
  "new-story": newStory,

  // What the handoff says (its prefix, the worktree and the child) is the rubric's.
  handoff(s, e) {
    const out = forbidden(s, e.forbidden_tools);
    const notes = repliesIn(s, 1);
    if (!notes.length) return [...out, "no handoff message to the person"];
    if (notes.length > 1) out.push(`${notes.length} handoff messages, expected 1`);
    const done = foremanCalls(s, "signal_done").find((c) => c.seq > notes[0].seq);
    if (!done) out.push("no signal_done after the handoff");
    else if (foremanCalls(s).some((c) => c.seq > done.seq)) out.push("the Foreman kept going after signal_done");
    return out;
  },

  // Which cards the reply lists is the rubric's; the script checks the read and the sends.
  "waiting-on-me"(s, e) {
    const out = forbidden(s, e.forbidden_tools);
    const [reply] = repliesIn(s, 1);
    if (!reply) out.push("no reply to the person");
    if (!foremanCalls(s, "inbox_list").some((c) => c.args.kind === "needs-you")) out.push('did not read inbox_list {kind: "needs-you"}');
    out.push(...sendsToCards(s));
    return out;
  },

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

  // The setup hand-off against the fixture's scripted guide: structure only (cards, the launch, the
  // ledger, the claim and ack). That a reply starts `Set up:` or names the step is the rubric's.
  setup(s, e) {
    const out = forbidden(s, e.forbidden_tools);
    const mine = launches(s);
    for (const t of s.turns) if (!repliesIn(s, t.index).length) out.push(`no reply in turn ${t.index}`);
    // Cards the Foreman raised: a send of kind needs-you.
    const cards = foremanCalls(s).filter((c) => SENDS.includes(c.tool) && c.args.kind === "needs-you");
    if (cards.length !== e.offer_cards) out.push(`${cards.length} needs-you cards raised, expected ${e.offer_cards}`);
    for (const c of cards) {
      const labels = JSON.stringify(c.args.options ?? []);
      if (!/Set up now/.test(labels) || !/Not now/.test(labels)) out.push("the offer card's options are not Set up now and Not now");
    }
    const ledgerWrites = foremanCalls(s, "records_create").filter((c) => c.args.collection === "setup-ledger");
    if (e.ledger_write) {
      const [w] = ledgerWrites;
      if (ledgerWrites.length !== 1) out.push(`${ledgerWrites.length} setup-ledger writes, expected 1`);
      else if (w.args.fields?.step !== "foreman-offer" || w.args.fields?.state !== "skipped") out.push("the ledger row is not step foreman-offer, state skipped");
    } else if (ledgerWrites.length) out.push("wrote the setup-ledger when nothing was declined");
    if (mine.length !== e.launches) return [...out, `launched ${mine.length} sessions, expected ${e.launches}`];
    const looked = (n) => foremanCalls(s, "list_sessions").some((c) => c.seq < n);
    if (e.reuses && !looked(Infinity)) out.push("did not look in list_sessions for a live setup session");
    const launchCalls = foremanCalls(s, "open_workspace");
    mine.forEach((l, i) => {
      if (!looked(launchCalls[i]?.seq ?? 0)) out.push("launched without looking in list_sessions for a live setup session");
      out.push(...launchForm(s, l, { target: "team-workspace" }, `guide-${s.config.runtime}`));
      if (l.name !== "Setup") out.push(`launched with name ${l.name}, expected Setup`);
      if (l.mode !== "visible-unfocused") out.push(`launched with mode ${l.mode}, expected visible-unfocused`);
      const words = promptOf(l).trim().split(/\s+/);
      const resume = words[1] === "resume";
      const want = e.prompt.split(" ");
      if (words[0] !== want[0] || resume !== (want[1] === "resume")) out.push(`the launch prompt is not ${e.prompt}`);
      // A resume carries the latest Guide handoff: from the thread, when there is one.
      const handoff = s.turns.filter((t) => t.seq < (launchCalls[i]?.seq ?? Infinity) && /^Guide handoff:/.test(t.text)).at(-1);
      if (resume && handoff && !promptOf(l).includes(handoff.text.replace(/^Guide handoff:\s*/, "")))
        out.push("the resume launch does not carry the latest Guide handoff");
    });
    if (e.guide_first_step && s.guideCards[0]?.step !== e.guide_first_step)
      out.push(`the guide's first card was ${s.guideCards[0]?.step ?? "none"}, expected ${e.guide_first_step}`);
    if (e.hand_back === "claimed") {
      const sent = s.roleMessages.find((m) => m.kind === "setup-done");
      // A claim counts when the fixture's queue shows the hand-back claimed (a claim on another role's queue takes nothing).
      const claim = sent?.claimed ? foremanCalls(s, "claim_role_messages").find((c) => c.seq > sent.seq) : undefined;
      const ack = foremanCalls(s, "ack_role_message").find((c) => c.seq > (claim?.seq ?? Infinity));
      if (!sent) out.push("the guide sent no Setup done message");
      else if (!claim) out.push("did not claim the hand-back from the role queue");
      else if (!ack) out.push("claimed the hand-back and never acked it");
      else if (s.replies.filter((r) => r.seq > ack.seq).length !== 1) out.push("expected exactly one reply after the hand-back");
    }
    if (e.hand_back === "stopped") {
      const last = s.turns.at(-1)?.index;
      const read = foremanCalls(s, "records_list").some((c) => c.args.collection === "setup-ledger" && c.turn === last);
      if (!read) out.push("did not read the setup-ledger when asked how setup is going");
      if (repliesIn(s, last).length !== 1) out.push(`${repliesIn(s, last).length} replies in the last turn, expected 1`);
    }
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
    out.push(...sendsToCards({ ...s, cards: [card] }));
    return out;
  },

  "recover-error"(s, e) {
    const out = forbidden(s, e.forbidden_tools);
    const writes = s.ghCalls.filter((g) => ghWrites(g.argv));
    if (writes.length !== e.gh_writes) out.push(`${writes.length} gh writes, expected ${e.gh_writes} (the failed pr create)`);
    const failedCall = s.ghCalls.find((g) => g.create && g.ok === false);
    if (!failedCall) return [...out, "no pr create was attempted"];
    const read = firstSeq(foremanCalls(s), (c) => c.tool === "read_content_file" && c.args.path === GIT_ACCESS_PATH);
    if (!(read < failedCall.seq)) out.push("attempted the pull request before reading the recorded git-access method");
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
  const grader = graders[caseDef.kind ?? caseDef.id];
  if (!grader) throw new Error(`no grader for ${caseDef.id}`);
  checks[caseDef.kind]?.(caseDef);
  const played = state.turns.map((t) => t.text);
  const failures = [];
  if (JSON.stringify(played) !== JSON.stringify(caseDef.input.turns))
    failures.push(`played turns ${JSON.stringify(played)}, the case has ${JSON.stringify(caseDef.input.turns)}`);
  failures.push(...grader(scriptView(state), caseDef.expected));
  return { pass: failures.length === 0, failures };
}
