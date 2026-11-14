// SPDX-License-Identifier: MIT
// The probe registry in `lib/pack-steps.mjs` lists what each probed tool returns. A tool's
// description is written by hand beside its handler and can drift from it, so these tests
// read the handlers' Rust source and fail when a registry field isn't one they serialise.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { PACKS_ROOT, ROOT } from "./pack-build.mjs";
import { PROBE_TOOLS } from "./lib/pack-steps.mjs";

const rust = (rel) => readFileSync(join(ROOT, "src-tauri/src", rel), "utf8");
const camel = (name) => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/** The text of the `{…}` block that opens at or after `from`. */
function block(text, from) {
  const open = text.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`unclosed block at ${from}`);
}

/** Each `#[serde(rename_all = "camelCase")]` struct in `source`: its fields and their types. */
function structs(source) {
  const found = {};
  for (const m of source.matchAll(/pub struct (\w+)\s*\{/g)) {
    const body = block(source, m.index);
    assert.ok(!/serde\(\s*rename\s*=/.test(body), `${m[1]} renames a field; read it here`);
    found[m[1]] = [...body.matchAll(/pub (\w+):\s*([^,\n]+),/g)].map(([, name, type]) => ({
      name: camel(name),
      type: type.trim(),
    }));
  }
  return found;
}

/** Every field path a struct serialises, in the registry's `a[].b` form. */
function paths(all, name, prefix = "") {
  return all[name].flatMap(({ name: field, type }) => {
    const list = /^Vec<(\w+)>$/.exec(type);
    const inner = list?.[1] ?? /^(?:Option<)?(\w+)>?$/.exec(type)?.[1];
    const here = `${prefix}${field}${list ? "[]" : ""}`;
    return inner in all ? [here, ...paths(all, inner, `${here}.`)] : [here];
  });
}

/** Every JSON key a piece of Rust writes with `json!`, `insert` or `row["…"] =`. */
function jsonKeys(text) {
  const keys = new Set();
  for (const re of [/"(\w+)"\s*:/g, /insert\(\s*"(\w+)"/g, /\["(\w+)"\]\s*=/g])
    for (const m of text.matchAll(re)) keys.add(m[1]);
  return keys;
}

const fnBody = (source, signature) => {
  const at = source.indexOf(signature);
  assert.ok(at >= 0, `${signature} is in the source`);
  return block(source, at);
};

const SETUP = rust("mcp/setup_tools.rs");

test("describe_setup: every registry field is one the SetupState structs serialise", () => {
  const known = new Set(paths(structs(SETUP), "SetupState"));
  for (const field of PROBE_TOOLS.describe_setup.fields)
    assert.ok(known.has(field), `describe_setup returns no ${field}`);
});

test("describe_setup: the drift check reads the real structs, and would catch a renamed field", () => {
  const known = new Set(paths(structs(SETUP), "SetupState"));
  for (const field of [
    "orgs[].teams[].parentTeam",
    "orgs[].teams[].sourceRepos[].slug",
    "orgs[].teams[].sourceRepos[].attachment",
  ])
    assert.ok(known.has(field), field);
  for (const stale of [
    "orgs[].teams[].parent",
    "orgs[].teams[].sourceRepos[].repo",
    "orgs[].teams[].sourceRepos[].status",
  ])
    assert.ok(!known.has(stale), stale);
});

test("list_source_repos: every registry field is a key its handler writes", () => {
  const handler = rust("mcp/handler.rs");
  const keys = jsonKeys(
    fnBody(handler, "async fn list_source_repos(") +
      fnBody(rust("mcp/story_authoring.rs"), "pub fn source_repos_payload("),
  );
  for (const field of PROBE_TOOLS.list_source_repos.fields)
    for (const key of field.replace(/\[\]/g, "").split("."))
      assert.ok(keys.has(key), `list_source_repos writes no ${key} (${field})`);
});

test("records_list: every registry field is a key the list operation writes", () => {
  const binding = rust("records/binding.rs");
  const list = binding.slice(binding.indexOf('"list" =>'), binding.indexOf('"read" =>'));
  const keys = jsonKeys(list + fnBody(rust("records/projection.rs"), "fn projected("));
  for (const field of PROBE_TOOLS.records_list.fields)
    for (const key of field.replace(/\[\]|\.\*$/g, "").split("."))
      assert.ok(keys.has(key), `records_list writes no ${key} (${field})`);
});

test("the source-repos step maps every attachment state describe_setup reports", () => {
  const variants = [
    ...block(SETUP, SETUP.indexOf("pub enum AttachmentStatus")).matchAll(/^\s*(\w+),/gm),
  ].map(([, v]) => v[0].toLowerCase() + v.slice(1));
  assert.deepEqual(variants.sort(), ["attached", "missing", "unattached"]);
  const s = parse(
    readFileSync(join(PACKS_ROOT, "codesense-guide/setup/steps/source-repos.yml"), "utf8"),
  );
  const probe = s.probe.find((p) => p.id === "repos");
  assert.equal(probe.yields.attachment, "orgs[].teams[].sourceRepos[].attachment");
  for (const v of variants) assert.ok(probe.map[v], `source-repos maps ${v}`);
  assert.equal(probe.map.attached, "done", "a bound clone is a done step on a re-run");
});
