// SPDX-License-Identifier: MIT
// Model-free checks on the Foreman pack: the root prompt, the saved agent's tool and write rules,
// and the settings that keep the team's own skills and instructions out of its first call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
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

// The same estimate the budget uses elsewhere: four bytes a token.
const tokens = (s) => Math.ceil(Buffer.byteLength(s) / 4);

test("the root prompt is the spec, under 1.5k tokens, passed as the agent's system prompt", () => {
  const at = agent.args.indexOf("--append-system-prompt");
  assert.ok(at >= 0, "the saved agent appends its root prompt");
  assert.equal(
    agent.args[at + 1],
    spec,
    "copy foreman.md into agent.yaml's --append-system-prompt",
  );
  assert.ok(tokens(spec) <= 1500, `${tokens(spec)} tokens`);
  // A startup file would be the team's own CLAUDE.md, never this pack's.
  assert.ok(!agent.startup?.length, "no startup file");
  assert.ok(!existsSync(new URL("agents/foreman-claude/CLAUDE.md", pack)));
});

test("the agent allows exactly the Foreman's tools and refuses the rest", () => {
  assert.equal(agent.permissions.claude.defaultMode, "dontAsk", "anything not allowed is refused");
  for (const rule of allow) {
    assert.ok(/^(mcp__codesense__|Bash\()/.test(rule), rule);
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

test("the Foreman edits no file: every write tool is denied outright, none allowed", () => {
  for (const tool of ["Edit", "Write", "NotebookEdit"]) {
    assert.ok(deny.includes(tool), `${tool} is denied`);
    assert.ok(
      !allow.some((rule) => rule === tool || rule.startsWith(`${tool}(`)),
      `${tool} is not allowed`,
    );
  }
});

// Claude's Bash rules: `prefix:*` is a literal prefix (its other `*` stays literal);
// otherwise any `*` matches any run of characters, spaces included, and one trailing ` *`
// may match nothing; otherwise the rule is exact.
function bashMatches(rule, command) {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m) return false;
  const body = m[1];
  const cmd = command.trim();
  const prefix = /^(.+):\*$/.exec(body);
  if (prefix) return cmd === prefix[1] || cmd.startsWith(`${prefix[1]} `);
  if (!body.includes("*")) return cmd === body;
  const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const optionalTail = body.endsWith(" *");
  const core = optionalTail ? body.slice(0, -2) : body;
  const re = core.split("*").map(escape).join(".*") + (optionalTail ? "( .*)?" : "");
  return new RegExp(`^${re}$`, "s").test(cmd);
}
const runs = (command) =>
  allow.some((rule) => bashMatches(rule, command)) &&
  !deny.some((rule) => bashMatches(rule, command));

test("no Bash rule ends in :*, which Claude reads as a literal prefix", () => {
  for (const rule of [...allow, ...deny].filter((r) => r.startsWith("Bash("))) {
    assert.ok(!rule.endsWith(":*)"), rule);
  }
});

// The only shell is the home update, as exact rules: a rule with no `*` matches only that
// command, and `defaultMode: dontAsk` refuses the rest.
const HOME_UPDATE = ["git fetch", "git fetch origin", "git merge --ff-only origin/main"];

test("the only Bash rules are the home update's exact commands", () => {
  const bash = [...allow, ...deny].filter((rule) => rule.startsWith("Bash"));
  assert.deepEqual(
    bash,
    HOME_UPDATE.map((command) => `Bash(${command})`),
  );
  for (const rule of bash) assert.ok(!rule.includes("*"), rule);
});

test("nothing but the home update runs", () => {
  for (const command of HOME_UPDATE) assert.ok(runs(command), `runs: ${command}`);
  for (const command of [
    "git fetch --upload-pack=/tmp/x origin",
    "git fetch origin main:main",
    "git merge --ff-only foreman/x",
    "git merge --ff-only origin/main foreman/x",
    "git worktree add -b foreman/x ../foreman-x origin/main",
    "git -C ../foreman-x diff --no-index /etc/hosts x",
    "git -C ../foreman-x push -u origin foreman/x:develop",
    "git commit -m x",
    "git push origin main",
    "gh pr create --fill",
    "gh api repos/x/y",
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
    "the only shell you have",
    "You never edit files",
    "`foreman/<slug>` branch",
    "Foreman handoff:",
    "at most 12 lines",
    "120k context",
    "You never relaunch yourself",
    "You set no timers",
    "I don't set timers; I can create a routine for you to approve in its dashboard.",
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
