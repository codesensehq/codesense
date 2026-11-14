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
//
// What a failed build leaves behind. Every name, path, link, source and file is checked
// before the first write, so a validation failure writes nothing. A write that fails after
// that (a full disk, a directory where a copy goes, a leftover temporary name) stops the
// build with a named error and removes its temporary file; copies written before it stay,
// each whole, because every write is a temporary sibling and a rename. The guarantee is
// whole files and no stray temporary, not an all-or-nothing set: rerun the build to finish.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
  hermes: (name) => `.hermes/skills/${name}/SKILL.md`,
};

// The validator's per-file cap; a bigger file is reported, never read.
export const MAX_FILE = 5 * 1024 * 1024;

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

/**
 * Every file of the pack except `pack.yml`, sorted. Symlinks, `.git` (in any case),
 * anything that isn't a regular file and files over the cap are reported, never read.
 */
export function listPackFiles(dir) {
  const files = [];
  const problems = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const rel = relative(dir, path).split(sep).join("/");
      const stat = lstatSync(path);
      if (entry.name.toLowerCase() === ".git") problems.push(`${rel}: .git is not part of a pack`);
      else if (stat.isSymbolicLink()) problems.push(`${rel}: symlinks are refused`);
      else if (stat.isDirectory()) walk(path);
      else if (!stat.isFile()) problems.push(`${rel}: not a regular file`);
      else if (stat.size > MAX_FILE) problems.push(`${rel}: over the 5 MB file cap`);
      else if (rel !== "pack.yml") files.push(rel);
    }
  };
  walk(dir);
  return { files: files.sort(), problems };
}

