// SPDX-License-Identifier: MIT
// Model-free checks on the Foreman pack: the root prompt, the saved agent's tool and write rules,
// and the settings that keep the team's own skills and instructions out of its first call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const pack = new URL("../codesense-docs/packs/codesense-foreman/", import.meta.url);
const text = (rel) => readFileSync(new URL(rel, pack), "utf8");
const spec = text("foreman.md");
const agent = parse(text("agents/foreman-claude/agent.yaml"));
const allow = agent.permissions.claude.allow;
const deny = agent.permissions.claude.deny;

const TOOLS = [
  // reads
  "who_am_i",
  "read_messages",
  "session_read",
  "claim_role_messages",
  "ack_role_message",
  "codesense_overview",
  "describe_setup",
  "list_orgs_teams",
  "list_source_repos",
  "query_context",
  "read_content_file",
  "list_sessions",
  "session_usage",
  "inbox_list",
  "list_machines",
  "routine_list",
  "records_list",
  "agent_list",
  "get_story_format",
  "validate_story",
  // chat
  "reply",
  "send_message",
  "signal_progress",
  "signal_done",
  // records (the private setup-ledger only, by instruction) and launch
  "records_create",
  "open_workspace",
];
const FORBIDDEN = [
  "schedule_wakeup",
  "routine_create",
  "run_in_terminal_tab",
  "create_team",
  "delete_team",
  "archive_team",
  "add_source_repo",
  "remove_source_repo",
  "attach_context_repository",
  "detach_context_repository",
  "create_local_organization",
];
const mcp = (name) => `mcp__codesense__${name}`;

// Calibrated on the real tokenizer: `claude -p` on Opus 5.5 with and without foreman.md as the
// system prompt (2026-11-13) counted 1,368 tokens for 3,756 bytes and 1,986 for 5,347, about
// 2.69 bytes a token. Four bytes a token undercounted by a third.
const BYTES_PER_TOKEN = 2.65;
const tokens = (s) => Math.ceil(Buffer.byteLength(s) / BYTES_PER_TOKEN);
// 2k until the setup rules (offer, resume, hand-back) went in; flagged in that PR.
const ROOT_CAP = 2200;

test("the root prompt is the spec, under 2.2k tokens, passed as the agent's system prompt", () => {
  const at = agent.args.indexOf("--append-system-prompt");
  assert.ok(at >= 0, "the saved agent appends its root prompt");
  assert.equal(
    agent.args[at + 1],
    spec,
    "copy foreman.md into agent.yaml's --append-system-prompt",
  );
  assert.ok(tokens(spec) <= ROOT_CAP, `${tokens(spec)} tokens`);
  // A startup file would be the team's own CLAUDE.md, never this pack's.
  assert.ok(!agent.startup?.length, "no startup file");
  assert.ok(!existsSync(new URL("agents/foreman-claude/CLAUDE.md", pack)));
});

