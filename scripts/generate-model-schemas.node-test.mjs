// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import {
  ROOT,
  FIXTURE,
  generate,
  verifySources,
  staleSources,
  modelSchemas,
  pinnedModels,
  staleFixtureExplainer,
  queuedExport,
  schemaFields,
} from "./generate-model-schemas.mjs";
import { REFRESH_ROUTE } from "./lib/sealed-export.mjs";

// The scratch repos below start with one commit, so a merge group's drift base (HEAD^1) does not exist
// in them: the fixtures must not inherit a merge-group runner's event. The merge-group test sets it.
delete process.env.GITHUB_EVENT_NAME;

// A scratch checkout holding the fixture, its sources and the Node outputs, with origin/main at
// its first commit, so the PR gate's "untouched since main" rule runs against real git.
function scratchRoot() {
  const root = mkdtempSync(join(tmpdir(), "model-schemas-stale-"));
  const fixture = JSON.parse(readFileSync(join(ROOT, FIXTURE), "utf8"));
  const content = "codesense-docs/getting-started/content";
  for (const path of [
    FIXTURE,
    ...Object.keys(fixture.sources),
    ...Object.keys(fixture.schemas).map(
      (slug) => `${content}/generated/schemas/${slug}.schema.json`,
    ),
    `${content}/arc-g-routines/routine-yml.html`,
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(ROOT, path), join(root, path));
  }
  const git = (...args) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
      cwd: root,
      stdio: "pipe",
    });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  return root;
}
const MODEL = "src-tauri/src/routines/model.rs";
const addField = (root) => {
  const path = join(root, MODEL);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      "pub name: String,",
      "pub name: String,\n    pub newly_added_field: String,",
    ),
  );
};

