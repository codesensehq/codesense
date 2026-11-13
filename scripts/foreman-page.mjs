#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The bundled Foreman page: one self-contained file, `getting-started/content/foreman/index.html`,
// that inlines a vendored build of the story-view kit. Everything the app trusts about the page is
// its own bytes, so it loads no sibling script or style.
//
//   node scripts/foreman-page.mjs --check            drift check (build time, in `gen:docs:check`)
//   node scripts/foreman-page.mjs --write            rebuild the page from the vendored kit
//   node scripts/foreman-page.mjs --vendor <file> --kit-rev <n>
//                                                    vendor a kit build, then rebuild the page
//
// The checks, each of which fails the build:
//   1. the vendored file's header sha256 is the hash of the rest of the file and equals `pack.yml`;
//   2. the kit's baked-in config equals the pack's public config (no team ids, no budget keys);
//   3. the page is exactly the template with the vendored file inlined;
//   4. the page's sha256 equals its `PAGES` entry in `foreman_launch.rs`, so a docs update that
//      changes the page without the matching entry cannot silently drop the `foreman.launch` grant.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { applyMetadata } from "./generate-docs-metadata.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PACK = "codesense-docs/packs/codesense-foreman";
export const VENDORED = `${PACK}/vendor/story-view.js`;
export const CONFIG = `${PACK}/story-view.yml`;
export const PACK_YML = `${PACK}/pack.yml`;
export const DOCS_ROOT = "codesense-docs";
// The page's path inside the placed docs checkout: the key of its `PAGES` entry.
export const PAGE = "getting-started/content/foreman/index.html";
// The page's path inside the docs content folder.
const PAGE_IN_CONTENT = PAGE.slice("getting-started/content/".length);
export const LAUNCH_RS = "src-tauri/src/verbs/foreman_launch.rs";

// What the page declares. `foreman.launch` is not here: the app mints it from the page's bytes.
export const CAPABILITIES = [
  "sessions:read",
  "inbox:read:team",
  "inbox:write",
  "context:read",
  "launch",
  "machines:read",
];

const HEADER = /^\/\/ vendored story-view build kit-rev:(\d+) sha256:([0-9a-f]{64})\n/;
const FORBIDDEN_KEY = /(^|[^a-z])(point|points|envelope|budget)([^a-z]|$)|\$/i;
// A local path in the vendored kit.
const LOCAL_PATH = /\/Users\/|~\/\.codesense/;

// The kit's comments cite its private tracker's story ids; the public scan refuses them, so vendoring replaces each.
const STORY_ID = /\bSV-[A-Z]+-\d+[a-z]?\b/g;
export const withoutStoryIds = (body) => body.replace(STORY_ID, "[ref]");

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const read = (rel, root = ROOT) => readFileSync(join(root, rel), "utf8");

/** Split a vendored file into its header fields and body. */
export function parseVendored(text) {
  const match = HEADER.exec(text);
  if (!match) return null;
  const body = text.slice(match[0].length);
  return { kitRev: Number(match[1]), headerSha: match[2], body, actualSha: sha256(body) };
}

export function vendoredText(body, kitRev) {
  return `// vendored story-view build kit-rev:${kitRev} sha256:${sha256(body)}\n${body}`;
}

/** The kit bakes its config between these markers as one JSON object. */
export function bakedConfig(body) {
  const match = /\/\* CONFIG:begin \*\/\s*const CONFIG=([\s\S]*?);\s*\/\* CONFIG:end \*\//.exec(
    body,
  );
  return match ? JSON.parse(match[1]) : null;
}

const keysOf = (value, prefix = "") =>
  value && typeof value === "object"
    ? Object.entries(value).flatMap(([key, child]) => [
        prefix + key,
        ...keysOf(child, `${prefix}${key}.`),
      ])
    : [];

