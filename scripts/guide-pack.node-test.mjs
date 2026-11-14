// SPDX-License-Identifier: MIT
// The `codesense-guide` pack: its agents, the per-phase tool allowlist, each runtime's
// denies, the built skill copies and the docs-bundle mapping.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { PACKS_ROOT, ROOT, buildPack, docsMapping, syncDocs } from "./pack-build.mjs";

const PACK = join(PACKS_ROOT, "codesense-guide");
const DOCS = join(ROOT, "codesense-docs/getting-started");
const yaml = (path) => parse(readFileSync(path, "utf8"));
const agent = (runtime) => yaml(join(PACK, `agents/guide-${runtime}/agent.yaml`));

// Phase 1's tool list, written out: DESIGN section 3.3's 24 tools plus the product step's
// two epic-repo verbs. Later phases add their own tools in the PR that ships them, and
// that PR edits this list; nothing derives it from the files under test.
const PHASE_1 = [
  // reads
  "who_am_i",
  "read_messages",
  "codesense_overview",
  "describe_setup",
  "query_context",
  "read_content_file",
  "list_source_repos",
  "records_list",
  "probe_environment",
  // chat
  "reply",
  "send_message",
  "signal_progress",
  "signal_done",
  // setup, used only after a click
  "create_local_organization",
  "attach_context_repository",
  "create_team",
  "add_source_repo",
  "attach_source_repo_path",
  "run_in_terminal_tab",
  "records_create",
  "records_set_fields",
  "create_content_file",
  "validate_story",
  "open_workspace",
  // the product step, until SV-PW lands
  "set_epic_repos",
  "read_epic_repos",
];
const sorted = (list) => [...list].sort();

test("the phase 1 list is DESIGN's 24 tools plus the two epic-repo verbs", () => {
  assert.equal(PHASE_1.length, 26);
  assert.equal(new Set(PHASE_1).size, 26);
});

test("the pack builds clean under --check", () => {
  const { errors } = buildPack(PACK, { check: true });
  assert.deepEqual(errors, []);
});

test("the pack declares one agent per runtime and one skill with three targets", () => {
  const manifest = yaml(join(PACK, "pack.yml"));
  assert.equal(manifest.id, "codesense-guide");
  const kinds = (kind) => manifest.parts.filter((p) => p.kind === kind);
  assert.deepEqual(
    kinds("agent")
      .map((p) => p.file)
      .sort(),
    ["claude", "codex", "opencode"].map((r) => `agents/guide-${r}/agent.yaml`),
  );
  const [skill, ...rest] = kinds("skill");
  assert.equal(rest.length, 0);
  assert.equal(skill.source, "commands/codesense-setup.md");
  assert.equal(skill.name ?? skill.id, "codesense-setup");
  assert.deepEqual([...skill.targets].sort(), ["claude", "codex", "opencode"]);
});

test("the built skill lands at each runtime's own path, byte for byte", () => {
  const source = readFileSync(join(PACK, "commands/codesense-setup.md"));
  for (const path of [
    ".claude/skills/codesense-setup/SKILL.md",
    ".agents/skills/codesense-setup/SKILL.md",
    ".opencode/command/codesense-setup.md",
  ])
    assert.ok(readFileSync(join(PACK, path)).equals(source), path);
  assert.match(source.toString(), /^---\nname: codesense-setup\n/);
});

test("Claude's allow list is exactly the phase 1 tools", () => {
  const { permissions, args } = agent("claude");
  const allow = permissions.claude.allow;
  const tools = allow
    .filter((rule) => rule.startsWith("mcp__codesense__"))
    .map((rule) => rule.slice("mcp__codesense__".length));
  assert.deepEqual(sorted(tools), sorted(PHASE_1));
  assert.deepEqual(
    allow.filter((rule) => !rule.startsWith("mcp__codesense__")),
    ["Skill(codesense-setup)"],
  );
  // Whatever the allow list misses is refused, not asked.
  assert.equal(permissions.claude.defaultMode, "dontAsk");
  // Denies, from the built args: no shell, edit or web tool at all.
  const at = args.indexOf("--disallowedTools");
  assert.ok(at >= 0, "--disallowedTools is in the args");
  assert.deepEqual(args[at + 1].split(",").sort(), [
    "Bash",
    "Edit",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
    "Write",
  ]);
});

test("Codex runs in the read-only sandbox with exactly the phase 1 bridge tools", () => {
  const { permissions, mcp } = agent("codex");
  assert.equal(permissions.codex.sandbox_mode, "read-only");
  assert.equal(permissions.codex.approval_policy, "never");
  assert.deepEqual(sorted(mcp.bridge_tools), sorted(PHASE_1));
});

