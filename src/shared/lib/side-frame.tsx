// SPDX-License-Identifier: MIT
import { useEffect, useRef } from "react";

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

/**
 * The frame's document: the CSP as its first element, so the parser puts it
 * first in the head before anything the side can load. Only a leading doctype
 * goes ahead of it, which keeps the page in standards mode.
 */
export function sideFrameDoc(html: string): string {
  const doctype = LEADING_DOCTYPE.exec(html)?.[0] ?? "";
  return doctype + CSP_META + html.slice(doctype.length);
}

/** An HTML or SVG side: `srcdoc` in the baseline frame's opaque-origin,
 *  scripts-only sandbox, so it has no URL to resolve siblings against. */
export function SideFrame({ html, title }: { html: string; title: string }) {
  return (
    <iframe
      title={title}
      sandbox={BASELINE_SANDBOX}
      srcDoc={sideFrameDoc(html)}
      referrerPolicy="no-referrer"
      loading="lazy"
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