export function pageText(vendored) {
  const { body } = parseVendored(vendored);
  if (/<\/script|<!--/i.test(body))
    throw new Error("the vendored kit holds a sequence that would end its inline script");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="codesense:capabilities" content="${CAPABILITIES.join(" ")}">
<meta name="story-view:foreman" content="">
<title>Foreman</title>
</head>
<body>
<script>
${vendored}</script>
</body>
</html>
`;
}

/** The `PAGES` entries of `foreman_launch.rs`, as `{path, sha256}`. */
export function launchPages(source) {
  const block = /pub const PAGES: &\[Page\] = &\[([\s\S]*?)\];/.exec(source);
  if (!block) throw new Error(`${LAUNCH_RS}: no PAGES list`);
  return [
    ...block[1].matchAll(/Page\s*\{\s*path:\s*"([^"]+)",\s*sha256:\s*"([0-9a-f]{64})",?\s*\}/g),
  ].map((m) => ({ path: m[1], sha256: m[2] }));
}

/** Every drift problem as a message; empty when the vendored kit, config, page and grant agree. */
export function problems(root = ROOT) {
  const out = [];
  const file = (rel) => existsSync(join(root, rel));
  for (const rel of [VENDORED, CONFIG, PACK_YML, `${DOCS_ROOT}/${PAGE}`, LAUNCH_RS]) {
    if (!file(rel)) out.push(`${rel}: missing`);
  }
  if (out.length) return out;
  const vendored = read(VENDORED, root);
  const parsed = parseVendored(vendored);
  if (!parsed)
    return [
      `${VENDORED}: the first line must be "// vendored story-view build kit-rev:<n> sha256:<hex>"`,
    ];
  if (parsed.actualSha !== parsed.headerSha)
    out.push(
      `${VENDORED}: header sha256 ${parsed.headerSha} is not the file's ${parsed.actualSha}`,
    );
  const kit = parse(read(PACK_YML, root))?.kit;
  if (!kit || kit.file !== "vendor/story-view.js")
    out.push(`${PACK_YML}: no kit entry for vendor/story-view.js`);
  else {
    if (kit.sha256 !== parsed.actualSha)
      out.push(
        `${PACK_YML}: kit sha256 ${kit.sha256} is not the vendored file's ${parsed.actualSha}`,
      );
    if (kit.kit_rev !== parsed.kitRev)
      out.push(`${PACK_YML}: kit_rev ${kit.kit_rev} is not the header's ${parsed.kitRev}`);
  }
  const config = parse(read(CONFIG, root));
  const baked = bakedConfig(parsed.body);
  if (JSON.stringify(baked) !== JSON.stringify(config))
    out.push(
      `${VENDORED}: the baked-in config differs from ${CONFIG}; rebuild the kit with that config`,
    );
  for (const key of keysOf(config))
    if (FORBIDDEN_KEY.test(key)) out.push(`${CONFIG}: "${key}" is a budget or point key`);
  // The public config's one team is the docs team the page ships in; any other team is someone's own.
  if (config.team !== config.foreman?.docs?.team)
    out.push(
      `${CONFIG}: team "${config.team}" is not the docs team "${config.foreman?.docs?.team}"; the config names no team of its own`,
    );
  if (withoutStoryIds(parsed.body) !== parsed.body)
    out.push(`${VENDORED}: cites a tracker story id; vendor it with --vendor, which replaces them`);
  if (LOCAL_PATH.test(parsed.body)) out.push(`${VENDORED}: names a local path`);
  let expected;
  try {
    expected = pageText(vendored);
  } catch (error) {
    return [...out, `${VENDORED}: ${error.message}`];
  }
  const page = readFileSync(join(root, DOCS_ROOT, PAGE), "utf8");
  if (page !== expected)
    out.push(`${DOCS_ROOT}/${PAGE}: not the template with the vendored kit inlined; run --write`);
  // The docs bundle step edits pages' bytes (metadata); the page the app places must still be this file.
  const placed = new Map([
    [`getting-started/content/${PAGE_IN_CONTENT}`, readFileSync(join(root, DOCS_ROOT, PAGE))],
  ]);
  applyMetadata(placed);
  if (
    !placed
      .get(`getting-started/content/${PAGE_IN_CONTENT}`)
      .equals(readFileSync(join(root, DOCS_ROOT, PAGE)))
  )
    out.push(
      `${DOCS_ROOT}/${PAGE}: the docs bundle step edits the page's bytes, so its PAGES hash would never match`,
    );
  const entry = launchPages(read(LAUNCH_RS, root)).find((p) => p.path === PAGE);
  const pageSha = sha256(readFileSync(join(root, DOCS_ROOT, PAGE)));
  if (!entry)
    out.push(`${LAUNCH_RS}: no PAGES entry for ${PAGE}; the page would not hold foreman.launch`);
  else if (entry.sha256 !== pageSha)
    out.push(
      `${LAUNCH_RS}: PAGES hash ${entry.sha256} is not the page's ${pageSha}; update the entry`,
    );
  return out;
}

/** Update the pack's `kit:` block; it sits at the end of `pack.yml`'s kit marker. */
export function packWithKit(text, kitRev, sha) {
  const block = `kit:\n  file: vendor/story-view.js\n  kit_rev: ${kitRev}\n  sha256: ${sha}\n`;
  const marker = /^kit:\n(?: {2}.*\n)*/m;
  return marker.test(text) ? text.replace(marker, block) : `${text.replace(/\n*$/, "\n")}${block}`;
}

function main(argv) {
  const mode = argv[0];
  if (mode === "--check") {
    const found = problems();
    if (found.length) {
      console.error(`Foreman page drift:\n- ${found.join("\n- ")}`);
      process.exit(1);
    }
    return;
  }
  if (mode === "--vendor") {
    const source = argv[1];
    const kitRev = Number(argv[argv.indexOf("--kit-rev") + 1]);
    if (!source || !Number.isInteger(kitRev) || kitRev < 1)
      throw new Error("usage: --vendor <built story-view.js> --kit-rev <n>");
    // A kit build may arrive with a header of its own (a re-vendor of a vendored file).
    const raw = readFileSync(source, "utf8");
    const body = withoutStoryIds(parseVendored(raw)?.body ?? raw);
    writeFileSync(join(ROOT, VENDORED), vendoredText(body, kitRev));
    writeFileSync(join(ROOT, PACK_YML), packWithKit(read(PACK_YML), kitRev, sha256(body)));
  } else if (mode !== "--write")
    throw new Error("usage: foreman-page.mjs --check | --write | --vendor <file> --kit-rev <n>");
  writeFileSync(join(ROOT, DOCS_ROOT, PAGE), pageText(read(VENDORED)));
  const sha = sha256(readFileSync(join(ROOT, DOCS_ROOT, PAGE)));
  const entry = new RegExp(`(path:\\s*"${PAGE}",\\s*sha256:\\s*")[0-9a-f]{64}(")`);
  const launch = read(LAUNCH_RS);
  if (!entry.test(launch)) throw new Error(`${LAUNCH_RS}: no PAGES entry for ${PAGE} to update`);
  writeFileSync(join(ROOT, LAUNCH_RS), launch.replace(entry, `$1${sha}$2`));
  console.log(`${PAGE} sha256:${sha}, written to its PAGES entry in ${LAUNCH_RS}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2));
