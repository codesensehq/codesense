#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The generic pack build. For every pack under a root (default `codesense-docs/packs`):
//   1. validate `pack.yml` against the schema the Rust model exports;
//   2. build each `kind: skill` part: its one source file, copied byte for byte to each
//      target runtime's own skill or command location, inside the pack;
//   3. write `files`: every bundled file with its sha256 and exec bit;
//   4. for a pack that asks for the shared chat (`requires.kit.chat`), check its page
//      source mounts `kit.chat` and builds no chat of its own.
// A pack with no skill part and no `files` is a legacy pack: schema-checked, never rewritten.
//
//   node scripts/pack-build.mjs            write the copies and `files`
//   node scripts/pack-build.mjs --check    change nothing; exit 1 on any drift or error
//   --root <dir>   a folder of packs (default codesense-docs/packs)
//   --pack <dir>   one pack folder (built even with no skill part: a fixture or a new pack)
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { parse, parseDocument } from "yaml";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PACKS_ROOT = join(ROOT, "codesense-docs/packs");
export const SCHEMA_PATH = join(
  ROOT,
  "codesense-docs/getting-started/content/generated/schemas/pack-yml.schema.json",
);

// Where a built copy of skill `name` lives in the pack, per target runtime. Keep in step
// with `SkillTarget::built_path` in src-tauri/src/packs/manifest.rs.
export const TARGET_PATHS = {
  claude: (name) => `.claude/skills/${name}/SKILL.md`,
  codex: (name) => `.agents/skills/${name}/SKILL.md`,
  opencode: (name) => `.opencode/command/${name}.md`,
};

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

let ajv;
function schemaAjv() {
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true, strict: false });
    ajv.addFormat("uint32", {
      type: "number",
      validate: (n) => Number.isInteger(n) && n >= 0 && n <= 4294967295,
    });
    ajv.addSchema(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")), "pack");
  }
  return ajv;
}

// A part is a tagged union (`oneOf`, one branch per `kind`); a generic validation reports
// every branch's failures. So the parts are checked one at a time against the branch their
// own `kind` selects, and the rest of the manifest against the root.
export function schemaErrors(manifest) {
  const ajv = schemaAjv();
  const root = ajv.getSchema("pack");
  const branches = root.schema.$defs.Part.oneOf;
  const errors = [];
  root(manifest);
  for (const e of root.errors ?? [])
    if (!e.instancePath.startsWith("/parts/"))
      errors.push(`pack.yml${e.instancePath} ${e.message}`);
  (Array.isArray(manifest?.parts) ? manifest.parts : []).forEach((part, i) => {
    const branch = branches.findIndex((b) => b.properties.kind.const === part?.kind);
    if (branch < 0) return errors.push(`pack.yml/parts/${i} has an unknown kind: ${part?.kind}`);
    const validate = ajv.getSchema(`pack#/$defs/Part/oneOf/${branch}`);
    if (!validate(part))
      for (const e of validate.errors)
        errors.push(`pack.yml/parts/${i}${e.instancePath} ${e.message}`);
  });
  return errors;
}

/** Every file of the pack except `pack.yml`, sorted; symlinks and `.git` are reported. */
export function listPackFiles(dir) {
  const files = [];
  const problems = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const rel = relative(dir, path).split(sep).join("/");
      if (entry.name === ".git") problems.push(`${rel}: .git is not part of a pack`);
      else if (lstatSync(path).isSymbolicLink()) problems.push(`${rel}: symlinks are refused`);
      else if (entry.isDirectory()) walk(path);
      else if (rel !== "pack.yml") files.push(rel);
    }
  };
  walk(dir);
  return { files: files.sort(), problems };
}

export function skillCopies(manifest) {
  const copies = [];
  for (const part of manifest.parts ?? []) {
    if (part.kind !== "skill") continue;
    const name = part.name ?? part.id;
    for (const target of part.targets ?? []) {
      const path = TARGET_PATHS[target]?.(name);
      if (path) copies.push({ part: part.id, name, target, source: part.source, path });
    }
  }
  return copies;
}

const insidePack = (dir, rel) => {
  const full = resolve(dir, rel);
  return !rel.startsWith("/") && (full === dir || full.startsWith(dir + sep));
};

