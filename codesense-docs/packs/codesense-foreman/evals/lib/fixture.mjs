// SPDX-License-Identifier: MIT
// The eval sandbox: a temp dir with a local bare `origin`, a home clone, a `gh` shim first on PATH
// and a record of every tool call the agent under test makes. HOME points inside the sandbox and
// credential variables are dropped, so no real GitHub and no credentials. One sequence counter
// orders tool calls and `gh` calls, so graders can tell what came first.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// `self` is the Foreman's own session id: what it passes as `launched_by`.
export const CONFIG = {
  team: "acme",
  runtime: "claude",
  self: "foreman-session-1",
  sprintLeadAgent: "sprint-lead-claude",
  repo: "~/code/demo",
};

export const CARDS = [
  {
    id: 4101, // an inbox message id, a number as in the real `reply`
    story: "ACME-7",
    replyTo: "acme-7-lead",
    question: "Which retry policy should the sync use?",
    options: [
      { key: "a", label: "retry once" },
      { key: "b", label: "retry with backoff" },
    ],
    recommended: "b",
  },
];
// The branch a "previous run" of the new-story case left behind, so a repeat must pick a new name.
export const PRIOR_BRANCH = "foreman/dark-mode-support-0000";
// A card the person already answered: the needs-you view never lists it.
export const ANSWERED_CARD = {
  id: 4100,
  story: "ACME-3",
  replyTo: "acme-3-lead",
  question: "Which logging level should the sync use?",
  options: [
    { key: "a", label: "info" },
    { key: "b", label: "debug" },
  ],
  recommended: "a",
  state: "answered",
  answer: "a",
};
// What the scripted guide stub does, for the setup hand-off cases. The real setup agent belongs to
// the onboarding work; this walks the ledger's steps and ends with the hand-back line the setup
// skill's `foreman-handback` block names (a test ties the two together).
export const SETUP_STEPS = ["team", "source-repos", "gh"];
export const HANDBACK_PREFIX = "Setup done:";
export const HANDBACK_ROLE = "codesense-foreman";
const HANDBACK_TEXT = `${HANDBACK_PREFIX} team ${CONFIG.team}, 2 repos, gh signed in`;
// A card the Foreman raised and the person has not answered: the offer guard reads it.
const OFFER_CARD = {
  id: 4200,
  story: "setup",
  kind: "needs-you",
  from: "foreman",
  question: "Set up CodeSense now?",
  options: [
    { key: "a", label: "Set up now" },
    { key: "b", label: "Not now" },
  ],
  recommended: "a",
};
const copyCards = (mixed = false) => JSON.parse(JSON.stringify(mixed ? [ANSWERED_CARD, ...CARDS] : CARDS));

// Dropped from the sandbox env: anything that could reach a real account, and every inherited
// GIT_* (a GIT_DIR from a hook would point the fixture's git at the real repository).
const DROPPED =
  /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|ASKPASS|NETRC|^GH_|^GITHUB_|^GIT_|^AWS_|^SSH_|^KUBECONFIG$|^DOCKER_CONFIG$/i;

// The real open_workspace accepts these camelCase aliases; graders read the snake_case names.
const ALIASES = { initialPrompt: "initial_prompt", launchedBy: "launched_by", storyId: "story_id", queueRole: "queue_role" };
const canonical = (args) =>
  Object.fromEntries(Object.entries(args ?? {}).map(([k, v]) => [ALIASES[k] ?? k, v]));

// The gh command an argv names: global repo flags dropped, then the first two words.
// Shared by the shim (which fails the first `pr create`) and the graders.
export function ghCommand(argv) {
  const words = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "-R" || argv[i] === "--repo") i += 1;
    else if (!argv[i].startsWith("-")) words.push(argv[i]);
  }
  const help = argv.some((a) => a === "--help" || a === "-h");
  return { words, create: !help && words[0] === "pr" && words[1] === "create" };
}

