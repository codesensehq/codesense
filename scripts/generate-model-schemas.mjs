#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The Rust exporter is the only writer of the fixture. Never rehash a stale fixture here.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REFRESH_ROUTE,
  allowStaleExport as switchedOn,
  diskGate,
  driftInheritedFromMain,
  exportsUntouchedSinceMain,
  addedSince,
  frozenExport,
  namesIn,
  strictExports,
} from "./lib/sealed-export.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE = "src-tauri/src/docs_schemas.generated.json";
const CONTENT = "codesense-docs/getting-started/content";
const staleMessage = (paths) =>
  `Model schema fixture is stale: ${paths.join(", ")}; ${REFRESH_ROUTE}. Do not rehash the fixture.`;
// The fixture's sources whose bytes no longer match the hashes it was exported from. A source the
// branch deleted or renamed is stale too; any other read error still throws.
export function staleSources(fixture, readSource = (path) => readFileSync(join(ROOT, path))) {
  const digest = (path) => {
    try {
      return createHash("sha256").update(readSource(path)).digest("hex");
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
      throw error;
    }
  };
  return Object.entries(fixture.sources)
    .filter(([path, expected]) => digest(path) !== expected)
    .map(([path]) => path);
}
// The strict freshness check.
export function verifySources(fixture, readSource) {
  const stale = staleSources(fixture, readSource);
  if (stale.length) throw new Error(staleMessage(stale));
}
function deref(schema, root) {
  return schema.$ref ? root.$defs[schema.$ref.split("/").at(-1)] : schema;
}
export function schemaFields(root) {
  const rows = [];
  function visit(raw, name, required, seen = new Set()) {
    const schema = deref(raw, root);
    const choices = schema.anyOf ?? schema.oneOf;
    const defaultValue = Object.hasOwn(raw, "default") ? raw.default : schema.default;
    const types =
      schema.type ??
      (schema.enum
        ? "enum"
        : choices
          ? choices.flatMap((s) => deref(s, root).type ?? "object")
          : "any");
    rows.push({
      name,
      type: Array.isArray(types) ? [...new Set(types)].join(" | ") : types,
      required,
      default: defaultValue === undefined ? null : JSON.stringify(defaultValue),
      allowed:
        schema.enum ??
        (choices?.every((part) => Object.hasOwn(deref(part, root), "const"))
          ? [...new Set(choices.map((part) => deref(part, root).const))]
          : null),
      pattern: schema.pattern ?? null,
      description: raw.description ?? schema.description ?? "",
      sourceRef: null,
    });
    if (seen.has(schema)) return;
    const nextSeen = new Set([...seen, schema]);
    for (const part of choices ?? [schema]) {
      const object = deref(part, root);
      for (const [key, value] of Object.entries(object.properties ?? {}))
        visit(value, `${name}.${key}`, required && (object.required ?? []).includes(key), nextSeen);
      if (object.items) visit(object.items, `${name}[]`, false, nextSeen);
      if (
        object.additionalProperties &&
        typeof object.additionalProperties === "object" &&
        Object.keys(object.additionalProperties).length
      )
        visit(object.additionalProperties, `${name}.*`, false, nextSeen);
    }
  }
  for (const [key, value] of Object.entries(root.properties))
    visit(value, key, (root.required ?? []).includes(key));
  return rows.filter((r, i) => rows.findIndex((other) => other.name === r.name) === i);
}
// A stale fixture: write mode (`pnpm gen:docs`, and build.rs through generate-yaml-schemas) renders
// from the committed fixture with a notice. So does the PR gate (`allowStaleExport`) while this PR
// leaves the fixture as main has it, or the drift is main's; strict check mode throws. `strict`
// (CS_STRICT_EXPORTS=1, the refresh run) makes write mode and the PR gate throw too.
const tolerated = (root, stale, { check, allowStaleExport, strict }) =>
  !strict &&
  (!check ||
    (allowStaleExport &&
      (exportsUntouchedSinceMain(root, frozenExport(FIXTURE)) ||
        driftInheritedFromMain(root, stale))));
