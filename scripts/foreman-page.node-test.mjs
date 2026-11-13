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
import { applyMetadata } from "./generate-docs-metadata.mjs";
import {
  CAPABILITIES,
  CONFIG,
  DOCS_ROOT,
  LAUNCH_RS,
  PACK_YML,
  PAGE,
  VENDORED,
  bakedConfig,
  launchPages,
  pageText,
  parseVendored,
  problems,
  sha256,
  vendoredText,
  withoutStoryIds,
} from "./foreman-page.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = [VENDORED, CONFIG, PACK_YML, `${DOCS_ROOT}/${PAGE}`, LAUNCH_RS];

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
  assert.ok(!/@import|url\(\s*['"]?(?!data:)/i.test(html.replace(/<script>[\s\S]*<\/script>/, "")));
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

test("the docs bundle step leaves the page's bytes alone, and still edits an ordinary page", () => {
  const page = readFileSync(join(ROOT, DOCS_ROOT, PAGE));
  const ordinary = Buffer.from("<html><head></head><body>x</body></html>");
  const files = new Map([
    [PAGE, page],
    ["getting-started/content/arc-a-first-touch/other.html", ordinary],
  ]);
  applyMetadata(files);
  assert.ok(files.get(PAGE).equals(page));
  assert.ok(!files.get("getting-started/content/arc-a-first-touch/other.html").equals(ordinary));
});

test("a planted byte in the vendored kit fails the drift check", () => {
  scratch((change, root) => {
    change(VENDORED, (text) => text.replace("'use strict';", "'use  strict';"));
    const found = problems(root);
    assert.ok(
      found.some((line) => line.includes("header sha256")),
      found.join("\n"),
    );
    assert.ok(
      found.some((line) => line.includes("kit sha256")),
      found.join("\n"),
    );
  });
});

test("a pack.yml that records another hash or kit-rev fails", () => {
  scratch((change, root) => {
    change(PACK_YML, (text) => text.replace(/sha256: [0-9a-f]{64}/, `sha256: ${"0".repeat(64)}`));
    assert.ok(problems(root).some((line) => line.includes("kit sha256")));
  });
  scratch((change, root) => {
    change(PACK_YML, (text) => text.replace("kit_rev: 1", "kit_rev: 2"));
    assert.ok(problems(root).some((line) => line.includes("kit_rev")));
  });
});

test("a page edited without a matching PAGES entry fails, which would drop the grant silently", () => {
  scratch((change, root) => {
    change(`${DOCS_ROOT}/${PAGE}`, (text) =>
      text.replace("<title>Foreman</title>", "<title>Foreman </title>"),
    );
    const found = problems(root);
    assert.ok(
      found.some((line) => line.includes("not the template")),
      found.join("\n"),
    );
    assert.ok(
      found.some((line) => line.includes("PAGES hash")),
      found.join("\n"),
    );
  });
});

test("a PAGES hash that is not the page's, or a missing entry, fails", () => {
  scratch((change, root) => {
    change(LAUNCH_RS, (text) =>
      text.replace(/sha256: "[0-9a-f]{64}"/, `sha256: "${"1".repeat(64)}"`),
    );
    assert.ok(problems(root).some((line) => line.includes("PAGES hash")));
  });
  scratch((change, root) => {
    change(LAUNCH_RS, (text) =>
      text.replace(
        /pub const PAGES: &\[Page\] = &\[[\s\S]*?\];/,
        "pub const PAGES: &[Page] = &[];",
      ),
    );
    assert.ok(problems(root).some((line) => line.includes("no PAGES entry")));
  });
});

test("a config with a team id, a budget key, or one that differs from the baked one fails", () => {
  scratch((change, root) => {
    change(CONFIG, (text) => text.replace("team: getting-started", "team: acme-team"));
    const found = problems(root);
    assert.ok(
      found.some((line) => line.includes("names no team of its own")),
      found.join("\n"),
    );
    assert.ok(
      found.some((line) => line.includes("baked-in config differs")),
      found.join("\n"),
    );
  });
  scratch((change, root) => {
    change(CONFIG, (text) => `${text}budget: 5\n`);
    assert.ok(problems(root).some((line) => line.includes("budget or point key")));
  });
});

test("a kit comment citing a tracker story id fails, and vendoring replaces it", () => {
  assert.equal(
    withoutStoryIds("// (SV-WF-27 AC6) and SV-FM-1, SV-WF-2x"),
    "// ([ref] AC6) and [ref], [ref]",
  );
  scratch((change, root) => {
    change(VENDORED, (text) => `${text}// see SV-WF-27\n`);
    assert.ok(problems(root).some((line) => line.includes("story id")));
  });
});

test("a kit that names a local path fails; a script-ending sequence is refused", () => {
  scratch((change, root) => {
    change(VENDORED, (text) => `${text}// see /Users/someone/work\n`);
    assert.ok(problems(root).some((line) => line.includes("local path")));
  });
  const body =
    "// kit\n/* CONFIG:begin */\nconst CONFIG={};\n/* CONFIG:end */\nconst s='</script>';\n";
  assert.throws(() => pageText(vendoredText(body, 1)), /inline script/);
});
