// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  ROOT,
  verifySources,
  modelSchemas,
  queuedExport,
  schemaFields,
} from "./generate-model-schemas.mjs";

test("the PR docs check rejects a stale standalone schema without repairing it", () => {
  const path = join(
    ROOT,
    "codesense-docs/getting-started/content/generated/schemas/routine-yml.schema.json",
  );
  const original = readFileSync(path, "utf8");
  const stale = JSON.stringify({ ...JSON.parse(original), title: "Stale schema mutation" }) + "\n";
  try {
    writeFileSync(path, stale);
    const result = spawnSync("pnpm", ["gen:docs:check:pr"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, "stale output must fail the actual package check command");
    assert.match(result.stdout + result.stderr, /routine-yml\.schema\.json is stale/);
    assert.equal(readFileSync(path, "utf8"), stale, "check mode must preserve the stale bytes");
  } finally {
    writeFileSync(path, original);
  }
});

test("a real model field mutation fails the normal no-Cargo freshness gate", () => {
  const path = join(ROOT, "src-tauri/src/docs_schemas.generated.json");
  const bytes = readFileSync(path, "utf8");
  const fixture = JSON.parse(bytes);
  assert.doesNotThrow(() => verifySources(fixture));
  assert.throws(
    () =>
      verifySources(fixture, (source) => {
        const bytes = readFileSync(join(ROOT, source), "utf8");
        return source === "src-tauri/src/routines/model.rs"
          ? bytes.replace(
              "pub name: String,",
              "pub name: String,\n    pub newly_added_field: String,",
            )
          : bytes;
      }),
    /fixture is stale: src-tauri\/src\/routines\/model.rs/,
  );
  assert.equal(readFileSync(path, "utf8"), bytes, "freshness checks never rehash the fixture");
});

test("the browser rows retain all root fields and nested custom wire shapes", () => {
  const models = modelSchemas();
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
