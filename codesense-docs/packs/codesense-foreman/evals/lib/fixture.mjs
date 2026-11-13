// SPDX-License-Identifier: MIT
// The eval sandbox: a temp dir with a local bare `origin`, a home clone, a `gh` shim first on PATH
// and a record of every tool call the agent under test makes. HOME points inside the sandbox and
// credential variables are dropped, so no real GitHub and no credentials. One sequence counter
// orders tool calls and `gh` calls, so graders can tell what came first.
import { spawnSync } from "node:child_process";
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
const copyCards = () => JSON.parse(JSON.stringify(CARDS));

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

// The fixture a case asks for.
export const fixtureFor = (caseDef) => createFixture({ failFirstPr: caseDef.fixture?.fail_first_pr === true });

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

export async function createFixture({ failFirstPr = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "foreman-eval-"));
  try {
    return build(root, failFirstPr);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function build(root, failFirstPr) {
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
    // What the real host gives the agent and asks it to pass as launched_by.
    CODESENSE_TAB_SESSION_ID: CONFIG.self,
  };
  const git = (args, cwd = home) => spawnSync("git", args, { cwd, env, encoding: "utf8" });
  const gitOk = (args, cwd) => {
    const r = git(args, cwd);
    if (r.status !== 0) throw new Error(`fixture git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };

  const worktrees = () =>
    gitOk(["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice(9));
  const branches = () => gitOk(["branch", "--format=%(refname:short)"]).split("\n").filter(Boolean);
  const before = worktrees();

  const seqFile = path.join(root, "seq");
  const nextSeq = () => {
    const n = Number(existsSync(seqFile) ? readFileSync(seqFile, "utf8") : 0) + 1;
    writeFileSync(seqFile, String(n));
    return n;
  };

  const calls = [];
  const sessions = [];
  const turns = [];
  let turn = 0;

  const fx = {
    root,
    env,
    config: { ...CONFIG },
    // The scripted human: opens the next turn.
    human(text) {
      turn += 1;
      turns.push({ index: turn, text });
      return text;
    },
    // A tool call the agent under test makes. The fixture host answers the few that matter.
    // `codesense_call_tool` is unwrapped, so graders see the tool it proxies.
    tool(caller, name, args = {}) {
      const proxied = name === "codesense_call_tool";
      const tool = proxied ? String(args?.name ?? "") : name;
      const record = { seq: nextSeq(), turn, caller, tool, args: canonical(proxied ? args?.arguments : args), ...(proxied && { via: name }) };
      calls.push(record);
      if (tool === "open_workspace") {
        // The caller is the launcher; the agent's own launched_by argument is kept beside it.
        const { launched_by: launchedByArg, ...rest } = record.args;
        const session = { id: `session-${sessions.length + 1}`, turn, ...rest, launched_by: caller, launched_by_arg: launchedByArg };
        sessions.push(session);
        return { status: "launched", handle: session.id };
      }
      if (tool === "list_sessions") return { sessions: sessions.map((s) => ({ ...s })) };
      if (tool === "inbox_list") return { cards: copyCards() };
      return { ok: true };
    },
    say(text) {
      return fx.tool("foreman", "reply", { text });
    },
    gh: (args, cwd = home) => spawnSync("gh", args, { cwd, env, encoding: "utf8" }),
    git,
    state() {
      const ghFile = path.join(root, "gh-calls.jsonl");
      const ghCalls = existsSync(ghFile)
        ? readFileSync(ghFile, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];
      return {
        calls: [...calls],
        sessions: sessions.map((s) => ({ ...s })),
        // What the person reads: `reply`, or `send_message` to the human (foreman.md allows both).
        replies: calls
          .filter((c) => c.caller === "foreman" && (c.tool === "reply" || (c.tool === "send_message" && String(c.args.to ?? "").trim().toLowerCase() === "human")))
          .map((c) => ({ seq: c.seq, turn: c.turn, text: String(c.args.text ?? "") })),
        ghCalls,
        worktrees: { before, after: worktrees() },
        branches: branches(),
        turns: [...turns],
        config: { ...fx.config },
        cards: copyCards(),
        env: { PATH: env.PATH, HOME: env.HOME },
      };
    },
    teardown() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  return fx;
}
