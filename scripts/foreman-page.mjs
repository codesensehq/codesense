#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The bundled Foreman page: one self-contained file, `getting-started/content/foreman/index.html`,
// that inlines a vendored build of the story-view kit. Everything the app trusts about the page is
// its own bytes, so it loads no sibling script or style.
//
//   node scripts/foreman-page.mjs --check            drift check (build time, in `gen:docs:check`)
//   node scripts/foreman-page.mjs --write            rebuild the page from the vendored kit
//   node scripts/foreman-page.mjs --vendor <file> --kit-rev <n> --kit-config <kit's story-view.yml>
//                                                    vendor a kit build, then rebuild the page
//
// The checks, each of which fails the build:
//   1. the vendored file's header sha256 is the hash of the rest of the file and equals `pack.yml`;
//   2. the kit's baked-in config equals the pack's public config (no team ids, no budget keys),
//      and the config has every `foreman.*` and `timers.*` key and Foreman block entry the kit reads;
//   3. the page is exactly the template with the vendored file inlined;
//   4. the page's sha256 equals its `PAGES` entry in `foreman_launch.rs`, and the docs bundle ships
//      exactly these bytes, so a docs update cannot silently drop the `foreman.launch` grant;
//   5. the vendored kit keeps no comment but its config markers, and names no tracker id, local
//      path, path in the kit's repository or source hash (`--vendor` drops the comments).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parse } from "yaml";
import { buildTree } from "./build-codesense-docs.mjs";
import { isMain } from "./lib/is-main.mjs";
import { constantProblems } from "./lib/foreman-constants.mjs";
import { DOCS_ROOT, LAUNCH_RS, launchPages } from "./lib/pinned-pages.mjs";

export { DOCS_ROOT, LAUNCH_RS, launchPages };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACK = "codesense-docs/packs/codesense-foreman";
export const VENDORED = `${PACK}/vendor/story-view.js`;
export const CONFIG = `${PACK}/story-view.yml`;
export const PACK_YML = `${PACK}/pack.yml`;
// The kit config's keys the Foreman page can read, recorded by --vendor from the kit's own
// story-view.yml: most are read through a local name, which no scan of the build sees.
export const CONFIG_KEYS = `${PACK}/vendor/config-keys.json`;
// The page's path inside the placed docs checkout: the key of its `PAGES` entry.
export const PAGE = "getting-started/content/foreman/index.html";
// Every file the drift check reads.
export const FILES = [VENDORED, CONFIG, CONFIG_KEYS, PACK_YML, `${DOCS_ROOT}/${PAGE}`, LAUNCH_RS];

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
// What the kit's source tree says about itself: a tracker id, a local path, a path in its own
// repository, or a source file's hash. None of it may reach the public page.
const PRIVATE_TEXT = [
  [/\b[A-Z]{2,}-[A-Z]{2,}-\d+[a-z]?\b/, "a tracker story id"],
  [/\/Users\/|~\/\.codesense/, "a local path"],
  // A team's own `design/<id>/…` files, which the kit reads at run time, are built from an id,
  // and its agent pages sit at `dashboards/agent-pages/<page>.html` in the team's content.
  [
    /\breviews\/|\bdashboards\/(?!agent-pages\/[a-z-]+\.html')|\bdesign\/(?!\$\{)|scripts\/story-view/,
    "a path in the kit's repository",
  ],
  [/sha256:[0-9a-f]{64}/, "a source file's hash"],
];
// The two comments the kit's config is found between (`bakedConfig`); every other one goes.
const KEPT_COMMENTS = new Set(["/* CONFIG:begin */", "/* CONFIG:end */"]);

const sourceFile = (body) =>
  ts.createSourceFile("kit.js", body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
// The parser's own nodes, without the JSDoc it hangs on them (that is comment text).
const children = (node, file) => node.getChildren(file).filter((child) => !ts.isJSDoc(child));

/** Every comment in a script, as `[start, end]`, read by a parser so strings and regexes are never mistaken for one. */
export function comments(body) {
  const file = sourceFile(body);
  const out = [];
  const trivia = (pos) => {
    for (const read of [ts.getLeadingCommentRanges, ts.getTrailingCommentRanges])
      for (const range of read(body, pos) ?? []) out.push([range.pos, range.end]);
  };
  const visit = (node) => {
    trivia(node.pos);
    for (const child of children(node, file)) visit(child);
  };
  visit(file);
  trivia(file.endOfFileToken.pos);
  return [...new Map(out.map((range) => [range.join(), range])).values()].sort(
    (a, b) => a[0] - b[0],
  );
}

/**
 * Every token's kind and text, and whether a line break comes before it (automatic semicolons
 * depend on that), which a change to comments alone leaves equal.
 */
function tokens(body) {
  const file = sourceFile(body);
  if (file.parseDiagnostics.length)
    throw new Error(`the kit build does not parse: ${file.parseDiagnostics[0].messageText}`);
  const out = [];
  const visit = (node) => {
    const nodes = children(node, file);
    if (nodes.length) for (const child of nodes) visit(child);
    else {
      const broken =
        out.length > 0 && /[\n\r\u2028\u2029]/.test(body.slice(node.pos, node.getStart(file)));
      out.push(`${broken ? "\n" : ""}${node.kind}:${node.getText(file)}`);
    }
  };
  visit(file);
  return out;
}

/** A style sheet without its comments (and the line break after one); a quoted `/*` is text and stays. */
export function withoutCssComments(css) {
  let out = "";
  for (let i = 0; i < css.length; ) {
    if (css[i] === '"' || css[i] === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== css[i] && css[j] !== "\n") j += css[j] === "\\" ? 2 : 1;
      out += css.slice(i, j + 1);
      i = j + 1;
    } else if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 2;
      if (css[i] === "\n") i++;
    } else out += css[i++];
  }
  return out;
}