const readStale = (root) =>
  staleSources(JSON.parse(readFileSync(join(root, FIXTURE), "utf8")), (path) =>
    readFileSync(join(root, path)),
  );
export function modelSchemas(
  root = ROOT,
  { check = false, allowStaleExport = false, strict = strictExports(), warn = console.warn } = {},
) {
  const fixture = JSON.parse(readFileSync(join(root, FIXTURE), "utf8"));
  const stale = staleSources(fixture, (path) => readFileSync(join(root, path)));
  if (stale.length) {
    if (!tolerated(root, stale, { check, allowStaleExport, strict }))
      throw new Error(staleMessage(stale));
    warn(`NOTICE: ${staleMessage(stale)}`);
  }
  return Object.fromEntries(
    Object.entries(fixture.schemas).map(([slug, schema]) => [
      slug,
      { schema, fields: schemaFields(schema) },
    ]),
  );
}
// For a Node output rendered from a stale fixture (pack-yml.schema.json): null unless the fixture is
// stale and modelSchemas' rule tolerates it, else `explains(name)`, whether a stale source still
// present names it (a field or variant the PR adds to the Rust model).
export function staleFixtureExplainer(
  root = ROOT,
  { check = false, allowStaleExport = false, strict = strictExports() } = {},
) {
  const stale = readStale(root);
  if (!stale.length || !tolerated(root, stale, { check, allowStaleExport, strict })) return null;
  return namesIn(() => addedSince(root, FIXTURE, stale));
}
// The model pin the tests read: the committed fixture, strict only with CS_STRICT_EXPORTS=1.
export const pinnedModels = (root = ROOT, env = process.env, warn = console.warn) =>
  modelSchemas(root, { check: strictExports(env), strict: strictExports(env), warn });
function output(path, content, check) {
  if (check) {
    if (readFileSync(path, "utf8") !== content)
      throw new Error(`${path} is stale; run pnpm gen:docs`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}
export function generate(
  check = false,
  { root = ROOT, allowStaleExport = false, strict = strictExports(), warn = console.warn } = {},
) {
  const models = modelSchemas(root, { check, allowStaleExport, strict, warn });
  for (const [slug, { schema }] of Object.entries(models))
    output(
      join(root, CONTENT, "generated/schemas", `${slug}.schema.json`),
      JSON.stringify(schema, null, 2) + "\n",
      check,
    );
  const page = join(root, CONTENT, "arc-g-routines/routine-yml.html");
  const current = readFileSync(page, "utf8");
  const esc = (s) =>
    String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const rows = models["routine-yml"].fields
    .map(
      (f) =>
        `<tr><td><code>${esc(f.name)}</code></td><td>${esc(f.type)}</td><td>${f.required ? "required" : "optional"}</td><td>${esc(f.description)}</td></tr>`,
    )
    .join("\n");
  const updated = current.replace(
    /<!-- model-fields:start -->[\s\S]*?<!-- model-fields:end -->/,
    `<!-- model-fields:start -->\n${rows}\n<!-- model-fields:end -->`,
  );
  if (!current.includes("<!-- model-fields:start -->"))
    throw new Error("routine.yml page is missing model field markers");
  output(page, updated, check);
  console.log(`generate-model-schemas: ${check ? "ok" : "generated serde schemas and field rows"}`);
}
// The exporter the stale message names, unqueued, for CI's export workflow. Cargo builds into the
// worktree's shared `target/`.
export function queuedExport({ spawn = spawnSync, gate = diskGate } = {}) {
  gate(ROOT);
  const result = spawn(
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
    { cwd: ROOT, stdio: "inherit", env: { ...process.env, UPDATE_DOCS_SCHEMAS: "1" } },
  );
  if (result.error)
    throw new Error(`Model schema export could not start cargo: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Model schema export failed (${result.status})`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--queued-export")) queuedExport();
  else generate(process.argv.includes("--check"), { allowStaleExport: switchedOn() });
}
