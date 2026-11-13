// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";
import {
  ROOT,
  SCHEMA_PATH,
  TARGET_PATHS,
  buildPack,
  listPackFiles,
  schemaErrors,
  skillCopies,
} from "./pack-build.mjs";

const FIXTURES = join(ROOT, "scripts/fixtures/packs");
const fixture = (name) => join(FIXTURES, name);
const check = (name) => buildPack(fixture(name), { check: true });
const yaml = (path) => parse(readFileSync(path, "utf8"));

/** A scratch copy of a fixture pack, removed after `fn`. */
function scratch(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), "pack-build-"));
  const copy = join(dir, name);
  try {
    cpSync(fixture(name), copy, { recursive: true });
    return fn(copy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("every good fixture builds clean under --check", () => {
  for (const name of ["good", "good-external", "good-setup", "risky", "two-pack/a", "two-pack/b"]) {
    const { errors, written } = check(name);
    assert.deepEqual(errors, [], name);
    assert.deepEqual(written, [], name);
  }
});

test("each bad fixture fails with its own named error", () => {
  const rows = [
    ["bad-schema", /pack\.yml must have required property 'license'/],
    ["bad-target", /parts\/0\/targets\/0 must be equal to one of the allowed values/],
    ["bad-source-missing", /skill source nope\.md is missing or outside the pack/],
    ["bad-drift", /drift: \.agents\/skills\/hello\/SKILL\.md differs from commands\/hello\.md/],
    ["bad-hash", /files: LICENSE hash differs/],
    ["bad-unlisted", /files: content\/handbook\/extra\.md is not listed/],
    ["bad-missing-file", /files: content\/handbook\/gone\.md is listed but missing/],
    ["bad-git-path", /files: \.git\/config is listed but missing/],
    ["bad-chat-code", /content\/page\/index\.html: builds a composer \(<textarea>\)/],
    ["bad-chat-code", /content\/page\/index\.html: builds a message list \(role="log"\)/],
  ];
  for (const [name, expected] of rows) {
    const { errors } = check(name);
    assert.ok(
      errors.some((e) => expected.test(e)),
      `${name}: ${errors.join(" | ")}`,
    );
  }
});

test("the Rust-rule fixtures are valid to the schema, so only the Rust rules refuse them", () => {
  for (const name of [
    "bad-unknown-part",
    "bad-needs",
    "bad-abs-path",
    "bad-dotdot",
    "bad-content-config",
    "bad-third-party-license",
    "bad-third-party-path",
    "bad-skill-license",
  ])
    assert.deepEqual(check(name).errors, [], name);
});

test("a skill part builds one copy per target, at that runtime's own path", () => {
  const manifest = yaml(join(fixture("good"), "pack.yml"));
  const copies = skillCopies(manifest);
  assert.deepEqual(
    copies.map((c) => c.path),
    [
      ".claude/skills/hello/SKILL.md",
      ".agents/skills/hello/SKILL.md",
      ".opencode/command/hello.md",
    ],
  );
  const source = readFileSync(join(fixture("good"), "commands/hello.md"));
  for (const copy of copies)
    assert.ok(source.equals(readFileSync(join(fixture("good"), copy.path))), copy.path);
});

test("the node and Rust target paths agree", () => {
  const rust = readFileSync(join(ROOT, "src-tauri/src/packs/manifest.rs"), "utf8");
  for (const [target, path] of Object.entries(TARGET_PATHS)) {
    const template = path("{name}");
    assert.ok(rust.includes(`format!("${template}")`), `${target}: ${template}`);
  }
});

test("a hand edit to a built copy fails the drift check, and the build repairs it", () => {
  scratch("good", (dir) => {
    const copy = join(dir, ".claude/skills/hello/SKILL.md");
    writeFileSync(copy, readFileSync(copy, "utf8") + "edited by hand\n");
    const failing = buildPack(dir, { check: true });
    assert.match(failing.errors[0], /drift: \.claude\/skills\/hello\/SKILL\.md differs/);
    assert.equal(
      readFileSync(copy, "utf8").endsWith("edited by hand\n"),
      true,
      "check writes nothing",
    );
    const repaired = buildPack(dir);
    assert.deepEqual(repaired.errors, []);
    assert.ok(repaired.written.includes(".claude/skills/hello/SKILL.md"));
    assert.deepEqual(buildPack(dir, { check: true }).errors, []);
  });
});

test("the build writes missing copies and the files list, and a second run changes nothing", () => {
  scratch("good", (dir) => {
    for (const rel of [".claude", ".agents", ".opencode"])
      rmSync(join(dir, rel), { recursive: true });
    const manifestPath = join(dir, "pack.yml");
    const stripped = readFileSync(manifestPath, "utf8").replace(/\nfiles:[\s\S]*$/, "\n");
    writeFileSync(manifestPath, stripped);
    const first = buildPack(dir);
    assert.deepEqual(first.errors, []);
    assert.ok(first.written.includes("pack.yml"));
    assert.deepEqual(yaml(manifestPath).files, yaml(join(fixture("good"), "pack.yml")).files);
    assert.deepEqual(buildPack(dir), { errors: [], written: [] });
  });
});

test("files lists every file but pack.yml, sorted, with the exec bit", () => {
  const { files, problems } = listPackFiles(fixture("risky"));
  assert.deepEqual(problems, []);
  assert.ok(!files.includes("pack.yml"));
  assert.deepEqual(files, [...files].sort());
  const listed = yaml(join(fixture("risky"), "pack.yml")).files;
  const exec = Object.fromEntries(listed.map((f) => [f.path, f.exec]));
  assert.equal(exec["content/bin/run.sh"], true);
  assert.equal(exec["content/.claude/hooks/pre-tool.sh"], true);
  assert.equal(exec["LICENSE"], false);
});

test("a symlink in a pack is reported, not followed", () => {
  scratch("good", (dir) => {
    const link = spawnSync("ln", ["-s", "/etc/hosts", join(dir, "content/hosts")]);
    assert.equal(link.status, 0);
    const { errors } = buildPack(dir, { check: true });
    assert.ok(
      errors.some((e) => /content\/hosts: symlinks are refused/.test(e)),
      errors.join("|"),
    );
  });
});

test("the shared-chat rule: a page must mount kit.chat and build no chat of its own", () => {
  const page = "content/page/index.html";
  const rows = [
    ["no mount", "no chat here\n", /no page under content\/ uses kit\.chat/],
    ["scrolls itself", "codesense.kit.chat.mount(el);\nlist.scrollTop = 0;\n", /its own scrolling/],
    ["parses cards", "codesense.kit.chat.mount(el);\nconst c = parseCard(text);\n", /card parsing/],
  ];
  for (const [name, html, expected] of rows)
    scratch("good", (dir) => {
      writeFileSync(join(dir, page), html);
      buildPack(dir); // refresh files so only the page rule can fail
      const { errors } = buildPack(dir, { check: true });
      assert.ok(
        errors.some((e) => expected.test(e)),
        `${name}: ${errors.join("|")}`,
      );
    });
  scratch("good", (dir) => {
    writeFileSync(
      join(dir, page),
      '<header id="slot"><button id="menu">⋯</button></header>\n<script>codesense.kit.chat.mount(el, { header: slot });</script>\n',
    );
    buildPack(dir);
    assert.deepEqual(buildPack(dir, { check: true }).errors, [], "header-slot DOM is allowed");
  });
  scratch("good", (dir) => {
    // A pack that doesn't ask for the kit chat is not held to the rule.
    writeFileSync(join(dir, page), "<textarea></textarea>\n");
    const manifestPath = join(dir, "pack.yml");
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, "utf8").replace("  kit: { chat: 1 }\n", ""),
    );
    buildPack(dir);
    assert.deepEqual(buildPack(dir, { check: true }).errors, []);
  });
});

