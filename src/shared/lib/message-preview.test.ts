// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";

import { htmlToPlain, markdownToPlain, messagePreview } from "./message-preview";

const DASHBOARD = `<!doctype html><html><head><meta charset="utf-8"><title>Deploy status</title>
<style> body{font-family: system-ui; color: #333} </style>
<script>codesense.sessions().then(render)</script></head>
<body><h1>Deploy status</h1><p>3 of 4 services are <b>green</b>.</p><ul><li>api</li><li>web</li></ul></body></html>`;

describe("messagePreview", () => {
  it("uses the sender's summary when there is one, whatever the body", () => {
    expect(
      messagePreview({ text: DASHBOARD, contentType: "html", summary: "  Deploy: 3/4 green\n" }),
    ).toBe("Deploy: 3/4 green");
  });

  it("an html body without a summary previews its title and visible text, never its markup", () => {
    const p = messagePreview({ text: DASHBOARD, contentType: "html" });
    expect(p).toBe("Deploy status — 3 of 4 services are green. api web");
    expect(p).not.toMatch(/<|doctype|font-family|codesense\.sessions/);
  });

  it("an html body with no title leads with its first heading", () => {
    expect(htmlToPlain("<h2>Weekly digest</h2><p>All quiet.</p>")).toBe(
      "Weekly digest — All quiet.",
    );
  });

  it("a markdown body (the default type) previews without its marks", () => {
    expect(
      messagePreview({ text: "**Hi, it's Jimmy.** Here's what _I_ found in `auth.ts`:" }),
    ).toBe("Hi, it's Jimmy. Here's what I found in auth.ts:");
    expect(
      messagePreview({ text: "**Correction** — the TTL is 15m", contentType: "markdown" }),
    ).toBe("Correction — the TTL is 15m");
  });

  it("markdown links keep their words; headings, quotes and bullets lose their marks", () => {
    expect(
      markdownToPlain(
        "# Plan\n> note\n- see [the PR](https://x/1)\n1. ~~old~~ new\n```ts\nconst a = 1;\n```",
      ),
    ).toBe("Plan\nnote\nsee the PR\nold new\n\nconst a = 1;\n");
  });

  it("snake_case words and lone asterisks are not mistaken for emphasis", () => {
    expect(markdownToPlain("set max_retry_count to 3 * 2")).toBe("set max_retry_count to 3 * 2");
  });

  it("plain bodies are shown as they are, whitespace collapsed", () => {
    expect(messagePreview({ text: "**not** markdown\n\nhere", contentType: "plain" })).toBe(
      "**not** markdown here",
    );
  });

  it("cuts long previews with an ellipsis at the limit", () => {
    const p = messagePreview({ text: "word ".repeat(100) }, 40);
    expect(p.length).toBeLessThanOrEqual(40);
    expect(p.endsWith("…")).toBe(true);
  });

  it("type parameters and angle-bracketed words in markdown are text, not tags", () => {
    expect(messagePreview({ text: "returns `Promise<void>` and Vec<String>; <b>bold</b>" })).toBe(
      "returns Promise<void> and Vec<String>; bold",
    );
  });

  it("never splits an emoji at the cut", () => {
    const p = messagePreview({ text: `${"a".repeat(8)}😀😀😀` }, 10);
    expect(p).toBe(`${"a".repeat(8)}😀…`);
    // No lone surrogate before the ellipsis.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(p)).toBe(false);
  });
});

describe("htmlToPlain without a DOM parser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes each entity once, so an escaped entity stays as written", () => {
    vi.stubGlobal("DOMParser", undefined);
    expect(htmlToPlain("<p>Use &amp;lt;b&amp;gt; for bold, &amp;amp; for &amp;</p>")).toBe(
      "Use &lt;b&gt; for bold, &amp; for &",
    );
  });

  it("decodes entities in the title the same way as in the body, as the DOM path does", () => {
    const html = "<title>Q&amp;A: &amp;lt;tags&amp;gt;</title><p>Fish &amp; chips</p>";
    const withDom = htmlToPlain(html);
    vi.stubGlobal("DOMParser", undefined);
    expect(htmlToPlain(html)).toBe("Q&A: &lt;tags&gt; — Fish & chips");
    expect(htmlToPlain(html)).toBe(withDom);
  });
});