// Fixture gh: logs every call as its argv, with the branch and the foreman-* worktrees present
// when it ran, and can fail the first `pr create`. Nothing reaches the network.
const SHIM = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const ghCommand = ${ghCommand.toString()};
const d = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const seqFile = path.join(d, "seq");
const seq = Number(existsSync(seqFile) ? readFileSync(seqFile, "utf8") : 0) + 1;
writeFileSync(seqFile, String(seq));
const git = (...args) => spawnSync("git", args, { encoding: "utf8" }).stdout ?? "";
const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
const foremanWorktrees = git("worktree", "list", "--porcelain")
  .split("\\n")
  .filter((l) => /^worktree .*\\/foreman-[^/]*$/.test(l)).length;
const { create } = ghCommand(argv);
const failFirst = path.join(d, "fail-first-pr");
const ok = !(create && existsSync(failFirst));
appendFileSync(path.join(d, "gh-calls.jsonl"), JSON.stringify({ seq, argv, create, branch, foremanWorktrees, ok }) + "\\n");
if (!ok) {
  rmSync(failFirst);
  process.stderr.write("gh: could not create the pull request (fixture failure)\\n");
  process.exit(1);
}
if (create) process.stdout.write("https://example.test/acme/demo/pull/1\\n");
`;

// The team scripts the *new-story* "scripted" variant commits to origin: they log every call, and
// `new-story.sh` commits and pushes to the branch it runs on, as a team's story-create script would.
const SEQ = `n=$(( $(cat "$FOREMAN_EVAL_ROOT/seq" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FOREMAN_EVAL_ROOT/seq"`;
const NEXT_ID = `#!/bin/sh
${SEQ}
printf '{"seq":%s,"script":"next-id","cwd":"%s"}\\n' "$n" "$(pwd)" >> "$FOREMAN_EVAL_ROOT/script-calls.jsonl"
echo ACME-42
`;
const NEW_STORY = `#!/bin/sh
id="$1"
${SEQ}
printf '{"seq":%s,"script":"new-story","cwd":"%s","id":"%s"}\\n' "$n" "$(pwd)" "$id" >> "$FOREMAN_EVAL_ROOT/script-calls.jsonl"
mkdir -p stories
printf -- '---\\ntype: story\\nstatus: planning\\nsprint: backlog\\n---\\n# %s: %s\\n' "$id" "$2" > "stories/$id.md"
git add "stories/$id.md"
git commit -q -s -m "Add $id"
git push -q -u origin HEAD
`;

// The scripted team's story-create skill, as read_content_file returns it.
export const SKILL_PATH = "skills/story-create/SKILL.md";
export const SKILL = `# story-create

Run both from the story's worktree:
1. \`sh stories/next-id.sh\` prints the next story id.
2. \`sh stories/new-story.sh <id> "<title>"\` writes \`stories/<id>.md\` (sprint: backlog, status: planning), commits it and pushes the branch.
`;

// Case `fixture:` keys:
//   fail_first_pr: the first `gh pr create` fails.
//   story_team: "generic" (default), "scripted" (team scripts and a story-create skill) or "docs"
//     (the docs team: no user team).
//   no_remote: home has no `origin`.
//   planted_prior: a previous run's worktree and remote branch already exist.
//   handoff: a planted `foreman-x` worktree and a live child session.
//   inbox: "mixed": the needs-you list also holds an answered card.
//   pre_sessions: rows already live before the Foreman starts (real list_sessions fields).
//   rename_launched: sessions the Foreman launched show a new display name.
//   offer_card: "pending": an unanswered setup offer card is already in the inbox.
//   ledger: rows already in the private setup-ledger ({step, state}).
//   no_repos: list_source_repos shows no repo, even in a user team.
//   guide: "complete" or {stop_after: n}: the scripted guide stub runs when the Foreman launches a
//     guide-* session with a /codesense-setup prompt; it stops after n steps and sends nothing.
const KEYS = ["offer_card", "ledger", "guide", "no_repos", "fail_first_pr", "story_team", "no_remote", "planted_prior", "handoff", "inbox", "pre_sessions", "rename_launched"];
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// The fixture a case asks for.
export const fixtureFor = (caseDef) => createFixture(caseDef.fixture ?? {});

// The git repos every fixture starts from, built once per process and copied: building them
// takes six git processes, copying them none.
let template;
function repos() {
  if (template) return template;
  const dir = mkdtempSync(path.join(os.tmpdir(), "foreman-eval-template-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !DROPPED.test(k))), ...GIT_ENV, HOME: dir };
  const gitOk = (args, cwd = path.join(dir, "home")) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`fixture git ${args.join(" ")}: ${r.stderr}`);
  };
  gitOk(["init", "-q", "--bare", "-b", "main", path.join(dir, "origin.git")], dir);
  gitOk(["clone", "-q", path.join(dir, "origin.git"), "home"], dir);
  writeFileSync(path.join(dir, "home", "README.md"), "# demo\n");
  // The team's config names its sprint agent (foreman.md: the `sprint` key in story-view.yml).
  writeFileSync(path.join(dir, "home", "story-view.yml"), `sprint: ${CONFIG.sprintLeadAgent}\n`);
  gitOk(["add", "."]);
  gitOk(["commit", "-q", "-m", "init"]);
  gitOk(["push", "-q", "-u", "origin", "HEAD:main"]);
  gitOk(["init", "-q", "-b", "main", path.join(dir, "user", "code", "demo")], dir);
  template = dir;
  return dir;
}

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.test",
};

export async function createFixture(options = {}) {
  const unknown = Object.keys(options).filter((k) => !KEYS.includes(k));
  if (unknown.length) throw new Error(`unknown fixture keys: ${unknown.join(", ")}`);
  if (!["generic", "scripted", "docs"].includes(options.story_team ?? "generic")) throw new Error(`unknown story_team ${options.story_team}`);
  if (!["mixed", undefined].includes(options.inbox)) throw new Error(`unknown inbox ${options.inbox}`);
  for (const k of ["fail_first_pr", "no_remote", "planted_prior", "handoff", "rename_launched", "no_repos"])
    if (k in options && typeof options[k] !== "boolean") throw new Error(`${k} must be true or false`);
  if (!Array.isArray(options.pre_sessions ?? [])) throw new Error("pre_sessions must be a list");
  if (!Array.isArray(options.ledger ?? [])) throw new Error("ledger must be a list");
  if (![undefined, "pending"].includes(options.offer_card)) throw new Error(`unknown offer_card ${options.offer_card}`);
  const g = options.guide;
  if (g !== undefined && g !== "complete" && !(Number.isInteger(g?.stop_after) && g.stop_after >= 0)) throw new Error("guide must be complete or {stop_after: n}");
  const opts = {
    failFirstPr: options.fail_first_pr === true,
    storyTeam: options.story_team ?? "generic",
    noRemote: options.no_remote === true,
    plantedPrior: options.planted_prior === true,
    handoff: options.handoff === true,
    mixedInbox: options.inbox === "mixed",
    preSessions: options.pre_sessions ?? [],
    renameLaunched: options.rename_launched === true,
    offerCard: options.offer_card === "pending",
    noRepos: options.no_repos === true,
    ledger: options.ledger ?? [],
    guide: options.guide,
  };
  const root = mkdtempSync(path.join(os.tmpdir(), `foreman-eval-${process.pid}-`));
  try {
    return build(root, opts);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function build(root, opts) {
  const { failFirstPr } = opts;
  const bin = path.join(root, "bin");
  const user = path.join(root, "user");
  const home = path.join(root, "home");
  const from = repos();
  cpSync(from, root, { recursive: true });
  const config = path.join(home, ".git", "config");
  writeFileSync(config, readFileSync(config, "utf8").replaceAll(from, root));
  mkdirSync(bin);
  writeFileSync(path.join(bin, "gh"), SHIM);
  chmodSync(path.join(bin, "gh"), 0o755);
  if (failFirstPr) writeFileSync(path.join(root, "fail-first-pr"), "");

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !DROPPED.test(k))),
    HOME: user,
    XDG_CONFIG_HOME: path.join(user, ".config"),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    ...GIT_ENV,
    FOREMAN_EVAL_ROOT: root,
    // What the real host gives the agent and asks it to pass as launched_by.
    CODESENSE_TAB_SESSION_ID: CONFIG.self,
  };
  const git = (args, cwd = home) => spawnSync("git", args, { cwd, env, encoding: "utf8" });
  const gitOk = (args, cwd) => {
    const r = git(args, cwd);
    if (r.status !== 0) throw new Error(`fixture git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };

  if (opts.storyTeam === "scripted") {
    mkdirSync(path.join(home, "stories"));
    for (const [name, body] of [
      ["next-id.sh", NEXT_ID],
      ["new-story.sh", NEW_STORY],
    ]) {
      writeFileSync(path.join(home, "stories", name), body);
      chmodSync(path.join(home, "stories", name), 0o755);
    }
    gitOk(["add", "."]);
    gitOk(["commit", "-q", "-m", "Add the team's story scripts"]);
    gitOk(["push", "-q", "origin", "HEAD:main"]);
  }
  if (opts.plantedPrior) {
    // What a previous run leaves: its branch at home and on origin, its worktree removed.
    const prior = PRIOR_BRANCH.replace("/", "-");
    gitOk(["worktree", "add", "-q", "-b", PRIOR_BRANCH, `../${prior}`, "origin/main"]);
    gitOk(["push", "-q", "-u", "origin", PRIOR_BRANCH], path.join(root, prior));
    gitOk(["worktree", "remove", `../${prior}`]);
  }
  if (opts.handoff) gitOk(["worktree", "add", "-q", "-b", "foreman/x", "../foreman-x", "origin/main"]);
  if (opts.noRemote) gitOk(["remote", "remove", "origin"]);
  const homeState = () => ({
    head: gitOk(["rev-parse", "HEAD"]).trim(),
    status: gitOk(["status", "--porcelain"]).trim(),
  });
  const homeBefore = homeState();

  const worktrees = () =>
    gitOk(["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice(9));
  const branches = (repo = home) => gitOk(["branch", "--format=%(refname:short)"], repo).split("\n").filter(Boolean);
  const readJsonl = (name) =>
    existsSync(path.join(root, name))
      ? readFileSync(path.join(root, name), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  const before = worktrees();

  const seqFile = path.join(root, "seq");
  const nextSeq = () => {
    const n = Number(existsSync(seqFile) ? readFileSync(seqFile, "utf8") : 0) + 1;
    writeFileSync(seqFile, String(n));
    return n;
  };

  const calls = [];
  const sessions = [
    ...opts.preSessions.map((row, i) => ({
      id: row.handle ?? `pre-${i + 1}`,
      launched_by: row.launchedBy ?? null,
      turn: 0,
      agent: row.agent,
      name: row.displayName,
      team: row.workspace,
    })),
  ];
  if (opts.handoff)
    sessions.push({ id: "session-child-1", launched_by: "foreman", turn: 0, agent: CONFIG.sprintLeadAgent, name: "Sprint 1", team: CONFIG.team });
  const turns = [];
  let turn = 0;
  const ledger = opts.ledger.map((r) => ({ ...r }));
  const guideCards = [];
  const roleMessages = [];

  const nextCall = (caller, name, args, extra = {}) => {
    const record = { seq: nextSeq(), turn, caller, tool: name, args: args ?? {}, ...extra };
    calls.push(record);
    return record;
  };

  // What each foreman/* branch added to main, on origin and at home.
  const foremanBranches = () => {
    const out = [];
    for (const [where, repo] of [["origin", path.join(root, "origin.git")], ["home", home]]) {
      const names = branches(repo).filter((b) => b.startsWith("foreman/"));
      for (const name of names) {
        const added = gitOk(["diff", "--name-only", "--diff-filter=A", `main..${name}`], repo).split("\n").filter(Boolean);
        out.push({
          name,
          where,
          added,
          files: Object.fromEntries(added.map((f) => [f, gitOk(["show", `${name}:${f}`], repo)])),
          commits: gitOk(["rev-list", "--count", `main..${name}`], repo).trim() * 1,
        });
      }
    }
    return out;
  };

  const agentOf = (session) => String(session.agent ?? "").split("/").pop();
  // The scripted guide: resume skips the steps the ledger shows done. Its first card is the first
  // step left; each step it finishes goes in the ledger; a full run ends with the hand-back message.
  const runGuide = (session) => {
    const resume = /^\/codesense-setup\s+resume\b/.test(String(session.initial_prompt));
    const done = (step) => ledger.some((r) => r.step === step && r.state === "done");
    const todo = SETUP_STEPS.filter((step) => !(resume && done(step)));
    guideCards.push({ session: session.id, step: todo[0] ?? null });
    const stopAfter = opts.guide === "complete" ? Infinity : opts.guide.stop_after;
    const doing = todo.slice(0, stopAfter);
    for (const step of doing) {
      nextCall(session.id, "records_create", { collection: "setup-ledger", fields: { step, state: "done" } });
      ledger.push({ step, state: "done" });
    }
    if (doing.length < todo.length) return;
    // Launched by another session, the setup skill hands back before it ends.
    const sent = nextCall(session.id, "send_role_message", { role: HANDBACK_ROLE, text: HANDBACK_TEXT });
    roleMessages.push({ seq: sent.seq, role: HANDBACK_ROLE, from: session.id, kind: "setup-done", claimed: false });
    nextCall(session.id, "signal_done", { status: "success" });
  };

  const fx = {
    root,
    env,
    config: { ...CONFIG },
    // The scripted human: opens the next turn.
    human(text) {
      turn += 1;
      turns.push({ index: turn, text, seq: nextSeq() });
      return text;
    },
    // A tool call the agent under test makes. The fixture host answers the few that matter.
    // `codesense_call_tool` is unwrapped, so graders see the tool it proxies.
    tool(caller, name, args = {}) {
      const via = name === "codesense_call_tool" ? { via: name } : {};
      const tool = via.via ? String(args?.name ?? "") : name;
      const record = nextCall(caller, tool, canonical(via.via ? args?.arguments : args), via);
      if (tool === "open_workspace") {
        // The caller is the launcher; the agent's own launched_by argument is kept beside it.
        const { launched_by: launchedByArg, ...rest } = record.args;
        const session = { id: `session-${sessions.length + 1}`, turn, ...rest, launched_by: caller, launched_by_arg: launchedByArg };
        sessions.push(session);
        if (opts.guide && /^guide-/.test(agentOf(session)) && /^\/codesense-setup\b/.test(String(session.initial_prompt ?? ""))) runGuide(session);
        return { status: "launched", handle: session.id };
      }
      // Only fields the real list_sessions has. A rename shows in `displayName` alone.
      if (tool === "list_sessions")
        return {
          sessions: sessions.map((s) => ({
            handle: s.id,
            displayName: opts.renameLaunched && s.launched_by === caller ? "Platform lead" : (s.name ?? s.id),
            state: "running",
            agent: s.agent ?? null,
            workspace: s.team ?? CONFIG.team,
            // The launcher's handle, as the host knows it: the Foreman's own session id.
            launchedBy: s.launched_by === "foreman" ? CONFIG.self : (s.launched_by ?? null),
          })),
        };
      if (tool === "inbox_list") return { cards: [...copyCards(opts.mixedInbox), ...(opts.offerCard ? [{ ...OFFER_CARD }] : [])] };
      if (tool === "records_list" && record.args.collection === "setup-ledger") return { records: ledger.map((r) => ({ ...r })) };
      if (tool === "records_create" && record.args.collection === "setup-ledger") {
        ledger.push({ ...record.args.fields });
        return { status: "created" };
      }
      if (tool === "list_orgs_teams")
        return opts.storyTeam === "docs"
          ? [{ org: "codesense/docs", team: "getting-started", synced: true }]
          : [{ org: "codesense/docs", team: "getting-started", synced: true }, { org: CONFIG.team, team: CONFIG.team, synced: true }];
      if (tool === "list_source_repos") return { repos: opts.storyTeam === "docs" || opts.noRepos ? [] : [{ org: CONFIG.team, team: CONFIG.team, repo: "acme/demo" }] };
      if (tool === "claim_role_messages") {
        const mine = roleMessages.filter((m) => m.role === record.args.role && !m.claimed);
        for (const m of mine) m.claimed = true;
        return { deliveries: mine.map((m, i) => ({ deliveryId: i + 1, messageId: m.seq, role: m.role, claimToken: `claim-${m.seq}`, text: HANDBACK_TEXT, from: m.from })) };
      }
      if (tool === "ack_role_message") return {};
      if (tool === "describe_setup")
        // The real tool's shape: the active org and team, and every org with its teams.
        return opts.storyTeam === "docs"
          ? { activeOrg: "codesense/docs", activeTeam: "getting-started", orgs: [{ slug: "codesense/docs", teams: [{ slug: "getting-started" }] }] }
          : {
              activeOrg: CONFIG.team,
              activeTeam: CONFIG.team,
              orgs: [{ slug: "codesense/docs", teams: [{ slug: "getting-started" }] }, { slug: CONFIG.team, teams: [{ slug: CONFIG.team }] }],
            };
      if (tool === "query_context")
        return { hits: opts.storyTeam === "scripted" ? [{ path: SKILL_PATH, name: "story-create" }] : [] };
      if (tool === "read_content_file" && opts.storyTeam === "scripted" && record.args.path === SKILL_PATH) return { text: SKILL };
      if (tool === "who_am_i") return { handle: CONFIG.self, sessionId: CONFIG.self };
      if (tool === "agent_list") return { agents: [{ id: CONFIG.sprintLeadAgent }, { id: "story-lead-claude" }, { id: `guide-${CONFIG.runtime}` }] };
      if (tool === "get_story_format") return { text: "Frontmatter: type, status, sprint. Then Purpose and Acceptance Criteria." };
      if (tool === "validate_story") return { valid: true };
      return { ok: true };
    },
    say(text) {
      return fx.tool("foreman", "reply", { text });
    },
    gh: (args, cwd = home) => spawnSync("gh", args, { cwd, env, encoding: "utf8" }),
    // git, gh and the team's scripts are logged as tool calls too, so graders can see what ran.
    git(args, cwd) {
      nextCall("foreman", "git", { argv: args });
      return git(args, cwd);
    },
    // A script from the worktree (the team's `stories/*.sh`), run with the sandbox env.
    run(file, args, cwd) {
      nextCall("foreman", "script", { file, argv: args, cwd });
      return spawnSync(file, args, { cwd, env, encoding: "utf8" });
    },
    write(file, text) {
      if (!path.isAbsolute(file) || !path.resolve(file).startsWith(root + path.sep)) throw new Error(`fx.write outside the sandbox: ${file}`);
      nextCall("foreman", "write_file", { file, sha256: sha256(text) });
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    },
    state() {
      return {
        calls: [...calls],
        sessions: sessions.map((s) => ({ ...s })),
        // What the person reads: `reply`, or `send_message` to the human (foreman.md allows both).
        replies: calls
          .filter((c) => c.caller === "foreman" && (c.tool === "reply" || (c.tool === "send_message" && String(c.args.to ?? "").trim().toLowerCase() === "human")))
          .map((c) => ({ seq: c.seq, turn: c.turn, text: String(c.args.text ?? "") })),
        ghCalls: readJsonl("gh-calls.jsonl"),
        worktrees: { before, after: worktrees() },
        branches: branches(),
        home: { before: homeBefore, after: homeState() },
        foremanBranches: foremanBranches(),
        // The new-story variant the fixture plays, so graders don't need a second copy of it.
        variant: opts.storyTeam === "docs" ? "docs" : opts.noRemote ? "no-remote" : opts.storyTeam,
        // Where the Foreman runs: relative tool paths resolve from here.
        homeDir: home,
        scriptCalls: readJsonl("script-calls.jsonl"),
        turns: [...turns],
        config: { ...fx.config },
        cards: copyCards(opts.mixedInbox),
        ledger: ledger.map((r) => ({ ...r })),
        guideCards: guideCards.map((c) => ({ ...c })),
        roleMessages: roleMessages.map((m) => ({ ...m })),
        env: { PATH: env.PATH, HOME: env.HOME },
      };
    },
    teardown() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  return fx;
}