/**
 * The kit build as the public page carries it: its comments are about the kit's own source tree,
 * so they go (but the config markers), and so do the comments in its inlined style sheet. The code
 * itself is unchanged, which is checked token by token.
 */
export function publicBuild(body) {
  const styled = body.replace(
    /^const STYLE=(".*");$/m,
    (_, css) => `const STYLE=${JSON.stringify(withoutCssComments(JSON.parse(css)))};`,
  );
  let out = styled;
  for (const [start, end] of comments(styled).reverse()) {
    if (KEPT_COMMENTS.has(styled.slice(start, end))) continue;
    const lineStart = styled.lastIndexOf("\n", start - 1) + 1;
    const leading = !styled.slice(lineStart, start).trim();
    if (leading && /^(\n|$)/.test(styled.slice(end))) {
      out = out.slice(0, lineStart) + out.slice(end + 1);
      continue;
    }
    // Keep a line break the comment held, so automatic semicolons fall where they did.
    const gap = styled.slice(start, end).includes("\n") ? "\n" : "";
    const after = leading || gap ? out.slice(end).replace(/^[ \t]+/, "") : out.slice(end);
    out = out.slice(0, start).replace(/[ \t]+$/, "") + gap + after;
  }
  if (tokens(out).join("\n") !== tokens(styled).join("\n"))
    throw new Error("removing the kit's comments changed its code");
  return out;
}

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

const MEMBER = /^(?:\.[A-Za-z_$][\w$]*)*/;
const at = (value, path) =>
  path
    .split(".")
    .reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), value);

/**
 * The config paths the vendored kit's Foreman page reads: every `config.foreman.…` and
 * `config.timers.…` member chain (the timers are shared with the kit's other pages),
 * and for each block its template mounts, the block's `title` and `empty` and every
 * `blocks.<id>.…` chain. A computed member (`views[name]`) ends a chain. The kit bakes the config
 * it was built with, so a key missing here is a page that reads `undefined`.
 */