/** Write through a temporary sibling and a rename, so a failed write leaves the old file. */
function writeAtomic(path, bytes) {
  const temp = join(dirname(path), `.${basename(path)}.pack-build-${process.pid}`);
  try {
    writeFileSync(temp, bytes, { flag: "wx" });
    renameSync(temp, path);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
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

/** `lstat` of a path, or null when it doesn't exist. */
function statOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

// Defense in depth for the target: `partErrors` has already fixed the name, and the
// `TARGET_PATHS` prefixes are constant, so a built copy can't leave the pack today.
const insidePack = (dir, rel) => {
  const full = resolve(dir, rel);
  return !rel.startsWith("/") && (full === dir || full.startsWith(dir + sep));
};

/** The first component of `rel` under `dir` that is a symlink, or null. */
function symlinkOnPath(dir, rel) {
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join("/");
    try {
      if (lstatSync(join(dir, sub)).isSymbolicLink()) return sub;
    } catch {
      return null;
    }
  }
  return null;
}

/** Duplicate ids, bad skill names and built copies that land on another part's file. */
function partErrors(manifest, copies) {
  const errors = [];
  const ids = new Set();
  for (const part of manifest.parts) {
    if (ids.has(part.id)) errors.push(`parts: duplicate id ${part.id}`);
    ids.add(part.id);
    if (part.kind === "skill" && !NAME.test(part.name ?? part.id))
      errors.push(`${part.id}: a skill name is [a-z0-9-]`);
  }
  const builtBy = new Map();
  for (const copy of copies) {
    const other = builtBy.get(copy.path);
    if (other && other !== copy.part)
      errors.push(`${copy.path} is built by both ${other} and ${copy.part}`);
    builtBy.set(copy.path, copy.part);
  }
  const partFiles = manifest.parts.flatMap((p) =>
    [p.file, p.from, p.kind === "skill" ? p.source : undefined].filter(Boolean),
  );
  for (const path of new Set(partFiles))
    if (builtBy.has(path))
      errors.push(`${builtBy.get(path)}: ${path} is both a built copy and a source`);
  return errors;
}

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
  let text;
  let manifest;
  try {
    const stat = lstatSync(manifestPath);
    if (stat.isSymbolicLink()) return { errors: ["pack.yml: symlinks are refused"], written };
    if (!stat.isFile()) return { errors: ["pack.yml: not a regular file"], written };
    text = readFileSync(manifestPath, "utf8");
  } catch (e) {
    return { errors: [`pack.yml: cannot read: ${e.message}`], written };
  }
  try {
    manifest = parse(text);
  } catch (e) {
    return { errors: [`pack.yml: cannot parse: ${e.message.split("\n")[0]}`], written };
  }
  errors.push(...schemaErrors(manifest));
  if (errors.length) return { errors, written };

  const copies = skillCopies(manifest);
  const legacy = !force && copies.length === 0 && manifest.files === undefined;
  if (legacy) return { errors, written, legacy: true };

  errors.push(...partErrors(manifest, copies));
  for (const copy of copies) {
    if (!insidePack(dir, copy.source) || !insidePack(dir, copy.path))
      errors.push(`${copy.part}: ${copy.source} or ${copy.path} is outside the pack`);
    else
      for (const rel of [copy.source, copy.path]) {
        const link = symlinkOnPath(dir, rel);
        if (link) errors.push(`${link}: symlinks are refused`);
      }
  }
  // Nothing is read or written until every name, path and link is known to be safe.
  if (errors.length) return { errors, written };

  // Plan every change first; nothing is written unless the whole pack is clean.
  const plan = new Map();
  for (const copy of copies) {
    const sourcePath = join(dir, copy.source);
    const sourceStat = statOrNull(sourcePath);
    if (!sourceStat) {
      errors.push(`${copy.part}: skill source ${copy.source} is missing or outside the pack`);
      continue;
    }
    if (!sourceStat.isFile()) {
      errors.push(`${copy.source}: not a regular file`);
      continue;
    }
    const source = readFileSync(sourcePath);
    const target = join(dir, copy.path);
    const current = statOrNull(target)?.isFile() ? readFileSync(target) : null;
    if (current && sha256(current) === sha256(source)) continue;
    if (check)
      errors.push(
        current
          ? `drift: ${copy.path} differs from ${copy.source}`
          : `drift: ${copy.path} is missing (build from ${copy.source})`,
      );
    else plan.set(copy.path, source);
  }
  const { files: present, problems } = listPackFiles(dir);
  errors.push(...problems);
  if (errors.length) return { errors, written };

  // The files list as it will be once the planned copies are written (new files, mode 644).
  const files = [...new Set([...present, ...plan.keys()])].sort();
  const wanted = files.map((path) => {
    if (plan.has(path)) return { path, sha256: sha256(plan.get(path)), exec: false };
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
  const relist = JSON.stringify(listed) !== JSON.stringify(wanted);
  if (relist && check) {
    const seen = new Set();
    for (const f of listed) {
      if (seen.has(f.path)) errors.push(`files: ${f.path} is listed twice`);
      seen.add(f.path);
    }
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
  }
  errors.push(...chatCodeErrors(dir, manifest, present));
  if (errors.length || check) return { errors, written };

  const write = (path, bytes) => {
    try {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeAtomic(join(dir, path), bytes);
      written.push(path);
    } catch (e) {
      errors.push(`${path}: cannot write: ${e.code ?? e.message.split("\n")[0]}`);
    }
    return errors.length === 0;
  };
  for (const [path, bytes] of plan) if (!write(path, bytes)) return { errors, written };
  if (relist) {
    const doc = parseDocument(text);
    doc.set("files", doc.createNode(wanted));
    write("pack.yml", doc.toString({ lineWidth: 0 }));
  }
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
    for (const e of new Set(errors)) console.error(`pack-build: ${name}: ${e}`);
    for (const w of written) console.log(`pack-build: ${name}: wrote ${w}`);
    if (errors.length) failed = true;
  }
  if (!failed) console.log(`pack-build: ${check ? "ok" : "built"} (${dirs.length} packs)`);
  return !failed;
}

/** `--check`, `--pack <dir>`, `--root <dir>`; anything else throws. */
export function parseArgs(args) {
  const out = { check: false, pack: undefined, root: undefined };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--check") out.check = true;
    else if (flag === "--pack" || flag === "--root") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`pack-build: ${flag} needs a folder`);
      out[flag.slice(2)] = resolve(value);
    } else throw new Error(`pack-build: unknown argument ${flag}`);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const dirs = args.pack ? [args.pack] : packDirs(args.root ?? PACKS_ROOT);
  process.exit(run(dirs, { check: args.check, force: !!args.pack }) ? 0 : 1);
}
