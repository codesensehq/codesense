// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  parseArgs,
  run as runPacks,
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
  for (const name of [
    "good",
    "good-external",
    "good-setup",
    "risky",
    "risky-more",
    "two-pack/a",
    "two-pack/b",
  ]) {
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

test("a hermes target builds to Hermes's own skill folder", () => {
  const copies = skillCopies({
    parts: [{ id: "s", kind: "skill", source: "c.md", targets: ["hermes"] }],
  });
  assert.deepEqual(
    copies.map((c) => c.path),
    [".hermes/skills/s/SKILL.md"],
  );
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

/** Swap the `hello` skill part of a scratch pack for `fields`. */
function setSkill(dir, fields) {
  const path = join(dir, "pack.yml");
  const manifest = yaml(path);
  manifest.parts = manifest.parts.map((p) => (p.id === "hello" ? { ...p, ...fields } : p));
  writeFileSync(path, JSON.stringify(manifest));
}

test("a skill name that climbs out of the pack is refused before anything is written", () => {
  scratch("good", (dir) => {
    setSkill(dir, { name: "../../../escape" });
    const { errors, written } = buildPack(dir);
    assert.match(errors.join("|"), /hello: a skill name is \[a-z0-9-\]/);
    assert.deepEqual(written, []);
    assert.equal(existsSync(join(dir, "../escape")), false, "nothing written outside the pack");
  });
});

test("a symlinked skill source or built-copy folder is refused, not read or written through", () => {
  scratch("good", (dir) => {
    const outside = join(dir, "../outside");
    mkdirSync(outside);
    rmSync(join(dir, ".claude/skills/hello"), { recursive: true });
    symlinkSync(outside, join(dir, ".claude/skills/hello"));
    writeFileSync(join(dir, "commands/hello.md"), "changed\n");
    const { errors, written } = buildPack(dir);
    assert.match(errors.join("|"), /\.claude\/skills\/hello: symlinks are refused/);
    assert.equal(existsSync(join(outside, "SKILL.md")), false, "nothing written through the link");
    assert.deepEqual(written, []);
  });
  scratch("good", (dir) => {
    const secret = join(dir, "../secret.md");
    writeFileSync(secret, "not the pack's\n");
    rmSync(join(dir, "commands/hello.md"));
    symlinkSync(secret, join(dir, "commands/hello.md"));
    const { errors } = buildPack(dir);
    assert.match(errors.join("|"), /commands\/hello\.md: symlinks are refused/);
    const copy = readFileSync(join(dir, ".claude/skills/hello/SKILL.md"), "utf8");
    assert.notEqual(copy, "not the pack's\n");
  });
});

test("two skill parts building to one path, or a copy over another part's file, are refused", () => {
  scratch("good", (dir) => {
    const path = join(dir, "pack.yml");
    const manifest = yaml(path);
    manifest.parts.push({
      id: "hello-again",
      kind: "skill",
      name: "hello",
      source: "commands/hello.md",
      targets: ["claude"],
    });
    writeFileSync(path, JSON.stringify(manifest));
    assert.match(
      buildPack(dir).errors.join("|"),
      /\.claude\/skills\/hello\/SKILL\.md is built by both hello and hello-again/,
    );
  });
  scratch("good", (dir) => {
    setSkill(dir, { source: ".opencode/command/hello.md" });
    assert.match(
      buildPack(dir).errors.join("|"),
      /hello: \.opencode\/command\/hello\.md is both a built copy and a source/,
    );
  });
});

test("a pack.yml that is missing or malformed is a named error, and --root checks the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-build-"));
  try {
    cpSync(fixture("good"), join(dir, "a-good"), { recursive: true });
    cpSync(fixture("good"), join(dir, "b-broken"), { recursive: true });
    writeFileSync(join(dir, "b-broken/pack.yml"), "parts: [\n");
    cpSync(fixture("good"), join(dir, "c-good"), { recursive: true });
    const broken = buildPack(join(dir, "b-broken"), { check: true });
    assert.match(broken.errors.join("|"), /^pack\.yml: cannot parse: /);
    assert.match(
      buildPack(join(dir, "missing"), { check: true }).errors.join("|"),
      /^pack\.yml: cannot read: /,
    );
    const seen = [];
    const log = console.log;
    const error = console.error;
    console.log = console.error = (line) => seen.push(line);
    try {
      assert.equal(
        runPacks([join(dir, "a-good"), join(dir, "b-broken"), join(dir, "c-good")], {
          check: true,
        }),
        false,
      );
    } finally {
      console.log = log;
      console.error = error;
    }
    assert.ok(
      seen.some((l) => /b-broken: pack\.yml: cannot parse/.test(l)),
      seen.join("|"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a duplicate files entry is named", () => {
  scratch("good", (dir) => {
    const path = join(dir, "pack.yml");
    const manifest = yaml(path);
    manifest.files.push(manifest.files.find((f) => f.path === "LICENSE"));
    writeFileSync(path, JSON.stringify(manifest));
    assert.match(
      buildPack(dir, { check: true }).errors.join("|"),
      /files: LICENSE is listed twice/,
    );
  });
});

test("the command line refuses unknown flags and flags with no value", () => {
  assert.deepEqual(parseArgs(["--check"]), { check: true, pack: undefined, root: undefined });
  assert.equal(parseArgs(["--pack", "x"]).pack.endsWith("/x"), true);
  for (const args of [["--chek"], ["--pack"], ["--root"], ["--pack", "--check"], ["extra"]])
    assert.throws(() => parseArgs(args), /pack-build: /, args.join(" "));
});

test("one bad part stops every write, even the copies that were fine", () => {
  scratch("good", (dir) => {
    rmSync(join(dir, ".claude"), { recursive: true });
    const path = join(dir, "pack.yml");
    const manifest = yaml(path);
    manifest.parts.push({
      id: "later",
      kind: "skill",
      source: "commands/gone.md",
      targets: ["codex"],
    });
    writeFileSync(path, JSON.stringify(manifest));
    const before = readFileSync(path, "utf8");
    const { errors, written } = buildPack(dir);
    assert.match(errors.join("|"), /later: skill source commands\/gone\.md is missing/);
    assert.deepEqual(written, []);
    assert.equal(existsSync(join(dir, ".claude/skills/hello/SKILL.md")), false);
    assert.equal(readFileSync(path, "utf8"), before);
  });
});

test("a symlinked pack.yml is refused and never written through", () => {
  scratch("good", (dir) => {
    const outside = join(dir, "../outside.yml");
    const stripped = readFileSync(join(dir, "pack.yml"), "utf8").replace(/\nfiles:[\s\S]*$/, "\n");
    writeFileSync(outside, stripped);
    rmSync(join(dir, "pack.yml"));
    symlinkSync(outside, join(dir, "pack.yml"));
    const { errors, written } = buildPack(dir);
    assert.match(errors.join("|"), /pack\.yml: symlinks are refused/);
    assert.deepEqual(written, []);
    assert.equal(readFileSync(outside, "utf8"), stripped);
  });
});

test("a FIFO, an oversized file and a .GIT folder are reported, never read", () => {
  scratch("good", (dir) => {
    assert.equal(spawnSync("mkfifo", [join(dir, "content/pipe")]).status, 0);
    writeFileSync(join(dir, "content/big.bin"), Buffer.alloc(5 * 1024 * 1024 + 1));
    mkdirSync(join(dir, "content/.GIT"));
    const { problems } = listPackFiles(dir);
    const all = problems.join("|");
    assert.match(all, /content\/pipe: not a regular file/);
    assert.match(all, /content\/big\.bin: over the 5 MB file cap/);
    assert.match(all, /content\/\.GIT: \.git is not part of a pack/);
    assert.notDeepEqual(buildPack(dir, { check: true }).errors, []);
  });
});