/** The page-source rule for a pack that mounts the shared chat. */
const SECOND_CHAT = [
  [/<textarea\b/i, "a composer (<textarea>)"],
  [/role\s*=\s*["']log["']/i, 'a message list (role="log")'],
  [/\bscrollTop\s*=(?!=)/, "its own scrolling (scrollTop =)"],
  [/\bparseCard\s*\(|```card/, "card parsing"],
];
export function chatCodeErrors(dir, manifest, files) {
  if (manifest.requires?.kit?.chat === undefined || manifest.requires?.kit?.chat === null)
    return [];
  const pages = files.filter((f) => /^content\/.*\.(html|js|mjs)$/.test(f));
  const errors = [];
  let mounts = false;
  for (const rel of pages) {
    const text = readFileSync(join(dir, rel), "utf8");
    if (/\bkit\.chat\b/.test(text)) mounts = true;
    for (const [pattern, what] of SECOND_CHAT)
      if (pattern.test(text)) errors.push(`${rel}: builds ${what}; the page must use kit.chat`);
  }
  if (!mounts) errors.push("requires.kit.chat, but no page under content/ uses kit.chat");
  return errors;
}

/**
 * Build or check one pack folder. Returns the problems found and the files written.
 * `check` writes nothing.
 */
export function buildPack(dir, { check = false, force = false } = {}) {
  dir = resolve(dir);
  const errors = [];
  const written = [];
  const manifestPath = join(dir, "pack.yml");
  const text = readFileSync(manifestPath, "utf8");
  const manifest = parse(text);
  errors.push(...schemaErrors(manifest));
  if (errors.length) return { errors, written };

  const copies = skillCopies(manifest);
  const legacy = !force && copies.length === 0 && manifest.files === undefined;
  if (legacy) return { errors, written, legacy: true };

  const ids = new Set();
  for (const part of manifest.parts) {
    if (ids.has(part.id)) errors.push(`parts: duplicate id ${part.id}`);
    ids.add(part.id);
    if (part.kind === "skill" && !NAME.test(part.name ?? part.id))
      errors.push(`${part.id}: a skill name is [a-z0-9-]`);
  }
  for (const copy of copies) {
    if (!insidePack(dir, copy.source) || !existsSync(join(dir, copy.source))) {
      errors.push(`${copy.part}: skill source ${copy.source} is missing or outside the pack`);
      continue;
    }
    const source = readFileSync(join(dir, copy.source));
    const target = join(dir, copy.path);
    const current = existsSync(target) ? readFileSync(target) : null;
    if (current && sha256(current) === sha256(source)) continue;
    if (check)
      errors.push(
        current
          ? `drift: ${copy.path} differs from ${copy.source}`
          : `drift: ${copy.path} is missing (build from ${copy.source})`,
      );
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source);
      written.push(copy.path);
    }
  }
  if (errors.length) return { errors, written };

  const { files, problems } = listPackFiles(dir);
  errors.push(...problems);
  const wanted = files.map((path) => {
    const full = join(dir, path);
    return {
      path,
      sha256: sha256(readFileSync(full)),
      exec: (lstatSync(full).mode & 0o111) !== 0,
    };
  });
  const listed = (manifest.files ?? []).map((f) => ({
    path: f.path,
    sha256: f.sha256,
    exec: !!f.exec,
  }));
  if (JSON.stringify(listed) !== JSON.stringify(wanted)) {
    if (check) {
      const byPath = new Map(listed.map((f) => [f.path, f]));
      for (const f of wanted) {
        const had = byPath.get(f.path);
        if (!had) errors.push(`files: ${f.path} is not listed`);
        else if (had.sha256 !== f.sha256) errors.push(`files: ${f.path} hash differs`);
        else if (had.exec !== f.exec) errors.push(`files: ${f.path} exec bit differs`);
      }
      for (const f of listed)
        if (!wanted.some((w) => w.path === f.path))
          errors.push(`files: ${f.path} is listed but missing`);
      if (!errors.length) errors.push("files: order differs; run the pack build");
    } else {
      const doc = parseDocument(text);
      doc.set("files", doc.createNode(wanted));
      writeFileSync(manifestPath, doc.toString({ lineWidth: 0 }));
      written.push("pack.yml");
    }
  }
  errors.push(...chatCodeErrors(dir, manifest, files));
  return { errors, written };
}

/** Pack folders under `root`: each direct child with a `pack.yml`. */
export function packDirs(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "pack.yml")))
    .map((e) => join(root, e.name))
    .sort();
}

export function run(dirs, { check, force = false }) {
  let failed = false;
  for (const dir of dirs) {
    const name = relative(ROOT, dir) || dir;
    const { errors, written, legacy } = buildPack(dir, { check, force });
    if (legacy)
      console.log(`pack-build: ${name}: legacy pack (no skill parts, no files), schema ok`);
    for (const e of errors) console.error(`pack-build: ${name}: ${e}`);
    for (const w of written) console.log(`pack-build: ${name}: wrote ${w}`);
    if (errors.length) failed = true;
  }
  if (!failed) console.log(`pack-build: ${check ? "ok" : "built"} (${dirs.length} packs)`);
  return !failed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? resolve(args[i + 1]) : undefined;
  };
  const pack = value("--pack");
  const dirs = pack ? [pack] : packDirs(value("--root") ?? PACKS_ROOT);
  process.exit(run(dirs, { check: args.includes("--check"), force: !!pack }) ? 0 : 1);
}
