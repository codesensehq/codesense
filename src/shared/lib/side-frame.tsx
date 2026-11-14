// SPDX-License-Identifier: MIT
import { useEffect, useId, useRef, useState } from "react";

import { OverlayCenteredState } from "@/features/viewer/components/overlay-shell";

import { BASELINE_SANDBOX, extensionOf } from "./viewer-file-type";

/**
 * One side of a rendered diff drawn from what the surface already holds, off
 * Files where no route serves the file: an HTML or SVG side from its text, a
 * raster image from its bytes. The side is untrusted (an agent's output, a
 * teammate's edit, a file on another machine), so it gets no origin, no bridge
 * and no network: it can read only its own content.
 */

/** Inline markup only: no fetch, no remote or file image, font, stylesheet or
 *  frame, no `<base>`, no form posts. */
export const SIDE_FRAME_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; " +
  "script-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${SIDE_FRAME_CSP}">`;

/** A doctype the HTML parser reads as the first token (only its whitespace may
 *  precede it); `[^>]` ends where the tokenizer ends it. */
const LEADING_DOCTYPE = /^[\t\n\f\r ]*<!doctype[^>]*>/i;

/** What a side's document posts to the host as it is unloaded by a navigation,
 *  followed by its drawing's nonce. */
export const SIDE_LEFT_MESSAGE = "codesense:side-left:";

/**
 * Runs before anything the side holds: when the document is unloaded (it
 * navigated, even before its own load finished), it tells the host, naming its
 * drawing by `nonce`. The poster is bound here, and the listener is the first
 * capture listener on the window, so the side's own scripts can neither replace
 * it nor stop it. `document.open()` would erase it, so `open` is locked on
 * `Document.prototype` and on the document, and `write`/`writeln` (which open
 * the document once parsing is done) throw after parsing. It then removes
 * itself, so the side's DOM is as it was authored. The nonce is not a secret: a
 * forged message can only close a side.
 */
export function sidePrelude(nonce: string): string {
  const message = JSON.stringify(SIDE_LEFT_MESSAGE + nonce);
  return (
    `<script>(()=>{const post=parent.postMessage.bind(parent),doc=document,` +
    `proto=Document.prototype,write=proto.write,writeln=proto.writeln,` +
    `refuse=()=>{throw new DOMException("A rendered diff side can't reopen its document","SecurityError")},` +
    `lock=(name,value)=>{for(const at of [proto,doc])` +
    `Object.defineProperty(at,name,{value,writable:false,configurable:false})};` +
    `addEventListener("pagehide",()=>post(${message},"*"),true);` +
    `lock("open",refuse);` +
    `lock("write",function(...a){if(doc.readyState!=="loading")refuse();return write.apply(this,a)});` +
    `lock("writeln",function(...a){if(doc.readyState!=="loading")refuse();return writeln.apply(this,a)});` +
    `doc.currentScript.remove()})()</script>`
  );
}

/**
 * The frame's document: the CSP as its first element, so the parser puts it
 * first in the head before anything the side can load, then the prelude. Only a
 * leading doctype goes ahead of them, which keeps the page in standards mode.
 */
export function sideFrameDoc(html: string, nonce = ""): string {
  const doctype = LEADING_DOCTYPE.exec(html)?.[0] ?? "";
  return doctype + CSP_META + sidePrelude(nonce) + html.slice(doctype.length);
}

/** Said in place of a side that navigated away from its own content. */
export const SIDE_LEFT_NOTE = "This side tried to open another page, so it was closed.";

/**
 * An HTML or SVG side: `srcdoc` in the baseline frame's opaque-origin,
 * scripts-only sandbox, so it has no URL to resolve siblings against.
 *
 * The CSP can't stop the side navigating itself (`location.href`, a meta
 * refresh, a link click): that is a GET it can send, the one residual channel.
 * The frame is torn down as soon as the host learns of it: the prelude's
 * message as the side's document is unloaded (a navigation before its own load
 * finished gives no second load), or a second load. "Show again" draws the
 * side's own content afresh.
 */
export function SideFrame({ html, title }: { html: string; title: string }) {
  const [shown, setShown] = useState(0);
  const [left, setLeft] = useState<string | null>(null);
  // One frame per drawing: a new content or a "Show again" is a fresh frame, with its
  // own nonce, so a frame being replaced (it is unloaded too) never closes the next.
  const id = useId();
  const [version, setVersion] = useState({ html, n: 0 });
  if (version.html !== html) setVersion({ html, n: version.n + 1 });
  const nonce = `${id}-${shown}-${version.html === html ? version.n : version.n + 1}`;
  const doc = sideFrameDoc(html, nonce);
  const drawing = doc;
  const loads = useRef({ drawing, count: 0 });
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data === SIDE_LEFT_MESSAGE + nonce) setLeft(drawing);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [drawing, nonce]);
  if (left === drawing)
    return (
      <OverlayCenteredState
        testId="side-frame-left"
        action={
          <button
            type="button"
            onClick={() => setShown((n) => n + 1)}
            className="rounded border border-border px-2 py-0.5 text-[0.7rem] font-medium text-foreground hover:bg-accent"
          >
            Show again
          </button>
        }
      >
        {SIDE_LEFT_NOTE}
      </OverlayCenteredState>
    );
  const onLoad = () => {
    if (loads.current.drawing !== drawing) loads.current = { drawing, count: 0 };
    loads.current.count += 1;
    if (loads.current.count > 1) setLeft(drawing);
  };
  return (
    <iframe
      key={drawing}
      title={title}
      sandbox={BASELINE_SANDBOX}
      srcDoc={doc}
      referrerPolicy="no-referrer"
      loading="lazy"
      onLoad={onLoad}
      className="h-full w-full border-0 bg-white"
    />
  );
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** A raster image (PNG, JPEG, GIF, WebP) a side draws from its bytes; an SVG is not. */
export function isRasterImage(filePath: string): boolean {
  return Object.hasOwn(IMAGE_MIME, extensionOf(filePath) ?? "");
}

/** A raster image side from its base64 bytes. Never an SVG: that can carry
 *  script, so it goes through {@link SideFrame}. */
export function SideImage({
  base64,
  filePath,
  alt,
}: {
  base64: string;
  filePath: string;
  alt: string;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const mime = IMAGE_MIME[extensionOf(filePath) ?? ""] ?? "application/octet-stream";
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    img.src = url;
    return () => {
      img.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
  }, [base64, mime]);
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-4">
      <img ref={imgRef} alt={alt} className="max-h-full max-w-full object-contain" />
    </div>
  );
}
