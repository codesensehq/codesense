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
//   4. the page's sha256 equals its `PAGES` entry in `foreman_launch.rs`, and the docs bundle ships
//      exactly these bytes, so a docs update cannot silently drop the `foreman.launch` grant;
//   5. the vendored kit keeps no comment but its config markers, and names no tracker id, local
//      path, path in the kit's repository or source hash (`--vendor` drops the comments).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { parse } from "yaml";
import { buildTree } from "./build-codesense-docs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PACK = "codesense-docs/packs/codesense-foreman";
export const VENDORED = `${PACK}/vendor/story-view.js`;
export const CONFIG = `${PACK}/story-view.yml`;
export const PACK_YML = `${PACK}/pack.yml`;
export const DOCS_ROOT = "codesense-docs";
// The page's path inside the placed docs checkout: the key of its `PAGES` entry.
export const PAGE = "getting-started/content/foreman/index.html";
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
// What the kit's source tree says about itself: a tracker id, a local path, a path in its own
// repository, or a source file's hash. None of it may reach the public page.
const PRIVATE_TEXT = [
  [/\b[A-Z]{2,}-[A-Z]{2,}-\d+[a-z]?\b/, "a tracker story id"],
  [/\/Users\/|~\/\.codesense/, "a local path"],
  // A team's own `design/<id>/…` files, which the kit reads at run time, are built from an id.
  [
    /\b(?:dashboards|reviews)\/|\bdesign\/(?!\$\{)|scripts\/story-view/,
    "a path in the kit's repository",
  ],
  [/sha256:[0-9a-f]{64}/, "a source file's hash"],
];
// The two comments the kit's config is found between (`bakedConfig`); every other one goes.
const KEPT_COMMENTS = new Set(["/* CONFIG:begin */", "/* CONFIG:end */"]);

const parsed = (body) =>
  ts.createSourceFile("kit.js", body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
// The parser's own nodes, without the JSDoc it hangs on them (that is comment text).
const children = (node, file) => node.getChildren(file).filter((child) => !ts.isJSDoc(child));

/** Every comment in a script, as `[start, end]`, read by a parser so strings and regexes are never mistaken for one. */
export function comments(body) {
  const file = parsed(body);
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
  const file = parsed(body);
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

/**
 * Every drift problem as a message; empty when the vendored kit, config, page and grant agree.
 * `bundled` gives the page's bytes as the docs bundle ships them.
 */
export function problems(root = ROOT, bundled = () => buildTree().get(PAGE)) {
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
  let kept;
  try {
    kept = comments(parsed.body).filter(
      ([start, end]) => !KEPT_COMMENTS.has(parsed.body.slice(start, end)),
    );
  } catch (error) {
    return [...out, `${VENDORED}: ${error.message}`];
  }
  if (kept.length)
    out.push(
      `${VENDORED}: keeps ${kept.length} of the kit's comments; vendor it with --vendor, which drops them`,
    );
  for (const [pattern, what] of PRIVATE_TEXT)
    if (pattern.test(parsed.body)) out.push(`${VENDORED}: names ${what}`);
  let expected;
  try {
    expected = pageText(vendored);
  } catch (error) {
    return [...out, `${VENDORED}: ${error.message}`];
  }
  const page = readFileSync(join(root, DOCS_ROOT, PAGE), "utf8");
  if (page !== expected)
    out.push(`${DOCS_ROOT}/${PAGE}: not the template with the vendored kit inlined; run --write`);
  // The archive's docs bundle step may edit a page's bytes; the page the app places is what must hash to PAGES.
  const pageBytes = readFileSync(join(root, DOCS_ROOT, PAGE));
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
    const body = publicBuild(parseVendored(raw)?.body ?? raw);
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