test("--check on the committed packs passes, and fails on a drifted pack", () => {
  const run = (...args) =>
    spawnSync(process.execPath, ["scripts/pack-build.mjs", "--check", ...args], {
      cwd: ROOT,
      encoding: "utf8",
    });
  const real = run();
  assert.equal(real.status, 0, real.stdout + real.stderr);
  assert.match(real.stdout, /pack-build: ok/);
  assert.equal(run("--pack", fixture("good")).status, 0);
  const drifted = run("--pack", fixture("bad-drift"));
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /drift: /);
  const many = run("--root", fixture("two-pack"));
  assert.equal(many.status, 0, many.stderr);
  assert.match(many.stdout, /ok \(2 packs\)/);
});

test("the exported pack.yml schema accepts the design example and refuses unknown kit keys", () => {
  const example = yaml(join(FIXTURES, "design-example.pack.yml"));
  assert.deepEqual(schemaErrors(example), []);
  const kit = { ...yaml(join(fixture("good"), "pack.yml")) };
  assert.deepEqual(schemaErrors({ ...kit, requires: { kit: { chat: 1 } } }), []);
  for (const bad of [{ chat: "1" }, { chat: -1 }, { chat: 1.5 }, { canvas: 1 }])
    assert.notDeepEqual(schemaErrors({ ...kit, requires: { kit: bad } }), [], JSON.stringify(bad));
  assert.match(
    schemaErrors({ ...kit, parts: [{ id: "x", kind: "script" }] }).join("|"),
    /unknown kind: script/,
  );
});

test("the exported lock schema accepts the design example and the two-pack lock", () => {
  const ajv = new Ajv2020({ strict: false });
  ajv.addFormat("uint32", true);
  const lockSchema = JSON.parse(
    readFileSync(SCHEMA_PATH.replace("pack-yml", "packs-lock-yml"), "utf8"),
  );
  const validate = ajv.compile(lockSchema);
  for (const file of ["design-example.packs.lock.yml", "two-pack/packs.lock.yml"]) {
    assert.equal(
      validate(yaml(join(FIXTURES, file))),
      true,
      `${file}: ${JSON.stringify(validate.errors)}`,
    );
  }
  assert.equal(validate({ packs: [] }), false, "lock_format is required");
  const lock = yaml(join(FIXTURES, "two-pack/packs.lock.yml"));
  assert.deepEqual(
    lock.packs.map((p) => p.id),
    ["pack-a", "pack-b"].map((id) => yaml(join(fixture(`two-pack/${id.at(-1)}`), "pack.yml")).id),
  );
  assert.ok(existsSync(join(fixture("two-pack/a"), "setup/steps/access.yml")));
});
