// SPDX-License-Identifier: MIT
// The CodeSense setup page: guide.js, the page that inlines it, the `PAGES` entry the launch grant
// reads and the pack that ships it must agree, and a planted drift must fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { PINNED_PAGES } from "./check-api-skew.mjs";
import { buildTree } from "./build-codesense-docs.mjs";
import { chatCodeErrors } from "./pack-build.mjs";
import { FILES, PAGE, SOURCE, TEMPLATE, pageText, problems, sha256 } from "./guide-page.mjs";
import { DOCS_ROOT, LAUNCH_RS, launchPages } from "./lib/pinned-pages.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACK = "codesense-docs/packs/codesense-guide";
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const reports = (found, text) =>
  assert.ok(
    found.some((line) => line.includes(text)),
    found.join("\n"),
  );

/** A scratch copy of the files the drift check reads, so a test can plant a change. */
function scratch(edit) {
  const root = mkdtempSync(join(tmpdir(), "guide-page-"));
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

test("the shipped guide.js, page, docs-bundle copy and PAGES entry agree", () => {
  assert.deepEqual(problems(ROOT), []);
});

test("PAGES pins the guide page at the path the docs bundle places it, with its hash", () => {
  const entry = launchPages(read(LAUNCH_RS)).find((page) => page.path === PAGE);
  assert.ok(entry, "no PAGES entry for the guide page");
  assert.equal(entry.sha256, sha256(readFileSync(join(ROOT, DOCS_ROOT, PAGE))));
  assert.ok(
    buildTree()
      .get(PAGE)
      .equals(readFileSync(join(ROOT, DOCS_ROOT, PAGE))),
  );
  assert.ok(PINNED_PAGES.has(`${DOCS_ROOT}/${PAGE}`));
});

test("the page is guide.js inlined, so its hash covers every line the page runs", () => {
  const html = read(TEMPLATE);
  assert.equal(html, pageText(html, read(SOURCE)));
  const inline =
    /<script>\n\/\* guide\.js:begin \*\/\n([\s\S]*)\n\/\* guide\.js:end \*\/\n<\/script>/.exec(
      html,
    );
  assert.equal(inline[1], read(SOURCE).replace(/\n+$/, ""));
  assert.deepEqual(
    [...html.matchAll(/<script\b[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1]),
    ["/kit/v1/kit.js", "/kit/v1/chat.js"],
  );
});

test("a guide.js edited without the page rebuilt fails, which would drop the grant silently", () => {
  scratch((change, root) => {
    change(SOURCE, (text) => `${text}// one more line\n`);
    reports(check(root), "its inline script is not");
  });
});

test("a page edited by one byte fails on its PAGES hash", () => {
  scratch((change, root) => {
    change(`${DOCS_ROOT}/${PAGE}`, (text) =>
      text.replace("<title>CodeSense setup</title>", "<title>CodeSense setup </title>"),
    );
    reports(check(root), "PAGES hash");
  });
});

test("a missing PAGES entry, another hash, or a bundle that edits the page fails", () => {
  scratch((change, root) => {
    change(LAUNCH_RS, (text) =>
      text.replace(
        /Page \{\s*path: "getting-started\/content\/guide\/index\.html",\s*sha256: "[0-9a-f]{64}",\s*\},?/,
        "",
      ),
    );
    reports(check(root), "no PAGES entry");
  });
  scratch((change, root) => {
    change(LAUNCH_RS, (text) =>
      text.replace(/(guide\/index\.html",\s*sha256: ")[0-9a-f]{64}/, `$1${"1".repeat(64)}`),
    );
    reports(check(root), "PAGES hash");
  });
  const page = readFileSync(join(ROOT, DOCS_ROOT, PAGE));
  reports(
    problems(ROOT, () => Buffer.concat([page, Buffer.from(" ")])),
    "docs bundle ships other bytes",
  );
});

test("a script the page's hash does not cover fails: a sibling script, a second inline one, a foreign style sheet", () => {
  scratch((change, root) => {
    change(TEMPLATE, (text) =>
      text.replace('<script src="/kit/v1/chat.js">', '<script src="guide.js">'),
    );
    reports(check(root), "a script the page's hash does not cover");
  });
  scratch((change, root) => {
    change(TEMPLATE, (text) => text.replace("<body>", "<body><script>window.x = 1;</script>"));
    reports(check(root), "exactly one inline script");
  });
  scratch((change, root) => {
    change(TEMPLATE, (text) =>
      text.replace(
        '<link rel="stylesheet" href="/kit/v1/kit.css">',
        '<link rel="stylesheet" href="https://x.test/a.css">',
      ),
    );
    reports(check(root), "style sheet other than the kit's");
  });
});

test("a guide.js that would end the inline script is refused", () => {
  assert.throws(() => pageText(read(TEMPLATE), "x = '</script>';"), /end its inline script/);
});

test("the page declares the capabilities it calls and never foreman.launch", () => {
  const html = read(TEMPLATE);
  const declared = /<meta name="codesense:capabilities" content="([^"]*)">/
    .exec(html)[1]
    .split(" ");
  assert.deepEqual(declared, [
    "sessions:read",
    "sessions:stop",
    "inbox:read:team",
    "inbox:write",
    "launch",
    "machines:read",
  ]);
  assert.ok(!declared.includes("foreman.launch"));
});

test("the pack asks for kit.chat, and its page mounts it with the page layout and no chat of its own", () => {
  const manifest = parse(read(`${PACK}/pack.yml`));
  assert.deepEqual(manifest.requires.kit, { chat: 1 });
  const files = [`content/guide/index.html`, `content/guide/guide.js`];
  assert.deepEqual(chatCodeErrors(join(ROOT, PACK), manifest, files), []);
  const source = read(SOURCE);
  assert.match(source, /kit\.chat/);
  for (const option of [
    /variant: 'page'/,
    /activity: true/,
    /next: \{ edit: true \}/,
    /cards: \{ consent: true \}/,
    /headerSlot: \{/,
  ])
    assert.match(source, option);
});

test("no guide agent names a model: the page passes one per setup state through openWorkspace", () => {
  for (const runtime of ["claude", "codex", "opencode"]) {
    const yaml = read(`${PACK}/agents/guide-${runtime}/agent.yaml`);
    assert.ok(!/--model|^model:/m.test(yaml), `guide-${runtime} names a model`);
  }
  const source = read(SOURCE);
  assert.match(source, /model: modelFor\(S\.runtime\)/);
  for (const model of ["claude-sonnet-5-5", "claude-haiku-5-5", "gpt-6.1-sol", "gpt-6-luna"])
    assert.ok(source.includes(`'${model}'`), model);
});

test("each runtime's sign-in command is its CLI's own, and the page signs no one in", () => {
  const source = read(SOURCE);
  for (const command of ["claude auth login", "codex login", "opencode auth login"])
    assert.ok(source.includes(`'${command}'`), command);
  assert.ok(!/run_in_terminal_tab|runSkill|sendToWorkspaceTab/.test(source));
});

test("the page holds no token-shaped text, home path or tracker id", () => {
  for (const rel of [SOURCE, TEMPLATE]) {
    const text = read(rel);
    assert.ok(!/\b(?:sk|ghp|gho|xox[bp])[-_][A-Za-z0-9]{10,}/.test(text), rel);
    assert.ok(!/\/Users\/|\/home\/[a-z]/.test(text), rel);
    assert.ok(!/\b[A-Z]{2,}-[A-Z]{2,}-\d+\b/.test(text), rel);
  }
});
