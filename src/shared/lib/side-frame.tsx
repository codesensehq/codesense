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
 * it nor stop it. `document.open()` would erase it, so `open`, `write` and
 * `writeln` are locked on `Document.prototype` and on the document and always
 * throw: a write with no insertion point (from a timer, say, even while the page
 * still parses) runs the document open steps natively, past any lock on `open`.
 * A side that writes while it parses gets a script error inside its own frame.
 * The prelude then removes itself, so the side's DOM is as it was authored. The
 * nonce is not a secret: a forged message can only close a side.
 */
export function sidePrelude(nonce: string): string {
  const message = JSON.stringify(SIDE_LEFT_MESSAGE + nonce);
  return (
    `<script>(()=>{const post=parent.postMessage.bind(parent),doc=document,` +
    `proto=Document.prototype,` +
    `refuse=()=>{throw new DOMException("A rendered diff side can't reopen or write its document","SecurityError")};` +
    `addEventListener("pagehide",()=>post(${message},"*"),true);` +
    `for(const name of ["open","write","writeln"])for(const at of [proto,doc])` +
    `Object.defineProperty(at,name,{value:refuse,writable:false,configurable:false});` +
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
        // It replaces the side under the reader's eyes, so it is said politely.
        role="status"
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

export const IMAGE_MIME: Record<string, string> = {
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

/** A byte count as the caption shows it: B, KB or MB, one decimal past bytes. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The decoded size of base64 `text`. */
const decodedBytes = (text: string) =>
  Math.floor((text.length * 3) / 4) - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0);

/**
 * A raster image side from its base64 bytes, captioned with its size in pixels and its file
 * size (so a change of resolution alone shows). Never an SVG: that can carry script, so it goes
 * through {@link SideFrame}. Bytes that won't decode say so instead of a broken-image glyph.
 */
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
  const ext = extensionOf(filePath) ?? "";
  const mime = IMAGE_MIME[ext] ?? "application/octet-stream";
  // What the drawn image measured, or that it would not decode; both belong to these bytes.
  const [drawn, setDrawn] = useState<{
    of: string;
    size?: { w: number; h: number };
    broken?: boolean;
  } | null>(null);
  const mine = drawn?.of === base64 ? drawn : null;
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
  if (mine?.broken)
    return (
      <OverlayCenteredState testId="side-image-broken">
        <span role="alert">
          Couldn&apos;t draw this side: the bytes aren&apos;t a readable{" "}
          {ext === "jpg" ? "JPEG" : ext.toUpperCase()}.
        </span>
      </OverlayCenteredState>
    );
  const caption = [
    mine?.size ? `${mine.size.w} × ${mine.size.h}` : null,
    formatBytes(decodedBytes(base64)),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img
          ref={imgRef}
          alt={alt}
          className="max-h-full max-w-full object-contain"
          onLoad={(e) =>
            setDrawn({
              of: base64,
              size: { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight },
            })
          }
          onError={() => setDrawn({ of: base64, broken: true })}
        />
      </div>
      <p
        className="flex-none px-3 pb-2 text-center text-xs text-muted-foreground"
        data-testid="side-image-caption"
      >
        {caption}
      </p>
    </div>
  );
}
