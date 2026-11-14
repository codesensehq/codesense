#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The CodeSense setup page: `content/guide/guide.js` is its source, and `content/guide/index.html`
// carries it inline between two markers. The app grants the page the right to open a team agent
// from the page file's own bytes (`PAGES` in `foreman_launch.rs`), so every line it runs has to be
// in that one file: a sibling script would not be covered by the hash.
//
//   node scripts/guide-page.mjs --check   drift check (build time, in `gen:docs:check`)
//   node scripts/guide-page.mjs --write   inline guide.js and update the page's `PAGES` hash
//
// The checks, each of which fails the build:
//   1. the page's inline script is exactly guide.js;
//   2. the page loads no script or style sheet but the kit's own (`/kit/v1/`) and its one inline
//      script, quoted or not, and has no <base>, @import or <iframe> to load or re-point others;
//   3. the page's sha256 equals its `PAGES` entry, and the docs bundle ships exactly these bytes,
//      so neither a page edit nor a docs update can silently drop the grant.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTree } from "./build-codesense-docs.mjs";
import { isMain } from "./lib/is-main.mjs";
import { DOCS_ROOT, LAUNCH_RS, launchPages } from "./lib/pinned-pages.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACK = "codesense-docs/packs/codesense-guide";
export const SOURCE = `${PACK}/content/guide/guide.js`;
export const TEMPLATE = `${PACK}/content/guide/index.html`;
// The page's path inside the placed docs checkout: the key of its `PAGES` entry.
export const PAGE = "getting-started/content/guide/index.html";
export const FILES = [SOURCE, TEMPLATE, `${DOCS_ROOT}/${PAGE}`, LAUNCH_RS];

const BEGIN = "/* guide.js:begin */\n";
const END = "\n/* guide.js:end */";
const INLINE = new RegExp(
  `${BEGIN.replace(/[*/]/g, "\\$&")}([\\s\\S]*?)${END.replace(/[*/]/g, "\\$&")}`,
);

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const read = (rel, root = ROOT) => readFileSync(join(root, rel), "utf8");

/** The page with `source` between its markers; throws when the source would end the inline script. */
export function pageText(template, source) {
  if (/<\/script|<!--/i.test(source))
    throw new Error("guide.js holds a sequence that would end its inline script");
  if (!INLINE.test(template)) throw new Error("index.html has no guide.js markers");
  return template.replace(INLINE, () => `${BEGIN}${source.replace(/\n+$/, "")}${END}`);
}

/** Each `attr` value on a `tag` element, quoted or not. */
const attrValues = (html, tag, attr) =>
  [
    ...html.matchAll(
      new RegExp(`<${tag}\\b[^>]*\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "gi"),
    ),
  ].map((match) => match[1] ?? match[2] ?? match[3]);

/**
 * Every drift problem as a message; empty when guide.js, the page and the grant agree.
 * `bundled` gives the page's bytes as the docs bundle ships them.
 */
export function problems(root = ROOT, bundled = () => buildTree().get(PAGE)) {
  const missing = FILES.filter((rel) => !existsSync(join(root, rel)));
  if (missing.length) return missing.map((rel) => `${rel}: missing`);
  const out = [];
  const html = read(TEMPLATE, root);
  const inline = INLINE.exec(html);
  if (!inline) return [`${TEMPLATE}: no guide.js markers`];
  let expected;
  try {
    expected = pageText(html, read(SOURCE, root));
  } catch (error) {
    return [`${SOURCE}: ${error.message}`];
  }
  if (html !== expected)
    out.push(
      `${TEMPLATE}: its inline script is not ${SOURCE}; run node scripts/guide-page.mjs --write`,
    );
  for (const src of attrValues(html, "script", "src"))
    if (!src.startsWith("/kit/v1/"))
      out.push(`${TEMPLATE}: loads ${src}; a script the page's hash does not cover`);
  if ((html.match(/<script\b(?![^>]*\ssrc\s*=)/gi) ?? []).length !== 1)
    out.push(`${TEMPLATE}: must hold exactly one inline script`);
  if (attrValues(html, "link", "href").some((href) => !href.startsWith("/kit/v1/")))
    out.push(`${TEMPLATE}: links a style sheet other than the kit's`);
  // Each would load or re-point bytes the page's hash does not cover.
  if (/<base\b/i.test(html)) out.push(`${TEMPLATE}: has a <base>, which re-points the kit's URLs`);
  if (/@import\b/i.test(html)) out.push(`${TEMPLATE}: its style has an @import`);
  if (/<iframe\b/i.test(html)) out.push(`${TEMPLATE}: has an <iframe>`);
  const pageBytes = readFileSync(join(root, DOCS_ROOT, PAGE));
  if (!bundled().equals(pageBytes))
    out.push(
      `${DOCS_ROOT}/${PAGE}: the docs bundle ships other bytes than this file, so its PAGES hash would never match`,
    );
  const entry = launchPages(read(LAUNCH_RS, root)).find((p) => p.path === PAGE);
  const pageSha = sha256(pageBytes);
  if (!entry)
    out.push(`${LAUNCH_RS}: no PAGES entry for ${PAGE}; the page could not open its agent`);
  else if (entry.sha256 !== pageSha)
    out.push(
      `${LAUNCH_RS}: PAGES hash ${entry.sha256} is not the page's ${pageSha}; update the entry`,
    );
  return out;
}

function main(argv) {
  const mode = argv[0];
  if (mode === "--check") {
    const found = problems();
    if (found.length) {
      console.error(`Guide page drift:\n- ${found.join("\n- ")}`);
      process.exit(1);
    }
    return;
  }
  if (mode !== "--write") throw new Error("usage: guide-page.mjs --check | --write");
  const page = pageText(read(TEMPLATE), read(SOURCE));
  writeFileSync(join(ROOT, TEMPLATE), page);
  // The docs bundle's copy and the pack's recorded hash follow from `pack-build.mjs`.
  const launch = read(LAUNCH_RS);
  const entry = launchPages(launch).find((p) => p.path === PAGE);
  if (!entry) throw new Error(`${LAUNCH_RS}: no PAGES entry for ${PAGE} to update`);
  const sha = sha256(page);
  writeFileSync(join(ROOT, LAUNCH_RS), launch.replace(`"${entry.sha256}"`, `"${sha}"`));
  console.log(`${PAGE} sha256:${sha}, written to its PAGES entry in ${LAUNCH_RS}`);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
