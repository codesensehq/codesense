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

// The same estimate the budget uses elsewhere: four bytes a token.
const tokens = (s) => Math.ceil(Buffer.byteLength(s) / 4);

test("the root prompt is the spec, under 1.5k tokens", () => {
  assert.equal(
    text("agents/foreman-claude/CLAUDE.md"),
    spec,
    "regenerate CLAUDE.md from foreman.md",
  );
  assert.ok(tokens(spec) <= 1500, `${tokens(spec)} tokens`);
});

test("the agent allows exactly the Foreman's tools and denies the rest", () => {
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
  }
});

test("git and gh are limited to the home update, foreman-* worktrees and foreman/* branches", () => {
  const bash = allow.filter((rule) => rule.startsWith("Bash("));
  assert.deepEqual(bash, [
    "Bash(git fetch:*)",
    "Bash(git merge --ff-only:*)",
    "Bash(git worktree add:*)",
    "Bash(git worktree list:*)",
    "Bash(git worktree remove:*)",
    "Bash(git -C ../foreman-*:*)",
    "Bash(git push origin foreman/*:*)",
    "Bash(gh pr create:*)",
    "Bash(../foreman-*/stories/next-id.sh:*)",
    "Bash(../foreman-*/stories/new-story.sh:*)",
  ]);
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
  assert.deepEqual(agent.startup, ["CLAUDE.md"], "the root prompt is the only startup file");
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