export function configReads(body) {
  const paths = new Set();
  for (const match of body.matchAll(/\bconfig\.(foreman|timers)((?:\.[A-Za-z_$][\w$]*)+)/g))
    paths.add(`${match[1]}${match[2]}`);
  const ids = templateBlocks(body);
  for (const id of ids) paths.add(`blocks.${id}.title`).add(`blocks.${id}.empty`);
  for (const match of body.matchAll(/\bblocks(?:\.([a-z][\w$]*)|\[(['"])([a-z][a-z0-9-]*)\2\])/g)) {
    const id = match[1] ?? match[3];
    const chain = MEMBER.exec(body.slice(match.index + match[0].length))[0];
    if (ids.has(id)) paths.add(`blocks.${id}${chain}`);
  }
  return [...paths].sort();
}

const leaves = (value, prefix) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).flatMap(([key, child]) => leaves(child, `${prefix}.${key}`))
    : [prefix];

/** The Foreman template's blocks, as the build `body` mounts them. */
const templateBlocks = (body) => {
  const template = /\bFOREMAN_TEMPLATE=`([^`]*)`/.exec(body)?.[1] ?? "";
  return new Set([...template.matchAll(/data-block="([a-z][a-z0-9-]*)"/g)].map((m) => m[1]));
};

/**
 * Every leaf key of the kit's own config (`kit`) under `foreman`, `timers` and the `blocks:`
 * entries of the blocks the Foreman template in `body` mounts. An array is one leaf.
 */
export function kitConfigKeys(kit, body) {
  const roots = [
    ["foreman", kit.foreman],
    ["timers", kit.timers],
    ...[...templateBlocks(body)].map((id) => [`blocks.${id}`, kit.blocks?.[id]]),
  ];
  return roots.flatMap(([at, value]) => (value === undefined ? [] : leaves(value, at))).sort();
}

/**
 * Why `kitText` can't be the kit's own config, given the public one, or null. The public config
 * passed as the kit's would record the public keys and check the config against itself.
 */
export function kitConfigProblem(kitText, publicText) {
  if (kitText === publicText)
    return "--kit-config is this folder's story-view.yml, not the kit's own";
  const team = parse(kitText)?.team;
  if (team === parse(publicText)?.team)
    return `--kit-config's team "${team}" is the public config's: pass the kit's own story-view.yml`;
  return null;
}

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
<meta name="story-view:foreman" content="launcher">
<title>Foreman</title>
</head>
<body>
<script>
${vendored}</script>
</body>
</html>
`;
}

/**
 * Every drift problem as a message; empty when the vendored kit, config, page and grant agree.
 * `bundled` gives the page's bytes as the docs bundle ships them.
 */
export function problems(root = ROOT, bundled = () => buildTree().get(PAGE)) {
  const out = FILES.filter((rel) => !existsSync(join(root, rel))).map((rel) => `${rel}: missing`);
  if (out.length) return out;
  const vendored = read(VENDORED, root);
  const kit = parseVendored(vendored);
  if (!kit)
    return [
      `${VENDORED}: the first line must be "// vendored story-view build kit-rev:<n> sha256:<hex>"`,
    ];
  if (kit.actualSha !== kit.headerSha)
    out.push(`${VENDORED}: header sha256 ${kit.headerSha} is not the file's ${kit.actualSha}`);
  const recorded = parse(read(PACK_YML, root))?.kit;
  if (!recorded || recorded.file !== "vendor/story-view.js")
    out.push(`${PACK_YML}: no kit entry for vendor/story-view.js`);
  else {
    if (recorded.sha256 !== kit.actualSha)
      out.push(
        `${PACK_YML}: kit sha256 ${recorded.sha256} is not the vendored file's ${kit.actualSha}`,
      );
    if (recorded.kit_rev !== kit.kitRev)
      out.push(`${PACK_YML}: kit_rev ${recorded.kit_rev} is not the header's ${kit.kitRev}`);
  }
  const config = parse(read(CONFIG, root));
  const baked = bakedConfig(kit.body);
  if (JSON.stringify(baked) !== JSON.stringify(config))
    out.push(
      `${VENDORED}: the baked-in config differs from ${CONFIG}; rebuild the kit with that config`,
    );
  const kitKeys = JSON.parse(read(CONFIG_KEYS, root));
  for (const path of new Set([...configReads(kit.body), ...kitKeys]))
    if (at(config, path) === undefined)
      out.push(
        `${CONFIG}: no "${path}", which the vendored kit reads; add it from the kit's own story-view.yml`,
      );
  for (const key of keysOf(config))
    if (FORBIDDEN_KEY.test(key)) out.push(`${CONFIG}: "${key}" is a budget or point key`);
  // The public config's one team is the docs team the page ships in; any other team is someone's own.
  if (config.team !== config.foreman?.docs?.team)
    out.push(
      `${CONFIG}: team "${config.team}" is not the docs team "${config.foreman?.docs?.team}"; the config names no team of its own`,
    );
  let kept, expected;
  try {
    kept = comments(kit.body).filter(
      ([start, end]) => !KEPT_COMMENTS.has(kit.body.slice(start, end)),
    );
    expected = pageText(vendored);
  } catch (error) {
    return [...out, `${VENDORED}: ${error.message}`];
  }
  if (kept.length)
    out.push(
      `${VENDORED}: keeps ${kept.length} of the kit's comments; vendor it with --vendor, which drops them`,
    );
  for (const [pattern, what] of PRIVATE_TEXT)
    if (pattern.test(kit.body)) out.push(`${VENDORED}: names ${what}`);
  const pageBytes = readFileSync(join(root, DOCS_ROOT, PAGE));
  if (pageBytes.toString("utf8") !== expected)
    out.push(`${DOCS_ROOT}/${PAGE}: not the template with the vendored kit inlined; run --write`);
  // The archive's docs bundle step may edit a page's bytes; the page the app places is what must hash to PAGES.
  if (!bundled().equals(pageBytes))
    out.push(
      `${DOCS_ROOT}/${PAGE}: the docs bundle ships other bytes than this file, so its PAGES hash would never match`,
    );
  const entry = launchPages(read(LAUNCH_RS, root)).find((p) => p.path === PAGE);
  const pageSha = sha256(pageBytes);
  if (!entry)
    out.push(`${LAUNCH_RS}: no PAGES entry for ${PAGE}; the page would not hold foreman.launch`);
  else if (entry.sha256 !== pageSha)
    out.push(
      `${LAUNCH_RS}: PAGES hash ${entry.sha256} is not the page's ${pageSha}; update the entry`,
    );
  return out;
}

/** Update the pack's `kit:` block; it sits at the end of `pack.yml`'s kit marker. */
function packWithKit(text, kitRev, sha) {
  const block = `kit:\n  file: vendor/story-view.js\n  kit_rev: ${kitRev}\n  sha256: ${sha}\n`;
  const marker = /^kit:\n(?: {2}.*\n)*/m;
  return marker.test(text) ? text.replace(marker, block) : `${text.replace(/\n*$/, "\n")}${block}`;
}

function main(argv) {
  const mode = argv[0];
  if (mode === "--check") {
    const found = [...problems(), ...constantProblems(ROOT)];
    if (found.length) {
      console.error(`Foreman page drift:\n- ${found.join("\n- ")}`);
      process.exit(1);
    }
    return;
  }
  if (mode === "--vendor") {
    const source = argv[1];
    const kitRev = Number(argv[argv.indexOf("--kit-rev") + 1]);
    const kitConfig = argv.includes("--kit-config") ? argv[argv.indexOf("--kit-config") + 1] : null;
    if (!source || !Number.isInteger(kitRev) || kitRev < 1 || !kitConfig)
      throw new Error(
        "usage: --vendor <built story-view.js> --kit-rev <n> --kit-config <the kit's own story-view.yml>",
      );
    const kitText = readFileSync(kitConfig, "utf8");
    const refused = kitConfigProblem(kitText, read(CONFIG));
    if (refused) throw new Error(refused);
    // A kit build may arrive with a header of its own (a re-vendor of a vendored file).
    const raw = readFileSync(source, "utf8");
    const body = publicBuild(parseVendored(raw)?.body ?? raw);
    writeFileSync(join(ROOT, VENDORED), vendoredText(body, kitRev));
    const keys = kitConfigKeys(parse(kitText), body);
    writeFileSync(join(ROOT, CONFIG_KEYS), `${JSON.stringify(keys, null, 2)}\n`);
    writeFileSync(join(ROOT, PACK_YML), packWithKit(read(PACK_YML), kitRev, sha256(body)));
  } else if (mode !== "--write")
    throw new Error(
      "usage: foreman-page.mjs --check | --write | --vendor <file> --kit-rev <n> --kit-config <yml>",
    );
  const page = pageText(read(VENDORED));
  writeFileSync(join(ROOT, DOCS_ROOT, PAGE), page);
  const sha = sha256(page);
  const launch = read(LAUNCH_RS);
  const entry = launchPages(launch).find((p) => p.path === PAGE);
  if (!entry) throw new Error(`${LAUNCH_RS}: no PAGES entry for ${PAGE} to update`);
  writeFileSync(join(ROOT, LAUNCH_RS), launch.replace(`"${entry.sha256}"`, `"${sha}"`));
  console.log(`${PAGE} sha256:${sha}, written to its PAGES entry in ${LAUNCH_RS}`);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
