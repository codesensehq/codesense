// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  queuedExport,
  schemaFields,
} from "./generate-model-schemas.mjs";
import { REFRESH_ROUTE, strictExports } from "./lib/sealed-export.mjs";

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
        generate(options.check ?? false, { ...options, root, warn: (line) => notices.push(line) }),
      );
      assert.match(
        notices.join("\n"),
        /^NOTICE: Model schema fixture is stale: (?:\S+, )*src-tauri\/src\/routines\/model.rs/,
      );
    }
    assert.equal(readFileSync(join(root, FIXTURE), "utf8"), before, "never rehash the fixture");
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
      () => generate(true, { root, allowStaleExport: true, warn: () => {} }),
      /routine-yml\.schema\.json is stale/,
    );
    assert.equal(readFileSync(path, "utf8"), stale, "check mode must preserve the stale bytes");
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

// The pin on the committed fixture: strict with CS_STRICT_EXPORTS=1, else a stale fixture is a notice.
const pinnedModels = () => modelSchemas(ROOT, { check: strictExports(), warn: () => {} });

test("the model pin is strict only with CS_STRICT_EXPORTS=1", () => {
  const root = scratchRoot();
  try {
    addField(root);
    const run = (env) =>
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { modelSchemas } from ${JSON.stringify(join(ROOT, "scripts/generate-model-schemas.mjs"))};
           import { strictExports } from ${JSON.stringify(join(ROOT, "scripts/lib/sealed-export.mjs"))};
           modelSchemas(${JSON.stringify(root)}, { check: strictExports(), warn: () => {} });`,
        ],
        { encoding: "utf8", env: { ...process.env, CS_STRICT_EXPORTS: env } },
      );
    assert.equal(run("").status, 0, run("").stderr);
    const strict = run("1");
    assert.notEqual(strict.status, 0);
    assert.match(strict.stderr, /fixture is stale: (?:\S+, )*src-tauri\/src\/routines\/model.rs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the browser rows retain all root fields and nested custom wire shapes", () => {
  const models = pinnedModels();
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
