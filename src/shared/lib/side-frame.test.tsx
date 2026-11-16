// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
// jsdom parses HTML to the spec, which is what the head-placement cases check.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";

import {
  IMAGE_MIME,
  SIDE_FRAME_CSP,
  SIDE_LEFT_MESSAGE,
  SIDE_LEFT_NOTE,
  SideFrame,
  SideImage,
  sideFrameDoc,
  sidePrelude,
} from "./side-frame";

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
  it("puts the deny-all CSP, then the prelude, before everything the side holds", () => {
    const doc = sideFrameDoc(HOSTILE);
    expect(doc).toBe(CSP_META + sidePrelude("") + HOSTILE);
    expect(sidePrelude("n1")).toContain(`addEventListener("pagehide"`);
    expect(sidePrelude("n1")).toContain(JSON.stringify(`${SIDE_LEFT_MESSAGE}n1`));
    // document.open() would erase the listener: it is locked before the side runs.
    expect(sidePrelude("n1")).toContain(`for(const name of ["open","write","writeln"])`);
    expect(sidePrelude("n1")).toContain("configurable:false");
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

/** The drawing nonce a frame's prelude names. */
const nonceOf = (frame: HTMLIFrameElement) =>
  JSON.parse(/"(codesense:side-left:[^"]*)"/.exec(frame.getAttribute("srcdoc")!)![0]).slice(
    SIDE_LEFT_MESSAGE.length,
  ) as string;

describe("SideFrame", () => {
  it("is an opaque-origin, scripts-only sandbox drawn from srcdoc, with no URL to resolve", () => {
    const { container } = render(<SideFrame html={HOSTILE} title="After" />);
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).toBe(sideFrameDoc(HOSTILE, nonceOf(frame)));
    expect(frame.hasAttribute("src")).toBe(false);
    expect(frame.getAttribute("title")).toBe("After");
  });
});

describe("SideFrame navigation", () => {
  const frameOf = (container: HTMLElement) => container.querySelector("iframe");
  const post = (data: string) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data }));
    });

  it("closes the side on its second load, a navigation away from its own content", () => {
    const { container, getByRole, getByText } = render(<SideFrame html="<p>a</p>" title="After" />);
    const first = nonceOf(frameOf(container)!);
    fireEvent.load(frameOf(container)!);
    expect(frameOf(container)).not.toBeNull();
    fireEvent.load(frameOf(container)!);
    expect(frameOf(container)).toBeNull();
    expect(getByText(SIDE_LEFT_NOTE)).toBeInTheDocument();
    // The note replaces the side under the reader's eyes, so it is said politely.
    expect(getByText(SIDE_LEFT_NOTE).closest('[role="status"]')).not.toBeNull();
    fireEvent.click(getByRole("button", { name: "Show again" }));
    const again = frameOf(container)!;
    expect(nonceOf(again)).not.toBe(first);
    expect(again.getAttribute("srcdoc")).toBe(sideFrameDoc("<p>a</p>", nonceOf(again)));
    // A fresh frame: its own first load is not a navigation, and the old frame's
    // unload message does not close it.
    fireEvent.load(again);
    post(SIDE_LEFT_MESSAGE + first);
    expect(frameOf(container)).toBe(again);
  });

  it("closes the side when its document says it was unloaded, even before a second load", () => {
    const { container, getByText } = render(<SideFrame html="<p>a</p>" title="After" />);
    const frame = frameOf(container)!;
    // Another drawing's message, or another message, changes nothing.
    post(`${SIDE_LEFT_MESSAGE}someone-else`);
    post("other");
    expect(frameOf(container)).toBe(frame);
    post(SIDE_LEFT_MESSAGE + nonceOf(frame));
    expect(frameOf(container)).toBeNull();
    expect(getByText(SIDE_LEFT_NOTE)).toBeInTheDocument();
  });

  it("a side whose content changes loads it fresh, which is not a navigation", () => {
    const { container, rerender } = render(<SideFrame html="<p>a</p>" title="After" />);
    const before = nonceOf(frameOf(container)!);
    fireEvent.load(frameOf(container)!);
    rerender(<SideFrame html="<p>b</p>" title="After" />);
    fireEvent.load(frameOf(container)!);
    post(SIDE_LEFT_MESSAGE + before);
    const frame = frameOf(container)!;
    expect(frame.getAttribute("srcdoc")).toBe(sideFrameDoc("<p>b</p>", nonceOf(frame)));
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

  it("captions the side with its size in pixels once drawn, and its file size", () => {
    stubBlobUrls();
    const bytes = "x".repeat(3000);
    const { container, getByTestId } = render(
      <SideImage base64={btoa(bytes)} filePath="art/logo.png" alt="After" />,
    );
    const img = container.querySelector("img")!;
    Object.defineProperty(img, "naturalWidth", { value: 1280 });
    Object.defineProperty(img, "naturalHeight", { value: 800 });
    fireEvent.load(img);
    expect(getByTestId("side-image-caption")).toHaveTextContent("1280 × 800 · 2.9 KB");
  });

  it("a side that won't decode says so, with no broken-image glyph", () => {
    stubBlobUrls();
    const { container, getByRole } = render(
      <SideImage base64={btoa("not a png")} filePath="art/logo.png" alt="Before" />,
    );
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(getByRole("alert")).toHaveTextContent(
      "Couldn't draw this side: the bytes aren't a readable PNG.",
    );
  });
});

describe("raster extensions", () => {
  it("are the same set in the page and in the Rust read that serves them", () => {
    const rust = readFileSync("src-tauri/src/commands/raster_bytes.rs", "utf8");
    const list = /const RASTER_EXTENSIONS: \[&str; \d+\] = \[([^\]]*)\];/.exec(rust)?.[1];
    expect(list, "RASTER_EXTENSIONS in raster_bytes.rs").toBeDefined();
    const rustSet = [...list!.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(rustSet).toEqual(Object.keys(IMAGE_MIME).sort());
  });
});