test("a stale fixture fails the strict check, and write mode and the PR gate render from it with a notice", () => {
  const root = scratchRoot();
  try {
    addField(root);
    const before = readFileSync(join(root, FIXTURE), "utf8");
    assert.throws(
      () => generate(true, { root }),
      /fixture is stale: (?:\S+, )*src-tauri\/src\/routines\/model.rs/,
    );
    for (const options of [{}, { check: true, allowStaleExport: true }]) {
      const notices = [];
      assert.doesNotThrow(() =>
        generate(options.check ?? false, {
          ...options,
          root,
          strict: false,
          warn: (line) => notices.push(line),
        }),
      );
      assert.match(
        notices.join("\n"),
        /^NOTICE: Model schema fixture is stale: (?:\S+, )*src-tauri\/src\/routines\/model.rs/,
      );
    }
    assert.equal(readFileSync(join(root, FIXTURE), "utf8"), before, "never rehash the fixture");
    // Under CS_STRICT_EXPORTS=1 (the refresh run) write mode is strict.
    assert.throws(() => generate(false, { root, strict: true }), /fixture is stale/);
    assert.throws(
      () => generate(true, { root }),
      (error) =>
        error.message.includes(REFRESH_ROUTE) &&
        !/--queued-export|regenerate-exports/.test(error.message),
    );
    // A PR that edits the fixture itself is held to the strict check.
    writeFileSync(join(root, FIXTURE), before.replace(/\n$/, "\n\n"));
    assert.throws(
      () => generate(true, { root, allowStaleExport: true, warn: () => {} }),
      /fixture is stale/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("in a merge group, the PR gate measures against the group's parent", () => {
  const root = scratchRoot();
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=t",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: root, stdio: "pipe" },
    );
  const gate = () => {
    const notices = [];
    generate(true, {
      root,
      allowStaleExport: true,
      strict: false,
      warn: (line) => notices.push(line),
    });
    return notices.join("\n");
  };
  try {
    // An entry queued ahead touched the fixture and an input; this entry is the next commit, and
    // origin/main still points at the base.
    addField(root);
    writeFileSync(join(root, FIXTURE), `${readFileSync(join(root, FIXTURE), "utf8")}\n`);
    git("commit", "-qam", "an entry queued ahead");
    git("commit", "-q", "--allow-empty", "-m", "this entry");
    process.env.GITHUB_EVENT_NAME = "merge_group";
    assert.match(
      gate(),
      /^NOTICE: Model schema fixture is stale: (?:\S+, )*src-tauri\/src\/routines\/model.rs/,
    );
    // Against origin/main the earlier entry's fixture edit would read as this entry's: strict.
    process.env.GITHUB_EVENT_NAME = "pull_request";
    assert.throws(gate, /fixture is stale/);
  } finally {
    delete process.env.GITHUB_EVENT_NAME;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deleted fixture source is stale, not a crash", () => {
  const root = scratchRoot();
  try {
    rmSync(join(root, MODEL));
    const fixture = JSON.parse(readFileSync(join(root, FIXTURE), "utf8"));
    assert.ok(staleSources(fixture, (path) => readFileSync(join(root, path))).includes(MODEL));
    const notices = [];
    assert.doesNotThrow(() =>
      generate(false, { root, strict: false, warn: (line) => notices.push(line) }),
    );
    assert.match(
      notices.join("\n"),
      /fixture is stale: (?:\S+, )*src-tauri\/src\/routines\/model.rs/,
    );
    assert.throws(() => generate(true, { root }), /fixture is stale/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the PR gate still rejects a stale standalone schema without repairing it", () => {
  const root = scratchRoot();
  try {
    addField(root);
    const path = join(
      root,
      "codesense-docs/getting-started/content/generated/schemas/routine-yml.schema.json",
    );
    const stale =
      JSON.stringify({
        ...JSON.parse(readFileSync(path, "utf8")),
        title: "Stale schema mutation",
      }) + "\n";
    writeFileSync(path, stale);
    assert.throws(
      () => generate(true, { root, allowStaleExport: true, strict: false, warn: () => {} }),
      /routine-yml\.schema\.json is stale/,
    );
    assert.equal(readFileSync(path, "utf8"), stale, "check mode must preserve the stale bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The CLIs resolve their root from their own path, so the scratch checkout gets copies of them.
function withCliCopies(root) {
  for (const path of [
    "scripts/generate-model-schemas.mjs",
    "scripts/generate-yaml-schemas.mjs",
    "scripts/lib/sealed-export.mjs",
    "scripts/lib/generator-inputs.mjs",
    "codesense-docs/getting-started/content/generated/schemas/factory-phase.schema.json",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(ROOT, path), join(root, path));
  }
  return (script, env, { args = ["--check"], strict = "" } = {}) =>
    // The real path: each CLI runs only when argv[1] equals its own (symlink-free) module path.
    spawnSync(process.execPath, [join(realpathSync(root), "scripts", script), ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, DOCS_ALLOW_STALE_EXPORT: env, CS_STRICT_EXPORTS: strict },
    });
}

test("each CLI's --check passes the stale switch through", () => {
  const root = scratchRoot();
  try {
    const cli = withCliCopies(root);
    addField(root);
    for (const script of ["generate-model-schemas.mjs", "generate-yaml-schemas.mjs"]) {
      const tolerant = cli(script, "1");
      assert.equal(tolerant.status, 0, `${script}: ${tolerant.stderr}`);
      assert.match(tolerant.stderr, /NOTICE: Model schema fixture is stale/, script);
      const strict = cli(script, "");
      assert.notEqual(strict.status, 0, script);
      assert.match(strict.stderr, /fixture is stale/, script);
      // Write mode warns, unless CS_STRICT_EXPORTS=1 (the refresh run).
      const write = cli(script, "", { args: [] });
      assert.equal(write.status, 0, `${script}: ${write.stderr}`);
      const strictWrite = cli(script, "", { args: [], strict: "1" });
      assert.notEqual(strictWrite.status, 0, script);
      assert.match(strictWrite.stderr, /fixture is stale/, script);
    }
    const schema = join(
      root,
      "codesense-docs/getting-started/content/generated/schemas/routine-yml.schema.json",
    );
    const stale = readFileSync(schema, "utf8").replace(/\n$/, "\n\n");
    writeFileSync(schema, stale);
    const result = cli("generate-model-schemas.mjs", "1");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /routine-yml\.schema\.json is stale/);
    assert.equal(readFileSync(schema, "utf8"), stale);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staleFixtureExplainer names the stale sources' identifiers under the same rule as the pin", () => {
  const root = scratchRoot();
  try {
    // Rehash the scratch copy (never the real fixture) to make it fresh: nothing to explain.
    const fixture = JSON.parse(readFileSync(join(root, FIXTURE), "utf8"));
    for (const path of Object.keys(fixture.sources))
      fixture.sources[path] = createHash("sha256")
        .update(readFileSync(join(root, path)))
        .digest("hex");
    writeFileSync(join(root, FIXTURE), JSON.stringify(fixture, null, 2) + "\n");
    assert.equal(staleFixtureExplainer(root, { strict: false }), null, "a fresh fixture");
    const git = (...args) =>
      execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
        cwd: root,
        stdio: "pipe",
      });
    git("commit", "-q", "-am", "fresh");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    addField(root);
    const write = staleFixtureExplainer(root, { strict: false });
    assert.equal(write("newly_added_field"), true);
    assert.equal(write("newlyAddedField"), true, "a camelCase serde name");
    assert.equal(write("newly_added_feild"), false, "a typo");
    const gate = { check: true, allowStaleExport: true, strict: false };
    assert.equal(staleFixtureExplainer(root, gate)("newly_added_field"), true);
    assert.equal(staleFixtureExplainer(root, { check: true, strict: false }), null, "strict check");
    assert.equal(staleFixtureExplainer(root, { strict: true }), null, "the refresh run");
    assert.equal(
      staleFixtureExplainer(root, { ...gate, strict: true }),
      null,
      "the PR gate under CS_STRICT_EXPORTS=1",
    );
    assert.throws(
      () => modelSchemas(root, { ...gate, strict: true, warn: () => {} }),
      /fixture is stale/,
    );
    writeFileSync(join(root, FIXTURE), readFileSync(join(root, FIXTURE), "utf8") + "\n");
    assert.equal(staleFixtureExplainer(root, gate), null, "the PR touched the fixture");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifySources is the strict freshness check and never rehashes the fixture", () => {
  const path = join(ROOT, FIXTURE);
  const bytes = readFileSync(path, "utf8");
  const fixture = JSON.parse(bytes);
  const mutated = (source) => {
    const bytes = readFileSync(join(ROOT, source), "utf8");
    return source === MODEL
      ? bytes.replace("pub name: String,", "pub name: String,\n    pub newly_added_field: String,")
      : bytes;
  };
  // Only the mutation is new: main's fixture may already lag a source this branch changed.
  const lagging = staleSources(fixture);
  assert.deepEqual(
    staleSources(fixture, mutated).filter((path) => !lagging.includes(path)),
    [MODEL],
  );
  assert.throws(
    () => verifySources(fixture, mutated),
    /fixture is stale: (?:\S+, )*src-tauri\/src\/routines\/model.rs/,
  );
  assert.equal(readFileSync(path, "utf8"), bytes, "freshness checks never rehash the fixture");
});

test("the model pin is strict only with CS_STRICT_EXPORTS=1", () => {
  const root = scratchRoot();
  try {
    addField(root);
    assert.doesNotThrow(() => pinnedModels(root, {}, () => {}));
    assert.throws(
      () => pinnedModels(root, { CS_STRICT_EXPORTS: "1" }),
      /fixture is stale: (?:\S+, )*src-tauri\/src\/routines\/model.rs/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the browser rows retain all root fields and nested custom wire shapes", () => {
  const models = pinnedModels(ROOT, process.env, () => {});
  for (const model of Object.values(models)) {
    for (const key of Object.keys(model.schema.properties))
      assert.ok(
        model.fields.some((f) => f.name === key),
        key,
      );
  }
  const names = (slug) => models[slug].fields.map((f) => f.name);
  for (const field of ["env", "role", "context", "context[].path", "context[].dest"])
    assert.ok(names("agent-yaml").includes(field), field);
  for (const field of [
    "action",
    "command",
    "after.routine",
    "after.on",
    "result_schema",
    "policy.max_wakes",
    "policy.max_wakes_per_day",
    "policy.min_gap",
    "triggers[].event.metadata.target.key",
  ])
    assert.ok(names("routine-yml").includes(field), field);
  assert.deepEqual(Object.keys(models["role-yaml"].schema.properties).sort(), [
    "defaultHandler",
    "icon",
    "id",
    "name",
  ]);
});

test("actual enum branches retain allowed spellings without duplicate wire types or fake source links", () => {
  const fixture = JSON.parse(
    readFileSync(join(ROOT, "src-tauri/src/docs_schemas.generated.json"), "utf8"),
  );
  const fields = schemaFields(fixture.schemas["routine-yml"]);
  for (const [name, allowed] of [
    [
      "triggers[].event.metadata.target.op",
      ["eq", "in", "not", "exists", "missing", "contains", "range", "prefix"],
    ],
    ["triggers[].event.metadata.selection.where.layers[]", ["team", "private", "all-orgs"]],
  ]) {
    const field = fields.find((row) => row.name === name);
    assert.deepEqual(field.allowed, allowed, name);
    assert.equal(field.type, "string", name);
  }
  for (const field of fields) assert.equal(field.sourceRef, null, field.name);
});

test("the agent schema states OpenCode's launch-mode permission default", () => {
  const schema = JSON.parse(
    readFileSync(
      join(ROOT, "codesense-docs/getting-started/content/generated/schemas/agent-yaml.schema.json"),
      "utf8",
    ),
  );
  const text = schema.$defs.OpenCodePermissions.description.replace(/\s+/g, " ");
  for (const part of [
    /foreground[^.]*"\*":\s*"ask"/,
    /headless[^.]*"\*":\s*"deny"/,
    /escalating[^.]*allow/,
  ])
    assert.match(text, part);
  assert.doesNotMatch(text, /composer supplies the `ask` fallback/);
});

test("the queued export gates disk, then runs the one Rust exporter with UPDATE_DOCS_SCHEMAS", () => {
  const calls = [];
  queuedExport({
    gate: (root) => calls.push(["gate", root]),
    spawn: (command, args, options) => {
      calls.push([command, args, options.cwd, options.env.UPDATE_DOCS_SCHEMAS]);
      return { status: 0 };
    },
  });
  assert.deepEqual(calls, [
    ["gate", ROOT],
    [
      "cargo",
      [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--lib",
        "docs_schemas::export_model_schemas",
        "-j",
        "4",
      ],
      ROOT,
      "1",
    ],
  ]);
  assert.throws(
    () => queuedExport({ gate: () => {}, spawn: () => ({ status: 101 }) }),
    /Model schema export failed \(101\)/,
  );
});

// The command line, end to end, with stand-in df and cargo on PATH: no Rust build runs.
test(
  "--queued-export runs the exporter from the command line",
  { skip: process.platform === "win32" },
  () => {
    const bin = mkdtempSync(join(tmpdir(), "model-schemas-"));
    const log = join(bin, "cargo.log");
    try {
      writeFileSync(
        join(bin, "df"),
        "#!/bin/sh\necho 'Filesystem 1K-blocks Used Available'\necho 'disk 1 1 999999999'\n",
      );
      writeFileSync(join(bin, "cargo"), `#!/bin/sh\necho "$UPDATE_DOCS_SCHEMAS $*" > '${log}'\n`);
      chmodSync(join(bin, "df"), 0o755);
      chmodSync(join(bin, "cargo"), 0o755);
      const result = spawnSync(
        process.execPath,
        ["scripts/generate-model-schemas.mjs", "--queued-export"],
        {
          cwd: ROOT,
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        readFileSync(log, "utf8"),
        "1 test --manifest-path src-tauri/Cargo.toml --lib docs_schemas::export_model_schemas -j 4\n",
      );
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  },
);

test("the queued export names a cargo that cannot start", () => {
  assert.throws(
    () =>
      queuedExport({
        gate: () => {},
        spawn: () => ({ status: null, error: new Error("spawn cargo ENOENT") }),
      }),
    /could not start cargo: spawn cargo ENOENT/,
  );
});
