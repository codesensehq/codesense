// SPDX-License-Identifier: MIT
// The eval sandbox: a temp dir with a local bare `origin`, a home clone, a `gh` shim first on PATH
// and a log of every tool call the agent under test makes. No real GitHub, no credentials.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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

const SHIM = `#!/bin/sh
# Fixture gh: records \`pr create\` and can fail the first one. Nothing else reaches the network.
d="$(dirname "$0")/.."
if [ "$1" = pr ] && [ "$2" = create ]; then
  args="$(printf %s "$*" | tr -d '"\\\\')"
  if [ -f "$d/fail-first-pr" ]; then
    rm "$d/fail-first-pr"
    printf '{"args":"%s","ok":false}\\n' "$args" >> "$d/gh-calls.jsonl"
    echo "gh: could not create the pull request (fixture failure)" >&2
    exit 1
  fi
  printf '{"args":"%s","ok":true}\\n' "$args" >> "$d/gh-calls.jsonl"
  echo "https://example.test/acme/demo/pull/1"
fi
exit 0
`;

export async function createFixture({ failFirstPr = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "foreman-eval-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "gh"), SHIM);
  chmodSync(path.join(bin, "gh"), 0o755);
  if (failFirstPr) writeFileSync(path.join(root, "fail-first-pr"), "");

  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  };
  const git = (args, cwd = path.join(root, "home")) => spawnSync("git", args, { cwd, env, encoding: "utf8" });
  const gitOk = (args, cwd) => {
    const r = git(args, cwd);
    if (r.status !== 0) throw new Error(`fixture git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  execFileSync("git", ["init", "--bare", "-b", "main", path.join(root, "origin.git")], { env, stdio: "ignore" });
  gitOk(["clone", path.join(root, "origin.git"), path.join(root, "home")], root);
  writeFileSync(path.join(root, "home", "README.md"), "# demo\n");
  gitOk(["add", "."]);
  gitOk(["commit", "-m", "init"]);
  gitOk(["push", "-u", "origin", "HEAD:main"]);

  const worktrees = () =>
    gitOk(["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice(9));
  const before = worktrees();

  const calls = [];
  const sessions = [];
  const turns = [];
  let turn = 0;
  const logFile = path.join(root, "calls.jsonl");

  const fx = {
    root,
    env,
    // The scripted human: opens the next turn.
    human(text) {
      turn += 1;
      turns.push({ index: turn, text });
      return text;
    },
    // A tool call the agent under test makes. The fixture host answers the few that matter.
    tool(caller, name, args = {}) {
      const record = { turn, caller, tool: name, args };
      calls.push(record);
      appendFileSync(logFile, `${JSON.stringify(record)}\n`);
      if (name === "open_workspace") {
        const session = { id: `session-${sessions.length + 1}`, launched_by: caller, turn, ...args };
        sessions.push(session);
        return { status: "launched", handle: session.id };
      }
      if (name === "list_sessions") return { sessions: sessions.map((s) => ({ ...s })) };
      if (name === "inbox_list") return { cards: CARDS };
      return { ok: true };
    },
    say(text) {
      return fx.tool("foreman", "reply", { text });
    },
    gh: (args) => spawnSync("gh", args, { cwd: path.join(root, "home"), env, encoding: "utf8" }),
    git: (args) => git(args),
    state() {
      const ghFile = path.join(root, "gh-calls.jsonl");
      const ghCalls = existsSync(ghFile)
        ? readFileSync(ghFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [];
      return {
        calls: [...calls],
        sessions: sessions.map((s) => ({ ...s })),
        replies: calls.filter((c) => c.tool === "reply").map((c) => ({ turn: c.turn, text: c.args.text })),
        ghCalls,
        worktrees: { before, after: worktrees() },
        turns: [...turns],
        config: CONFIG,
        cards: CARDS,
        env: { PATH: env.PATH },
      };
    },
    teardown() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  return fx;
}