test("OpenCode denies shell, edit and web and gets exactly the phase 1 bridge tools", () => {
  const { permissions, mcp } = agent("opencode");
  const rules = permissions.opencode.permission;
  for (const key of ["bash", "edit", "webfetch", "external_directory"])
    assert.equal(rules[key], "deny", key);
  assert.deepEqual(sorted(mcp.bridge_tools), sorted(PHASE_1));
});

test("no agent names a model: the page picks it per setup state through openWorkspace", () => {
  for (const runtime of ["claude", "codex", "opencode"]) {
    const { args = [] } = agent(runtime);
    assert.ok(!args.includes("--model"), runtime);
    assert.ok(!args.some((a) => String(a).startsWith("model=")), runtime);
  }
});

test("each agent stages its own runtime's copy of the skill and the root prompt only", () => {
  const stages = {
    claude: ".claude/skills/codesense-setup",
    codex: ".agents/skills/codesense-setup",
    opencode: ".opencode/command/codesense-setup.md",
  };
  const prompt = { claude: "CLAUDE.md", codex: "AGENTS.md", opencode: "AGENTS.md" };
  for (const [runtime, skill] of Object.entries(stages)) {
    const { context, runtime: declared } = agent(runtime);
    assert.equal(declared, runtime);
    assert.deepEqual(context, [
      { path: "guide/PROMPT.md", dest: prompt[runtime] },
      { path: skill },
    ]);
  }
});

test("the root prompt is short and forbids secrets and unclicked changes", () => {
  const text = readFileSync(join(PACK, "content/guide/PROMPT.md"), "utf8");
  assert.ok(text.length < 1400, `${text.length} bytes`);
  for (const rule of [/Next:/, /Never type, ask for or repeat secrets/, /click/])
    assert.match(text, rule);
});

test("the old example recipe is gone and exactly one skill has the name", () => {
  const content = join(DOCS, "content");
  assert.ok(!existsSync(join(content, "examples/skills/codesense-setup")));
  assert.ok(!existsSync(join(content, "examples/agents/codesense-setup")));
  assert.ok(!existsSync(join(content, "setting-up-agents/codesense-setup-agent.md")));
  assert.ok(existsSync(join(content, ".claude/skills/codesense-setup/SKILL.md")));
});

test("the docs bundle carries the pack's copies, and a hand edit to any one fails the check", () => {
  const manifest = yaml(join(PACK, "pack.yml"));
  const pairs = docsMapping(PACK, manifest);
  const targets = pairs.map((p) => p.to);
  for (const expected of [
    "getting-started/config/agents/guide-claude/agent.yaml",
    "getting-started/config/agents/guide-codex/agent.yaml",
    "getting-started/config/agents/guide-opencode/agent.yaml",
    "getting-started/content/guide/PROMPT.md",
    "getting-started/content/guide/handoff.md",
    "getting-started/content/.claude/skills/codesense-setup/SKILL.md",
    "getting-started/content/.agents/skills/codesense-setup/SKILL.md",
    "getting-started/content/.opencode/command/codesense-setup.md",
  ])
    assert.ok(targets.includes(expected), expected);
  // The real bundle matches the pack.
  assert.deepEqual(
    syncDocs(PACK, manifest, { check: true, docsRoot: join(ROOT, "codesense-docs") }).errors,
    [],
  );

  const dir = mkdtempSync(join(tmpdir(), "guide-docs-"));
  try {
    cpSync(join(ROOT, "codesense-docs/getting-started"), join(dir, "getting-started"), {
      recursive: true,
    });
    for (const { to } of pairs) {
      const path = join(dir, to);
      const original = readFileSync(path);
      writeFileSync(path, `${original}\nhand edit\n`);
      const { errors } = syncDocs(PACK, manifest, { check: true, docsRoot: dir });
      assert.ok(
        errors.some((e) => e.includes(to)),
        `an edit to ${to} is caught`,
      );
      writeFileSync(path, original);
    }
    writeFileSync(join(dir, pairs[0].to), "stale\n");
    const fixed = syncDocs(PACK, manifest, { check: false, docsRoot: dir });
    assert.deepEqual(fixed.errors, []);
    assert.deepEqual(syncDocs(PACK, manifest, { check: true, docsRoot: dir }).errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hand edit to a built copy in the pack fails the pack's drift check", () => {
  const dir = mkdtempSync(join(tmpdir(), "guide-pack-"));
  try {
    const copy = join(dir, "codesense-guide");
    cpSync(PACK, copy, { recursive: true });
    writeFileSync(join(copy, ".agents/skills/codesense-setup/SKILL.md"), "edited\n");
    const { errors } = buildPack(copy, { check: true });
    assert.ok(errors.some((e) => e.startsWith("drift: .agents/skills/codesense-setup/SKILL.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
