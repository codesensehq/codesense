// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
// jsdom parses HTML to the spec, which is what the head-placement cases check.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import { SIDE_FRAME_CSP, SideFrame, SideImage, sideFrameDoc } from "./side-frame";

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${SIDE_FRAME_CSP}">`;

/** A remote side that tries to reach the loopback API, the disk and a sibling file. */
const HOSTILE = [
  `<script>fetch("http://127.0.0.1:4100/api/state").then((r) => r.text())</script>`,
  `<img src="file:///etc/hosts">`,
  `<link rel="stylesheet" href="../x.css">`,
].join("");

function parsed(doc: string) {
  return new DOMParser().parseFromString(doc, "text/html");
}

describe("sideFrameDoc", () => {
  it("puts the deny-all CSP before everything the side holds", () => {
    const doc = sideFrameDoc(HOSTILE);
    expect(doc.startsWith(CSP_META)).toBe(true);
    expect(doc.slice(CSP_META.length)).toBe(HOSTILE);
  });

  it("the policy loads nothing from the network, the disk or a sibling file", () => {
    const directives = new Map(
      SIDE_FRAME_CSP.split(";").map((d) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name, values] as const;
      }),
    );
    expect(directives.get("default-src")).toEqual(["'none'"]);
    expect(directives.get("img-src")).toEqual(["data:", "blob:"]);
    expect(directives.get("style-src")).toEqual(["'unsafe-inline'"]);
    expect(directives.get("script-src")).toEqual(["'unsafe-inline'"]);
    expect(directives.get("font-src")).toEqual(["data:"]);
    expect(directives.get("base-uri")).toEqual(["'none'"]);
    expect(directives.get("form-action")).toEqual(["'none'"]);
    // No directive names a scheme or host that reaches out.
    expect(SIDE_FRAME_CSP).not.toMatch(/https?:|file:|\*|'self'/);
  });

  it("keeps a leading doctype so the page lays out in standards mode, CSP still the first element", () => {
    const doc = sideFrameDoc("<!DOCTYPE html>\n<html><head><title>t</title></head><p>x</p>");
    expect(doc.startsWith(`<!DOCTYPE html>${CSP_META}`)).toBe(true);
    const dom = parsed(doc);
    expect(dom.compatMode).toBe("CSS1Compat");
    expect(dom.head.firstElementChild?.outerHTML).toBe(CSP_META);
  });

  it.each([
    ["plain markup", "<p>hi</p>"],
    ["a full document", "<html><head><meta charset=utf-8></head><body>x</body></html>"],
    ["text before the doctype", "x<!doctype html><p>y</p>"],
    ["a byte-order mark before the doctype", "\uFEFF<!doctype html><p>y</p>"],
    ["a doctype with a tag inside", "<!doctype html <body>><p>y</p>"],
    ["an SVG", `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>`],
  ])("the CSP lands first in the head whatever the side starts with: %s", (_name, html) => {
    expect(parsed(sideFrameDoc(html)).head.firstElementChild?.outerHTML).toBe(CSP_META);
  });
});

describe("SideFrame", () => {
  it("is an opaque-origin, scripts-only sandbox drawn from srcdoc, with no URL to resolve", () => {
    const { container } = render(<SideFrame html={HOSTILE} title="After" />);
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).toBe(sideFrameDoc(HOSTILE));
    expect(frame.hasAttribute("src")).toBe(false);
    expect(frame.getAttribute("title")).toBe("After");
  });
});

describe("SideImage", () => {
  const created: Blob[] = [];
  const revoked: string[] = [];
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  afterEach(() => {
    URL.createObjectURL = original.create;
    URL.revokeObjectURL = original.revoke;
    created.length = 0;
    revoked.length = 0;
  });
  function stubBlobUrls() {
    URL.createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return `blob:side-${created.length}`;
    });
    URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
  }

  it("draws the bytes from a blob URL typed by the extension, revoked when the side unmounts", () => {
    stubBlobUrls();
    const { container, unmount } = render(
      <SideImage base64={btoa("\x89PNG")} filePath="art/logo.png" alt="After" />,
    );
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("blob:side-1");
    expect(created[0].type).toBe("image/png");
    expect(created[0].size).toBe(4);
    unmount();
    expect(revoked).toEqual(["blob:side-1"]);
  });
});