test("the agent allows exactly the Foreman's tools and refuses the rest", () => {
  assert.equal(agent.permissions.claude.defaultMode, "dontAsk", "anything not allowed is refused");
  for (const rule of allow) {
    assert.ok(/^(mcp__codesense__|Bash\(|(Read|Edit|Write)\(\.\.\/foreman-)/.test(rule), rule);
  }
  const tools = allow.filter((rule) => rule.startsWith("mcp__")).sort();
  assert.deepEqual(tools, TOOLS.map(mcp).sort());
  for (const name of FORBIDDEN) {
    assert.ok(deny.includes(mcp(name)), `${name} is denied`);
    assert.ok(!allow.includes(mcp(name)), `${name} is not allowed`);
  }
});

test("the Foreman claims its mail on the codesense-foreman queue, never foreman", () => {
  assert.equal(agent.role, "codesense-foreman");
  assert.equal(agent.runtime, "claude");
});

test("every tool the spec names is allowed or forbidden", () => {
  const named = [...spec.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]);
  assert.ok(named.length > 20);
  for (const name of new Set(named)) {
    assert.ok(TOOLS.includes(name) || FORBIDDEN.includes(name), `${name} is neither`);
  }
  for (const name of FORBIDDEN)
    assert.ok(spec.includes(`\`${name}\``), `${name} is listed as unavailable`);
});

// A Claude path rule: `Tool(glob)`, the glob relative to the session's working directory.
function ruleMatches(cwd, target, tool) {
  return (rule) => {
    const m = /^(Edit|Write|NotebookEdit)\((.*)\)$/.exec(rule);
    if (!m || m[1] !== tool) return false;
    const glob = path.resolve(cwd, m[2]).replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const re = glob
      .replace(/\*\*/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\u0000/g, ".*");
    return new RegExp(`^${re}$`).test(target);
  };
}
const TOOLS_THAT_WRITE = ["Edit", "Write", "NotebookEdit"];
const writeDenied = (cwd, target) =>
  TOOLS_THAT_WRITE.every((tool) => deny.some(ruleMatches(cwd, target, tool)));
const writeAllowed = (cwd, target) =>
  TOOLS_THAT_WRITE.slice(0, 2).every(
    (tool) =>
      !deny.some(ruleMatches(cwd, target, tool)) && allow.some(ruleMatches(cwd, target, tool)),
  );

test("edits are denied in the home worktree and allowed in a foreman-* worktree, in two layouts", () => {
  for (const home of ["/work/acme-docs/home", "/work/acme-user/home"]) {
    const sibling = path.resolve(home, "../foreman-fix-docs-9f2a");
    assert.equal(
      writeDenied(home, path.join(home, "README.md")),
      true,
      `${home} is denied outright`,
    );
    assert.equal(writeAllowed(home, path.join(home, "README.md")), false, `${home} is read-only`);
    assert.equal(writeAllowed(home, path.join(home, "stories/a.md")), false);
    assert.equal(
      writeAllowed(home, path.join(sibling, "stories/a.md")),
      true,
      "a foreman-* worktree",
    );
    assert.equal(writeAllowed(home, path.resolve(home, "../other-worktree/a.md")), false);
    assert.equal(writeAllowed(home, path.join(sibling, ".git")), false, "no git internals");
  }
});

// Claude's Bash rules, as a live `claude -p` probe (Claude Code 2.1.296, dontAsk, 2026-11-13)
// showed them: `prefix:*` is a literal prefix (its other `*` stays literal); otherwise any `*`
// matches any run of characters, spaces included, but a trailing ` *` needs one more word;
// otherwise the rule is exact.
function bashMatches(rule, command) {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m) return false;
  const body = m[1];
  const cmd = command.trim();
  const prefix = /^(.+):\*$/.exec(body);
  if (prefix) return cmd === prefix[1] || cmd.startsWith(`${prefix[1]} `);
  if (!body.includes("*")) return cmd === body;
  const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const re = body.split("*").map(escape).join(".*");
  return new RegExp(`^${re}$`, "s").test(cmd);
}

