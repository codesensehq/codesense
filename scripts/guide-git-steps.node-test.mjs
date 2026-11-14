// SPDX-License-Identifier: MIT
// The guide's git steps: `git-access` (how agents reach the git host, checked by one read and
// saved to the team) and `clone` (one visible tab per repo). No step requires `gh`, and no
// secret ever reaches the note, the ledger or the chat.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { PACKS_ROOT } from "./pack-build.mjs";
import { stepRuleErrors, unsafeInput } from "./lib/pack-steps.mjs";

const STEPS = join(PACKS_ROOT, "codesense-guide/setup/steps");
const step = (id) => parse(readFileSync(join(STEPS, `${id}.yml`), "utf8"));
const all = () =>
  readdirSync(STEPS)
    .filter((f) => f.endsWith(".yml") && f !== "index.yml")
    .map((f) => ({ id: f.replace(/\.yml$/, ""), text: readFileSync(join(STEPS, f), "utf8") }));
const clone = (o) => JSON.parse(JSON.stringify(o));
const CMD =
  "/usr/bin/env GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never git ls-remote --exit-code -- https://github.com/{{repo}}.git HEAD";

test("no step requires gh: none runs it, probes it, names it as a step or needs it", () => {
  const index = readFileSync(join(STEPS, "index.yml"), "utf8");
  assert.doesNotMatch(index, /\bgh[-_]/);
  for (const { id, text } of all()) {
    assert.doesNotMatch(text, /\bgh (?:auth|repo|api|pr|issue|--)/, `${id} runs gh`);
    assert.doesNotMatch(text, /\bgh_(?:auth|version)|gh-(?:installed|auth)|cli\.github\.com/, id);
    assert.doesNotMatch(text, /probe_environment/, `${id} probes the environment for gh`);
    const s = parse(text);
    assert.ok(!/gh/.test(s.id) && !(s.needs ?? []).some((n) => /gh/.test(n)), id);
  }
  // gh is one answer on git-access's card, never the way in.
  const labels = step("git-access").ask.options.map((o) => o.label);
  assert.ok(labels.includes("The gh CLI"));
  assert.ok(labels.includes("Not now"));
  assert.ok(
    labels.every((l) => !/install|sign in/i.test(l)),
    "never which tool to install",
  );
});

test("git-access asks how agents reach the host: credentials first, never what to install", () => {
  const s = step("git-access");
  assert.deepEqual(
    s.ask.options.map((o) => o.label),
    [
      "The git credentials I already have",
      "The gh CLI",
      "A git or GitHub MCP server",
      "A token-based tool",
      "Not now",
    ],
  );
  assert.equal(s.ask.recommend, "check-credentials");
  assert.equal(s.ask.free_text, true);
  assert.deepEqual(s.needs, ["source-repos"]);
  assert.match(s.ask.text, /nothing is committed or pushed/i);
});

test("git-access reads one repo with a fixed command, then writes the note: no write without the read", () => {
  const s = step("git-access");
  const checks = s.act.filter((a) => a.id.startsWith("check-"));
  assert.equal(checks.length, 4);
  for (const act of checks) {
    assert.equal(act.run.cmd, CMD, act.id);
    assert.equal(act.run.in, "terminal_tab");
    assert.equal(act.consent, "local-write");
    assert.equal(act.then.length, 1);
    const save = s.act.find((a) => a.id === act.then[0]);
    assert.equal(save.verb.tool, "create_content_file");
    assert.equal(save.verb.args.onCollision, "fail");
    assert.match(
      save.verb.args.path,
      /^\{\{probe\.repos\.org_root\}\}\/\{\{probe\.repos\.team\}\}\/content\/tools\/git-access\.md$/,
    );
  }
  // Only the checks are options: the write is reachable through its read.
  assert.deepEqual(
    s.ask.options.filter((o) => o.act !== "none").map((o) => o.act),
    checks.map((a) => a.id),
  );
  // git neither prompts nor reads an env var the person set: the environment is fixed in the command.
  assert.match(CMD, /GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never git ls-remote --exit-code -- /);
  assert.equal(unsafeInput(s.inputs.repo.pattern), false);
  assert.deepEqual(stepRuleErrors(s, "git-access.yml"), []);
});

test("git-access is done by the file it wrote, not by the run", () => {
  const s = step("git-access");
  assert.equal(s.verify.probe, "note");
  const note = s.probe.find((p) => p.id === "note");
  assert.equal(note.check.tool, "read_content_file");
  assert.ok(note.check.path.endsWith("/content/tools/git-access.md"));
  assert.deepEqual(note.map, { found: "done", none: "missing", unreadable: "missing" });
  // The read's exit status is no probe outcome: nothing in a probe or verify names the run.
  assert.ok(s.probe.every((p) => !/ls-remote/.test(JSON.stringify(p))));
});

