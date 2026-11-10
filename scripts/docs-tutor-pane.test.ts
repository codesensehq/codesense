// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

const panes = join(__dirname, "..", "codesense-docs", "getting-started", "panes");
const html = readFileSync(join(panes, "tutor.html"), "utf8");
const runtime = readFileSync(join(panes, "pane-runtime.js"), "utf8");

const open: JSDOM[] = [];
afterEach(() => open.splice(0).forEach((dom) => dom.window.close()));

// Loads the Tutor pane on the real pane runtime; `show` opens a file in the slot.
function tutor(rewrite: (script: string) => string = (script) => script) {
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  open.push(dom);
  let slot: (ctx: { currentFile: string }) => void = () => {};
  Object.assign(dom.window, {
    requestAnimationFrame: (cb: () => void) => cb(),
    codesense: { onSlotContext: (cb: typeof slot) => (slot = cb) },
  });
  dom.window.eval(runtime);
  for (const script of dom.window.document.querySelectorAll("script:not([src])"))
    dom.window.eval(rewrite(script.textContent!));
  const document = dom.window.document;
  return {
    show: (currentFile: string) => slot({ currentFile }),
    captions: () =>
      document.querySelector(".here-rail-captions")!.textContent!.replace(/\s+/g, " ").trim(),
    current: () => document.querySelectorAll('.here-rail .seg[data-current="true"]').length,
  };
}

describe("Tutor pane arc rail", () => {
  it("first paints with only the end labels", () => {
    expect(tutor().captions()).toBe("A N");
  });

  it("shows only the end labels when no script matches the file", () => {
    const pane = tutor();
    pane.show("README.md");
    expect(pane.captions()).toBe("A N");
    expect(pane.current()).toBe(0);
  });

  it("shows only the end labels for an arc missing from the map", () => {
    const pane = tutor((script) => script.replace("arc: 'L'", "arc: 'X'"));
    pane.show("factory-playbook.html");
    expect(pane.captions()).toBe("A N");
    expect(pane.current()).toBe(0);
  });

  it("captions a known arc with its letter and name", () => {
    const pane = tutor();
    pane.show("factory-playbook.html");
    expect(pane.captions()).toBe("A L · Factory N");
    expect(pane.current()).toBe(1);
  });
});