// Claude splits a command on unquoted `&&`, `||`, `;`, `|` and `&` and checks each part on
// its own. A substitution or redirection is never allowed by a rule. A `cd` runs only into a
// working directory: home, or one the saved agent adds with `--add-dir` (relative to home).
const HOME = "/work/acme/home";
const workDirs = () => {
  const dirs = [HOME];
  agent.args.forEach(
    (a, i) => a === "--add-dir" && dirs.push(path.resolve(HOME, agent.args[i + 1])),
  );
  return dirs;
};
function parts(command) {
  const out = [""];
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    // A backslash keeps the next character, outside quotes and inside double quotes.
    if (c === "\\" && quote !== "'") {
      out[out.length - 1] += c + (command[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && (c === "`" || (c === "$" && command[i + 1] === "("))) return null;
      out[out.length - 1] += c;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "`" || c === ">" || c === "<" || (c === "$" && command[i + 1] === "("))
      return null;
    else if (c === ";" || c === "|" || c === "&" || c === "\n") {
      if (command[i + 1] === c) i += 1;
      out.push("");
      continue;
    }
    out[out.length - 1] += c;
  }
  return quote ? null : out.map((p) => p.trim());
}
const partRuns = (part) => {
  const cd = /^cd (\S+)$/.exec(part);
  // A quoted, `~`, `$` or `-` path is not resolved here, so it is not a working directory.
  if (cd && /["'~$`\\]|^-$/.test(cd[1])) return false;
  if (cd) {
    const to = path.resolve(HOME, cd[1]);
    return workDirs().some((d) => to === d || to.startsWith(`${d}/`));
  }
  return (
    allow.some((rule) => bashMatches(rule, part)) && !deny.some((rule) => bashMatches(rule, part))
  );
};
const runs = (command) => {
  const list = parts(command);
  return list !== null && list.every((p) => p && partRuns(p));
};

test("no Bash rule ends in :*, which Claude reads as a literal prefix", () => {
  for (const rule of [...allow, ...deny].filter((r) => r.startsWith("Bash("))) {
    assert.ok(!rule.endsWith(":*)"), rule);
  }
});

test("git and gh run only in the home update, foreman-* worktrees and foreman/* branches", () => {
  const wt = "../foreman-fix-docs-9f2a";
  const branch = "foreman/fix-docs-9f2a";
  for (const command of [
    "git fetch",
    "git fetch origin",
    "git merge --ff-only origin/main",
    "git worktree list",
    "git remote",
    `git worktree add -b ${branch} ${wt} origin/main`,
    "git worktree add -b foreman/a.b-1f2e ../foreman-a.b-1f2e main",
    `git -C ${wt} status`,
    `git -C ${wt} diff`,
    `git -C ${wt} diff stories/a.md`,
    `git -C ${wt} log --oneline -5`,
    `git -C ${wt} add stories/a.md stories/b.md`,
    `git -C ${wt} commit -s -F ${wt}.msg`,
    `git -C ${wt} push -u origin ${branch}`,
    `gh pr create --head ${branch} --title "Add the docs story" --body "Adds a + b: see stories/a.md -f"`,
    `git worktree remove ${wt}`,
  ]) {
    assert.ok(runs(command), `runs: ${command}`);
  }
  for (const command of [
    // Another subcommand or another repo slipped in before an allowed word.
    `git -C ${wt} config core.hooksPath /tmp/h status`,
    `git -C ${wt} reset --hard origin/main log`,
    `git -C ${wt} -C ../home commit -s -F ${wt}.msg`,
    `git -C ${wt} --git-dir=../home/.git add a`,
    `git -C ${wt} -c core.hooksPath=/tmp/h commit -s -F ${wt}.msg`,
    `git -C ${wt}/../home add README.md`,
    // Any other ref, force or extra refspec on push.
    `git -C ${wt} push -u origin ${branch} main`,
    `git -C ${wt} push -u origin ${branch} -d main`,
    `git -C ${wt} push -u origin ${branch}:main`,
    `git -C ${wt} push -u origin ${branch}:refs/heads/main`,
    `git -C ${wt} push -u origin +${branch}`,
    `git -C ${wt} push -u origin ${branch} --force`,
    `git -C ${wt} push -u origin ${branch} --all`,
    `git -C ${wt} push -u origin ${branch} --no-verify`,
    "git push origin main",
    // Writes, hooks and history through allowed commands.
    `git -C ${wt} diff --output=../home/CLAUDE.md`,
    `git -C ${wt} log --output=/tmp/x`,
    `git -C ${wt} diff --ext-diff`,
    `git -C ${wt} commit -s -F ${wt}.msg --no-verify`,
    `git -C ${wt} commit -s -F ${wt}.msg --amend`,
    `git -C ${wt} commit -s -F ${wt}.msg --author=x`,
    `git -C ${wt} commit -s -m "x"`,
    // Home, other worktrees, fetch and merge forms.
    "git remote add evil git@example.test:x/y.git",
    "git remote set-url origin /tmp/x",
    "git remote -v",
    "git merge --ff-only foreman/x",
    "git merge --ff-only main",
    "git fetch --upload-pack=/tmp/x origin",
    "git worktree remove ../story-lead-worktree",
    `git worktree remove ${wt} ../story-lead-worktree`,
    `git worktree remove --force ${wt}`,
    `git worktree add -b ${branch} ${wt} origin/main ../home`,
    `git worktree add -b ${branch} -f ${wt} origin/main`,
    // gh beyond one pull request from a foreman branch.
    `gh pr create --head ${branch} --repo other/repo --title t --body b`,
    `gh pr create --head ${branch} --title t --body-file /etc/hosts`,
    `gh pr create --head ${branch} --title t --body b --web`,
    "gh pr create --fill",
    "gh pr merge 1",
    "gh api repos/x/y",
    `${wt}/stories/next-id.sh`,
    "rm -rf ../home",
  ]) {
    assert.ok(!runs(command), `refused: ${command}`);
  }
});

test("the team's own skills and instructions stay out of the first call", () => {
  // The fixture team holds every project file that would add tokens.
  const fixture = [".claude/skills/x/SKILL.md", ".claude/commands/y.md", "CLAUDE.md", "AGENTS.md"];
  assert.deepEqual(agent.context, [], "no context entry stages a fixture file");
  assert.equal(
    fixture.filter((file) => (agent.context ?? []).some((e) => file.startsWith(e))).length,
    0,
  );
  const at = agent.args.indexOf("--setting-sources");
  assert.ok(at >= 0, "the saved agent sets its setting sources");
  const sources = agent.args[at + 1].split(",");
  assert.ok(!sources.includes("project"), "project settings and skills are off");
  assert.equal(agent.env.MAX_MCP_OUTPUT_TOKENS, "8000");
  assert.equal(agent.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.ok(!existsSync(new URL("skills/", pack)), "the pack carries no skills");
});

test("it launches Opus 5.5 by default with Sonnet 5.5 as the cheaper setting", () => {
  assert.deepEqual(agent.args.slice(0, 2), ["--model", "claude-opus-5-5"]);
  const variants = parse(text("variants.yml"));
  assert.equal(variants.agent, "foreman-claude");
  assert.deepEqual(
    variants.models.map((m) => m.model),
    ["claude-opus-5-5", "claude-sonnet-5-5"],
  );
});

test("the spec carries the home, handoff, wake and layer rules", () => {
  for (const phrase of [
    "git fetch",
    "git merge --ff-only origin/main",
    "never reset, commit or merge",
    "Working from <sha>, couldn't update: <reason>",
    "foreman-<slug>-<4 hex>",
    "git worktree remove",
    "Foreman handoff:",
    "at most 12 lines",
    "120k context",
    "You never relaunch yourself",
    "You set no timers",
    "I don't set timers.",
    "never launch a story lead or a specialist",
    "never answer a needs-you card for the person",
    "no lead for that sprint is live on any machine",
    "one Foreman per Mac",
  ]) {
    assert.ok(spec.includes(phrase), `the spec says: ${phrase}`);
  }
});

test("pack.yml lists the agent and leaves the spec hash to the pack build", () => {
  const manifest = parse(text("pack.yml"));
  assert.equal(manifest.id, "codesense-foreman");
  assert.deepEqual(
    manifest.parts.map((p) => p.id),
    ["foreman-claude"],
  );
  assert.equal(manifest.spec_hash["foreman-claude"], null);
});

// ---- the behaviours -----------------------------------------------------------

test("a reminder gets the no-timers answer and no offer of a routine the Foreman can't create", () => {
  assert.ok(!/create a routine/i.test(spec), "no routine offer while routine_create is denied");
  assert.ok(deny.includes(mcp("routine_create")));
});

test("the spec says what the Foreman may run, and to stop when a command is refused", () => {
  for (const phrase of [
    "You may run only these forms",
    "anything else is refused",
    "say so and stop",
    "never look for a spelling that passes",
    "`git remote`",
  ]) {
    assert.ok(spec.includes(phrase), `the spec says: ${phrase}`);
  }
  assert.ok(
    !spec.includes("These exact forms"),
    "the envelope is described as it is, not as exact",
  );
  assert.ok(allow.includes("Bash(git remote)"));
});

test("stories: confirm in one card, then a foreman-* worktree and a PR, or the no-remote exception", () => {
  for (const phrase of [
    "Make a story for",
    "docs team",
    "stories live in a team",
    "offer setup",
    "Create · Change · Not now",
    "`git remote`",
    "`git worktree list`",
    "`story-create`",
    "`stories/next-id.sh`",
    "`get_story_format`",
    "`validate_story`",
    "`sprint: backlog`",
    "`planning`",
    "gh pr create",
    "With no remote",
    "one command to merge",
    "never touch the canonical clone",
    "Home gets no commit",
  ]) {
    assert.ok(spec.includes(phrase), `the spec says: ${phrase}`);
  }
});

test("setup: offer once, launch the guide on a yes, resume, and take it back with a Set up: line", () => {
  for (const phrase of [
    "Set me up",
    "list_orgs_teams",
    "list_source_repos",
    "offer setup once",
    "Set up now · Not now",
    "`setup-ledger`",
    'agent:"guide-claude"',
    'initial_prompt:"/codesense-setup"',
    'mode:"visible-unfocused"',
    "`/codesense-setup resume`",
    "`Setup done:`",
    "`claim_role_messages`",
    "`ack_role_message`",
    "`Set up:`",
  ]) {
    assert.ok(spec.includes(phrase), `the spec says: ${phrase}`);
  }
  // The Foreman makes no setup call itself; it hands over.
  assert.ok(spec.includes("make no setup call"), "it only hands over");
});

test("setup: the offer guard, the Not now ledger write, the reuse search and the stopped read", () => {
  const setup = spec.split("## Setup")[1].split("\n## ")[0];
  for (const phrase of [
    // The guard: an unanswered offer card in the inbox, or a skipped ledger row.
    "unless `inbox_list` holds an unanswered one",
    "`records_list`",
    "`step: foreman-offer, state: skipped`",
    // Not now is the one ledger write.
    "Not now writes that row (`records_create`)",
    // Reuse: a live guide this Foreman launched, found in list_sessions, before any launch.
    "Reuse a live `guide-*` session you launched (`list_sessions`), else `open_workspace",
    // Stopped: no hand-back, so the next wake reads the ledger and offers Resume.
    "Setup ended with none: at your next wake read the ledger, say where it stopped and offer Resume",
  ]) {
    assert.ok(setup.includes(phrase), `the setup rules say: ${phrase}`);
  }
  assert.ok(
    setup.indexOf("Reuse a live") < setup.indexOf("open_workspace"),
    "reuse is looked for before the launch",
  );
});

test("sprint leads: look for a live one on any machine, then launch the team's sprint agent from its config", () => {
  for (const phrase of [
    "Start sprint <n>",
    "`list_sessions`",
    "Sprint <n>",
    "launched_by:<your handle>",
    'target:"team-workspace"',
    'role:"sprint-lead"',
    "/sprint-lead <n>",
    "`story-view.yml`",
    "`agent_list`",
  ]) {
    assert.ok(spec.includes(phrase), `the spec says: ${phrase}`);
  }
  // The agent comes from the team's config, never from a name written into the spec.
  assert.ok(!/sprint-(manager|lead-claude)/.test(spec), "no sprint agent is named in the spec");
});

test("status: at most 8 lines from three named reads, no story files", () => {
  for (const phrase of [
    "What's going on",
    "8 lines",
    "`codesense_overview`",
    "`list_sessions`",
    '`inbox_list {kind:"needs-you", limit:50}`',
    "what waits on the person",
    "what runs",
    "what failed",
    "Read no story files",
  ]) {
    assert.ok(spec.includes(phrase), `the spec says: ${phrase}`);
  }
});

test("waiting: the chat surface's open needs-you cards only, and its view as a dependency", () => {
  for (const phrase of [
    "What's waiting on me",
    "needs-you rule",
    "open cards only",
    `inbox_list {kind:"needs-you", limit:50}`,
    "story id",
    "The person answers on the page",
    "needs-you view",
    "never a copy",
  ]) {
    assert.ok(spec.includes(phrase), `the spec says: ${phrase}`);
  }
  // A copy of the rule would be the Foreman filtering the list itself.
  assert.ok(
    !/answered|resolved|dismissed/i.test(spec.split("## Waiting")[1]?.split("\n## ")[0] ?? ""),
    "the rule decides open, not the spec",
  );
});

test("the handoff names the worktrees, children, cards and last request in at most 12 lines", () => {
  const handoff = spec.split("## Handoff")[1].split("\n## ")[0];
  for (const phrase of [
    "`Foreman handoff:`",
    "12 lines",
    "`foreman-*` worktrees",
    "unanswered cards",
    "live children",
    "handles",
    "last request",
    "`signal_done`",
  ]) {
    assert.ok(handoff.includes(phrase), `the handoff says: ${phrase}`);
  }
});

test("a team's story-create scripts run inside a foreman-* worktree", () => {
  const wt = "../foreman-dark-mode-ab12";
  // The parent is a working directory, so `cd` into a sibling worktree runs.
  const at = agent.args.indexOf("--add-dir");
  assert.ok(at >= 0 && agent.args[at + 1] === "..", "the saved agent adds home's parent");
  // What the skill invokes: the id script, then the story script, in the worktree.
  for (const command of [
    `cd ${wt} && sh stories/next-id.sh`,
    `cd ${wt} && sh stories/next-id.sh ACME`,
    `cd ${wt} && sh stories/new-story.sh ACME-7 "Add dark mode to the settings page"`,
    `cd ${wt} && sh stories/new-story.sh ACME-7 "Search & filter <beta>"`,
  ]) {
    assert.ok(runs(command), `runs: ${command}`);
  }
  for (const command of [
    // Outside the working directories, another interpreter or another place.
    `cd /tmp && sh stories/next-id.sh ACME`,
    `cd ${wt} && sh /tmp/x.sh`,
    `cd ${wt} && bash stories/new-story.sh ACME-7`,
    `cd ${wt} && sh scripts/x.sh`,
    `cd ${wt} && sh stories/x.sh2`,
    // Anything chained, piped, redirected or substituted needs its own rule.
    `cd ${wt} && sh stories/next-id.sh ACME; rm -rf ../base`,
    `cd ${wt} && sh stories/next-id.sh ACME && curl example.test`,
    `cd ${wt} && sh stories/next-id.sh ACME | sh`,
    `cd ${wt} && sh stories/next-id.sh ACME > ../base/CLAUDE.md`,
    `cd ${wt} && sh stories/next-id.sh $(cat ../base/x)`,
    `cd ${wt} && sh stories/next-id.sh "$(cat ../base/x)"`,
    `cd ${wt} && sh stories/next-id.sh \`id\``,
  ]) {
    assert.ok(!runs(command), `refused: ${command}`);
  }
  assert.ok(
    spec.includes("cd ../<wt> && sh stories/<script>.sh <args>"),
    "the spec names the form",
  );
});

test("the spec's worktree, sprint-lead, story-script and handoff forms read literally", () => {
  for (const phrase of [
    "`../<wt>`, where `<wt>` is `foreman-<slug>-<4 hex>`",
    "launched by you for sprint <n>",
    "Commit and push what the skill didn't",
    "`reply` once with `Foreman handoff:`",
  ]) {
    assert.ok(spec.includes(phrase), `the spec says: ${phrase}`);
  }
  assert.ok(!spec.includes("`../foreman-<slug>"), "<wt> is a name, not a path");
});

test("the command splitter treats newlines, escapes, open quotes and unresolved cd paths as Claude would", () => {
  const wt = "../foreman-dark-mode-ab12";
  for (const command of [
    `cd ${wt} && sh stories/next-id.sh ACME\nrm -rf ~`,
    `cd ${wt} && sh stories/new-story.sh \\"; rm -rf ~; echo \\"`,
    `cd ${wt} && sh stories/new-story.sh "open`,
    "cd ~ && sh stories/next-id.sh",
    "cd $HOME && sh stories/next-id.sh",
    'cd "/tmp" && sh stories/next-id.sh',
  ]) {
    assert.ok(!runs(command), `refused: ${JSON.stringify(command)}`);
  }
});

test("the Foreman can list remote foreman branches before it names a new one", () => {
  for (const command of [
    "git ls-remote --heads origin",
    "git ls-remote --heads origin foreman/dark-mode-*",
  ]) {
    assert.ok(runs(command), `runs: ${command}`);
  }
  assert.ok(spec.includes("`git ls-remote --heads origin`"), "the spec names the read");
});

test("the size estimate never undercounts the measured root prompt", () => {
  // claude -p on Opus 5.5 (2026-11-13): 5,347 bytes of foreman.md were 1,986 tokens.
  assert.ok(Math.ceil(5347 / BYTES_PER_TOKEN) >= 1986, `${BYTES_PER_TOKEN} bytes a token`);
});