test("a failed read offers Retry and Copy access request and saves nothing", () => {
  for (const id of ["git-access", "clone"]) {
    const { on_fail, act } = step(id);
    const labels = on_fail.options.map((o) => o.label);
    assert.ok(labels.includes("Retry") && labels.includes("Copy access request"), id);
    assert.match(on_fail.text, /\{\{repo\}\}/);
    assert.match(on_fail.copy, /read access to \{\{repo\}\}/);
    assert.ok(on_fail.options.every((o) => ["retry", "copy", "skip"].includes(o.do)));
    // A failure is no act: the card the click allowed is spent, and the new card is a read card.
    assert.ok(act.every((a) => !on_fail.options.some((o) => o.label === a.what)));
  }
  assert.match(step("git-access").on_fail.text, /nothing was saved to `tools\/git-access\.md`/);
  assert.deepEqual(
    step("clone").on_fail.options.map((o) => o.label),
    ["Retry", "Copy access request", "Skip for now"],
  );
});

test("no secret or token reaches the note, the ledger row, the chat card or the copy text", () => {
  for (const id of ["git-access", "clone"]) {
    const s = step(id);
    const text = readFileSync(join(STEPS, `${id}.yml`), "utf8");
    assert.doesNotMatch(
      text,
      /gh[pousr]_[A-Za-z0-9]|github_pat_|sk-[A-Za-z0-9]|xox[bp]-|BEGIN [A-Z ]*KEY/,
      id,
    );
    assert.equal(s.record.secret, "never");
    assert.doesNotMatch(
      JSON.stringify(s.record.fields),
      /token|secret|password|credential|\{\{probe/i,
      id,
    );
    // No input can carry free text into the note or a command: the note's content is fixed
    // per method, and every command argument is an input whose pattern a shell reads as a word.
    for (const act of s.act) {
      const content = act.verb?.args?.content;
      if (content !== undefined) assert.doesNotMatch(content, /\{\{/, `${id}/${act.id} content`);
    }
    for (const [name, spec] of Object.entries(s.inputs))
      if (s.act.some((a) => a.run?.cmd?.includes(`{{${name}}}`)))
        assert.equal(unsafeInput(spec.pattern), false, `${id} input ${name}`);
  }
  for (const act of step("git-access").act.filter((a) => a.verb)) {
    const { content } = act.verb.args;
    assert.match(content, /This file holds no secret/);
    assert.doesNotMatch(content, /[A-Za-z0-9_]{32,}/, "no long token-shaped run");
  }
});

test("clone runs clone_repo per repo, shows the exact git line, and maps what a clone means", () => {
  const s = step("clone");
  assert.deepEqual(s.needs, ["source-repos", "git-access"]);
  assert.match(s.ask.text, /`git clone -- https:\/\/github\.com\/<owner>\/<name>\.git <path>`/);
  assert.match(s.ask.text, /one|own\s+terminal tab/);
  const act = s.act.find((a) => a.id === "clone-repo");
  assert.equal(act.verb.tool, "clone_repo");
  assert.deepEqual(Object.keys(act.verb.args).sort(), [
    "org",
    "path",
    "repo",
    "team",
    "workspaceId",
  ]);
  assert.ok(act.repeat > 1, "one use per repo");
  assert.deepEqual(
    s.ask.options.map((o) => [o.label, o.act]),
    [
      ["Do it", "clone-repo"],
      ["I'll run it myself", "bind-clone"],
      ["Not now", "none"],
    ],
  );
  const { map } = s.probe.find((p) => p.id === "repos");
  assert.equal(map.attached, "done");
  assert.equal(map.unattached, "missing", "an uncloned repo keeps the step open");
  assert.equal(map.missing, "missing");
  assert.deepEqual(s.verify, { probe: "repos", expect: "done" });
  assert.deepEqual(stepRuleErrors(s, "clone.yml"), []);
});

test("a run command may take an input only if a shell could not read it as more than a word", () => {
  const base = clone(step("git-access"));
  const bad = clone(base);
  bad.inputs.repo.pattern = "^[^\\n]+$";
  assert.ok(stepRuleErrors(bad, "x").some((e) => e.includes("builds its command from {{repo}}")));
  const probed = clone(base);
  probed.act[0].run.cmd = "git ls-remote {{probe.repos.repo}}";
  assert.ok(
    stepRuleErrors(probed, "x").some((e) =>
      e.includes("builds its command from {{probe.repos.repo}}"),
    ),
  );
  const unknown = clone(base);
  unknown.act[0].run.cmd = "git ls-remote {{nope}}";
  assert.ok(stepRuleErrors(unknown, "x").some((e) => e.includes("{{nope}}")));
  const cwd = clone(base);
  cwd.act[0].run.cwd = "{{repo}}";
  assert.ok(stepRuleErrors(cwd, "x").some((e) => e.includes("builds its command from {{repo}}")));
  for (const pattern of ["^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$", "^[a-z0-9][a-z0-9-]{0,38}$"])
    assert.equal(unsafeInput(pattern), false, pattern);
  for (const pattern of ["^.+$", "^[^\\n]+$", "^[a-z ]+$", "^[a-z;]+$", "^[a-z$()]+$", "(?"])
    assert.equal(unsafeInput(pattern), true, pattern);
});

test("on_fail names inputs only, and a copy button needs copy text", () => {
  const s = clone(step("git-access"));
  s.on_fail.text = "{{probe.repos.repo}} failed";
  assert.ok(stepRuleErrors(s, "x").some((e) => e.includes("on_fail uses {{probe.repos.repo}}")));
  const t = clone(step("git-access"));
  delete t.on_fail.copy;
  assert.ok(stepRuleErrors(t, "x").some((e) => e.includes("has no copy text")));
});
