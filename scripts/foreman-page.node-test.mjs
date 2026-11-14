// SPDX-License-Identifier: MIT
// The bundled Foreman page: the vendored kit, its public config, the page built from them, and the
// `PAGES` entry the `foreman.launch` grant reads must all agree, and a planted drift must fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { PINNED_PAGES } from "./check-api-skew.mjs";
import { buildTree } from "./build-codesense-docs.mjs";
import {
  CAPABILITIES,
  CONFIG,
  DOCS_ROOT,
  FILES,
  LAUNCH_RS,
  PACK_YML,
  PAGE,
  VENDORED,
  bakedConfig,
  comments,
  launchPages,
  pageText,
  parseVendored,
  problems,
  publicBuild,
  sha256,
  vendoredText,
  withoutCssComments,
} from "./foreman-page.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Assert that a drift report has a line naming `text`. */
const reports = (found, text) =>
  assert.ok(
    found.some((line) => line.includes(text)),
    found.join("\n"),
  );

/** A scratch copy of the five files the drift check reads, so a test can plant a change. */
function scratch(edit) {
  const root = mkdtempSync(join(tmpdir(), "foreman-page-"));
  for (const rel of FILES) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    cpSync(join(ROOT, rel), join(root, rel));
  }
  const change = (rel, fn) =>
    writeFileSync(join(root, rel), fn(readFileSync(join(root, rel), "utf8")));
  try {
    return edit(change, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// A scratch copy's drift, with the scratch page standing in for the bundle's bytes.
const check = (root) => problems(root, () => readFileSync(join(root, DOCS_ROOT, PAGE)));

test("the shipped page, vendored kit, config and PAGES entry agree", () => {
  assert.deepEqual(problems(ROOT), []);
});

test("the page is one self-contained file: no sibling script, style or link", () => {
  const html = readFileSync(join(ROOT, DOCS_ROOT, PAGE), "utf8");
  assert.ok(
    !/<script[^>]*\ssrc=/i.test(html),
    "a script loaded from a sibling file is not covered by the page's hash",
  );
  assert.ok(!/<link\b/i.test(html));
  const outside =
    html.slice(0, html.indexOf("<script>")) + html.slice(html.lastIndexOf("</script>"));
  assert.ok(!/@import|url\(\s*['"]?(?!data:)/i.test(outside));
  assert.equal(html.match(/<script\b/gi).length, 1);
  assert.match(html, /<meta name="story-view:foreman" content="">/);
});

test("the page declares the capabilities it calls, machines:read for the setup read, never foreman.launch", () => {
  const html = readFileSync(join(ROOT, DOCS_ROOT, PAGE), "utf8");
  const declared = /<meta name="codesense:capabilities" content="([^"]*)">/
    .exec(html)[1]
    .split(" ");
  assert.deepEqual(declared, CAPABILITIES);
  assert.ok(declared.includes("machines:read"));
  assert.ok(!declared.includes("foreman.launch"));
});

test("the public config names the Foreman and its guide and no team, budget or point key", () => {
  const config = parse(readFileSync(join(ROOT, CONFIG), "utf8"));
  assert.equal(config.foreman.role, "codesense-foreman");
  assert.deepEqual(config.foreman.agents, ["foreman-claude"]);
  assert.deepEqual(config.foreman.guides, ["guide-claude"]);
  assert.equal(config.team, config.foreman.docs.team);
  assert.ok(!/point|envelope|budget|\$/i.test(Object.keys(config).join(" ")));
  const vendored = parseVendored(readFileSync(join(ROOT, VENDORED), "utf8"));
  assert.deepEqual(bakedConfig(vendored.body), config);
});

test("the vendored header is the sha256 of the rest of the file, and pack.yml records it", () => {
  const text = readFileSync(join(ROOT, VENDORED), "utf8");
  const parsed = parseVendored(text);
  assert.equal(parsed.headerSha, parsed.actualSha);
  assert.equal(vendoredText(parsed.body, parsed.kitRev), text);
  const kit = parse(readFileSync(join(ROOT, PACK_YML), "utf8")).kit;
  assert.equal(kit.sha256, parsed.actualSha);
  assert.equal(kit.kit_rev, parsed.kitRev);
});

test("PAGES lists the page at the path the docs bundle places it, with its hash", () => {
  const entries = launchPages(readFileSync(join(ROOT, LAUNCH_RS), "utf8"));
  assert.deepEqual(
    entries.map((entry) => entry.path),
    [PAGE],
  );
  assert.equal(entries[0].sha256, sha256(readFileSync(join(ROOT, DOCS_ROOT, PAGE))));
});

test("the docs bundle ships the page byte for byte, and a bundle that edits it fails", () => {
  const page = readFileSync(join(ROOT, DOCS_ROOT, PAGE));
  assert.ok(buildTree().get(PAGE).equals(page));
  const edited = problems(ROOT, () => Buffer.concat([page, Buffer.from(" ")]));
  reports(edited, "docs bundle ships other bytes");
});

test("the API-skew scan leaves out the pages PAGES pins", () => {
  assert.ok(PINNED_PAGES.has(`${DOCS_ROOT}/${PAGE}`));
});

test("a planted byte in the vendored kit fails the drift check", () => {
  scratch((change, root) => {
    change(VENDORED, (text) => text.replace("'use strict';", "'use  strict';"));
    const found = check(root);
    reports(found, "header sha256");
    reports(found, "kit sha256");
  });
});

test("a pack.yml that records another hash or kit-rev fails", () => {
  scratch((change, root) => {
    change(PACK_YML, (text) => text.replace(/sha256: [0-9a-f]{64}/, `sha256: ${"0".repeat(64)}`));
    reports(check(root), "kit sha256");
  });
  scratch((change, root) => {
    change(PACK_YML, (text) => text.replace("kit_rev: 1", "kit_rev: 2"));
    reports(check(root), "kit_rev");
  });
});

test("a page edited without a matching PAGES entry fails, which would drop the grant silently", () => {
  scratch((change, root) => {
    change(`${DOCS_ROOT}/${PAGE}`, (text) =>
      text.replace("<title>Foreman</title>", "<title>Foreman </title>"),
    );
    const found = check(root);
    reports(found, "not the template");
    reports(found, "PAGES hash");
  });
});

test("a PAGES hash that is not the page's, or a missing entry, fails", () => {
  scratch((change, root) => {
    change(LAUNCH_RS, (text) =>
      text.replace(/sha256: "[0-9a-f]{64}"/, `sha256: "${"1".repeat(64)}"`),
    );
    reports(check(root), "PAGES hash");
  });
  scratch((change, root) => {
    change(LAUNCH_RS, (text) =>
      text.replace(
        /pub const PAGES: &\[Page\] = &\[[\s\S]*?\];/,
        "pub const PAGES: &[Page] = &[];",
      ),
    );
    reports(check(root), "no PAGES entry");
  });
});

test("a config with a team id, a budget key, or one that differs from the baked one fails", () => {
  scratch((change, root) => {
    change(CONFIG, (text) => text.replace("team: getting-started", "team: acme-team"));
    const found = check(root);
    reports(found, "names no team of its own");
    reports(found, "baked-in config differs");
  });
  scratch((change, root) => {
    change(CONFIG, (text) => `${text}budget: 5\n`);
    reports(check(root), "budget or point key");
  });
});

test("vendoring drops the kit's comments but its config markers, and leaves its code as it was", () => {
  const kit = [
    "// built from src/a.js sha256:" + "a".repeat(64),
    "(function(){",
    "/* CONFIG:begin */",
    "const CONFIG={};",
    "/* CONFIG:end */",
    'const STYLE="a{b:c}\\n/* the mockup */\\nd{e:f}";',
    "const url='http://x/y'; // trailing note",
    "const re=/\\/\\*not a comment\\*\\//;",
    "/** a doc",
    " * comment */",
    "function f(){ return /* inline */ 1 }",
    "})();",
    "",
  ].join("\n");
  const out = publicBuild(kit);
  assert.equal(
    out,
    [
      "(function(){",
      "/* CONFIG:begin */",
      "const CONFIG={};",
      "/* CONFIG:end */",
      'const STYLE="a{b:c}\\nd{e:f}";',
      "const url='http://x/y';",
      "const re=/\\/\\*not a comment\\*\\//;",
      "function f(){ return 1 }",
      "})();",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    comments(out).map(([start, end]) => out.slice(start, end)),
    ["/* CONFIG:begin */", "/* CONFIG:end */"],
  );
  // A quoted comment opener in the style sheet is text, not a comment.
  assert.equal(
    withoutCssComments("a{content:\"/* x */\"}\n/* note */\nb{content:'\\'/*'}"),
    "a{content:\"/* x */\"}\nb{content:'\\'/*'}",
  );
  // A comment whose removal would join two lines (and so change where semicolons go) keeps the break.
  assert.equal(publicBuild("a\n/* x */ b\n"), "a\nb\n");
  assert.equal(publicBuild("a /* x\n */ b\n"), "a\nb\n");
});

test("a vendored kit that keeps a comment, or names a tracker id, repository path or source hash, fails", () => {
  const cases = [
    ["// a note\n", "keeps 1 of the kit's comments"],
    ["const s='see AB-CD-27';\n", "tracker story id"],
    ["const s='dashboards/x/y.js';\n", "path in the kit's repository"],
    ["const s='design/AB-1/mockups.html';\n", "path in the kit's repository"],
    [`const s='sha256:${"b".repeat(64)}';\n`, "source file's hash"],
  ];
  for (const [line, message] of cases)
    scratch((change, root) => {
      change(VENDORED, (text) => `${text}${line}`);
      reports(check(root), message);
    });
  // A team's own design file, built from an id at run time, is the kit's job, not a leak.
  scratch((change, root) => {
    change(VENDORED, (text) => `${text}const s=\`design/\${id}/qa/trace.md\`;\n`);
    assert.ok(!check(root).some((problem) => problem.includes("repository")));
  });
});

test("a kit that names a local path fails; a script-ending sequence is refused", () => {
  scratch((change, root) => {
    change(VENDORED, (text) => `${text}const s='/Users/someone/work';\n`);
    reports(check(root), "local path");
  });
  const body =
    "// kit\n/* CONFIG:begin */\nconst CONFIG={};\n/* CONFIG:end */\nconst s='</script>';\n";
  assert.throws(() => pageText(vendoredText(body, 1)), /inline script/);
});
