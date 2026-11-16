// SPDX-License-Identifier: MIT
// The example agents users copy declare `mcp.bridge_tools`. A Claude agent with a list is denied
// every served bridge tool it leaves out, so each list must name every bridge tool its startup
// skills, its default prompt and its routines call, plus the three every agent needs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const content = new URL("../codesense-docs/getting-started/content/", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, content), "utf8");
const served = new Set(
  JSON.parse(read("generated/mcp-tools.json")).families.flatMap((family) => family.tools),
);
const ALWAYS = ["read_messages", "reply", "signal_done"];
// A name the skills mention that the app doesn't serve yet: left out of the list, on purpose.
const NOT_SERVED = ["search_brain"];
// A served name a source mentions only to forbid it, per agent, with the reason.
const EXCLUDED = {
  // cited-retrieval and while-you-were-away both tell it not to use signal_progress (it is
  // transient). The routine forbids read_messages too, which stays: every agent needs it.
  reviewer: ["signal_progress"],
};

const AGENTS = ["machine-setup", "manager", "reviewer"];
// The docs pages that show an example agent's whole agent.yaml.
const PAGES = {
  "machine-setup": ["setting-up-agents/machine-setup-agent.md"],
  manager: [
    "setting-up-agents/manager-agent.md",
    "arc-f-inboxes-and-triage/roles.html",
    "arc-g-routines/agent-wake.html",
  ],
  reviewer: [],
};

// The bridge tools a text names, bare or as `mcp__codesense__<name>`.
const toolsIn = (text) =>
  [...served].filter((name) =>
    new RegExp(`(?<![A-Za-z0-9_])(?:mcp__codesense__)?${name}(?![A-Za-z0-9_])`).test(text),
  );

// A startup skill `.claude/skills/<name>/` is the agent's own copy, else the shared example.
function skillText(agent, entry) {
  const m = /^\.claude\/skills\/([^/]+)\/$/.exec(entry);
  if (!m) return null;
  for (const rel of [
    `examples/agents/${agent}/skills/${m[1]}/SKILL.md`,
    `examples/skills/${m[1]}/SKILL.md`,
  ])
    if (existsSync(new URL(rel, content))) return read(rel);
  assert.fail(`${agent}: no SKILL.md for ${entry}`);
}

function sourcesOf(id) {
  const yaml = parse(read(`examples/agents/${id}/agent.yaml`));
  const texts = [yaml.default_prompt ?? ""];
  for (const entry of yaml.startup ?? []) {
    const text = skillText(id, entry);
    if (text !== null) texts.push(text);
  }
  const routines = new URL(`examples/agents/${id}/routines/`, content);
  if (existsSync(routines))
    for (const name of readdirSync(routines))
      texts.push(read(`examples/agents/${id}/routines/${name}/routine.yml`));
  return { yaml, texts };
}

for (const id of AGENTS) {
  test(`${id}: bridge_tools is exactly what its skills, prompt and routines call`, () => {
    const { yaml, texts } = sourcesOf(id);
    assert.equal(yaml.runtime, "claude");
    const list = yaml.mcp?.bridge_tools;
    assert.ok(Array.isArray(list), "mcp.bridge_tools is declared");
    assert.equal(new Set(list).size, list.length, "no name twice");
    for (const name of list) assert.ok(served.has(name), `${name} is in mcp-tools.json`);
    const excluded = EXCLUDED[id] ?? [];
    const named = new Set([...ALWAYS, ...texts.flatMap(toolsIn)]);
    for (const name of excluded) {
      assert.ok(named.has(name), `${name} is still named in a source, so its exclusion is needed`);
      named.delete(name);
    }
    assert.deepEqual([...list].sort(), [...named].sort());
    for (const name of [...NOT_SERVED, ...excluded])
      assert.ok(!list.includes(name), `${name} is left out`);
  });

  test(`${id}: every docs page that shows its agent.yaml shows the list`, () => {
    const list = parse(read(`examples/agents/${id}/agent.yaml`)).mcp.bridge_tools;
    for (const page of PAGES[id]) {
      const text = read(page);
      const block = text.slice(text.indexOf(`id: ${id}\n`));
      const yamlEnd = block.search(/```|<\/code><\/pre>/);
      const shown = block.slice(0, yamlEnd);
      assert.match(shown, /bridge_tools:/, page);
      for (const name of list) assert.match(shown, new RegExp(`- ${name}\\n`), `${page}: ${name}`);
    }
  });
}

test("the tool matcher finds bare and prefixed names and skips longer ones", () => {
  assert.deepEqual(toolsIn("call `reply`"), ["reply"]);
  assert.deepEqual(toolsIn("mcp__codesense__list_sessions"), ["list_sessions"]);
  assert.deepEqual(toolsIn("replying, list_sessionsx"), []);
});
