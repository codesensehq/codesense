// SPDX-License-Identifier: MIT
// The eval sandbox: a temp dir with a local bare `origin`, a home clone, a `gh` shim first on PATH
// and a log of every tool call the agent under test makes. HOME points inside the sandbox and
// credential variables are dropped, so no real GitHub and no credentials. One sequence counter
// orders tool calls and `gh` calls, so graders can tell what came first.
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
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

export const CONFIG = { team: "acme", sprintLeadAgent: "sprint-lead-claude", repo: "~/code/demo" };

export const CARDS = [
  {
    id: "card-1",
    story: "ACME-7",
    from: "acme-7-lead",
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

// Dropped from the sandbox env: anything that could reach a real account.
const CREDENTIAL = /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|^GH_|^GITHUB_|^SSH_AUTH_SOCK$/i;

const SHIM = `#!/bin/sh
# Fixture gh: records \`pr create\` and can fail the first one. Nothing else reaches the network.
d="$(dirname "$0")/.."
if [ "$1" = pr ] && [ "$2" = create ]; then
  n=$(( $(cat "$d/seq" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$d/seq"
  args="$(printf %s "$*" | tr -d '"\\\\' | tr '\\n\\t\\r' '   ' | tr -d '\\000-\\037')"
  ok=true
  [ -f "$d/fail-first-pr" ] && ok=false
  printf '{"seq":%s,"args":"%s","ok":%s}\\n' "$n" "$args" "$ok" >> "$d/gh-calls.jsonl"
  if [ "$ok" = false ]; then
    rm "$d/fail-first-pr"
    echo "gh: could not create the pull request (fixture failure)" >&2
    exit 1
  fi
  echo "https://example.test/acme/demo/pull/1"
fi
exit 0
`;

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
  mkdirSync(bin);
  mkdirSync(path.join(user, "code", "demo"), { recursive: true });
  writeFileSync(path.join(bin, "gh"), SHIM);
  chmodSync(path.join(bin, "gh"), 0o755);
  if (failFirstPr) writeFileSync(path.join(root, "fail-first-pr"), "");

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !CREDENTIAL.test(k))),
    HOME: user,
    XDG_CONFIG_HOME: path.join(user, ".config"),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  };
  const home = path.join(root, "home");
  const git = (args, cwd = home) => spawnSync("git", args, { cwd, env, encoding: "utf8" });
  const gitOk = (args, cwd) => {
    const r = git(args, cwd);
    if (r.status !== 0) throw new Error(`fixture git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  execFileSync("git", ["init", "--bare", "-b", "main", path.join(root, "origin.git")], { env, stdio: "ignore" });
  gitOk(["clone", path.join(root, "origin.git"), home], root);
  writeFileSync(path.join(home, "README.md"), "# demo\n");
  gitOk(["add", "."]);
  gitOk(["commit", "-m", "init"]);
  gitOk(["push", "-u", "origin", "HEAD:main"]);
  gitOk(["init", "-b", "main", path.join(user, "code", "demo")], root);

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
  const logFile = path.join(root, "calls.jsonl");

  const fx = {
    root,
    env,
    config: { ...CONFIG, repoPath: path.join(user, "code", "demo") },
    // The scripted human: opens the next turn.
    human(text) {
      turn += 1;
      turns.push({ index: turn, text });
      return text;
    },
    // A tool call the agent under test makes. The fixture host answers the few that matter.
    tool(caller, name, args = {}) {
      const record = { seq: nextSeq(), turn, caller, tool: name, args: args ?? {} };
      calls.push(record);
      appendFileSync(logFile, `${JSON.stringify(record)}\n`);
      if (name === "open_workspace") {
        const session = { id: `session-${sessions.length + 1}`, launched_by: caller, turn, ...record.args };
        sessions.push(session);
        return { status: "launched", handle: session.id };
      }
      if (name === "list_sessions") return { sessions: sessions.map((s) => ({ ...s })) };
      if (name === "inbox_list") return { cards: copyCards() };
      return { ok: true };
    },
    say(text) {
      return fx.tool("foreman", "reply", { text });
    },
    gh: (args, cwd = home) => spawnSync("gh", args, { cwd, env, encoding: "utf8" }),
    git: (args, cwd) => git(args, cwd),
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
        replies: calls
          .filter((c) => c.tool === "reply")
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
