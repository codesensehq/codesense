// SPDX-License-Identifier: MIT
/**
 * The render probe: does xterm's WebGL addon put glyphs in its canvas in this
 * webview? Its scratch terminal is the only terminal built outside the
 * terminal manager, and it is never a display: it is created, drawn, read back
 * and disposed within one probe.
 */
import { Terminal, type IDisposable } from "@xterm/xterm";
import type { WebglAddon } from "@xterm/addon-webgl";

import type { RenderProbeVerdict } from "./terminal-renderer";

/** How long the probe waits, from its first frame, for a frame with lit pixels. */
export const RENDER_PROBE_TIMEOUT_MS = 2_000;
/** How long it waits for a first frame at all once the page is visible. */
export const RENDER_PROBE_FIRST_FRAME_MS = 10_000;

/** Whether any pixel of the context's drawing buffer has a bright channel. */
function anyLit(gl: WebGL2RenderingContext): boolean {
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  if (!w || !h) return false;
  const pixels = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] > 127 || pixels[i + 1] > 127 || pixels[i + 2] > 127) return true;
  }
  return false;
}

/** The WebGL2 context of the canvas the addon added under `host`. */
function webglContextIn(host: HTMLElement): WebGL2RenderingContext | null {
  for (const canvas of host.querySelectorAll("canvas")) {
    // Asking again for the same kind returns the context the addon created.
    const gl = canvas.getContext("webgl2");
    if (gl) return gl;
  }
  return null;
}

/** Resolves once the page is visible: a hidden window gets no frames. */
function whenVisible(): Promise<void> {
  if (document.visibilityState !== "hidden") return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (document.visibilityState === "hidden") return;
      document.removeEventListener("visibilitychange", onChange);
      resolve();
    };
    document.addEventListener("visibilitychange", onChange);
  });
}

/**
 * Draw white glyphs on black in a scratch terminal through a WebGL addon from
 * `createAddon`, and read its canvas back inside the frame that drew them
 * (`onRender` fires in the same task as the draw, so the drawing buffer still
 * holds it). The cursor is hidden so only glyphs from the atlas can light a
 * pixel. The scratch terminal is on screen but invisible (opacity 0), because
 * xterm pauses rendering for an element that is out of view, and the probe
 * starts only once the page is visible.
 *
 * `ok`: a frame lit a pixel. `blank`: frames drew and none did. `no-frame`: no
 * frame came. `error`: no context, a throw, or a lost context. The addon and
 * its context are released before it resolves.
 */
export async function probeWebglRender(
  createAddon: () => WebglAddon,
  timeoutMs = RENDER_PROBE_TIMEOUT_MS,
  firstFrameMs = RENDER_PROBE_FIRST_FRAME_MS,
): Promise<RenderProbeVerdict> {
  await whenVisible();
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "160px",
    height: "48px",
    opacity: "0",
    pointerEvents: "none",
    zIndex: "-1",
  });
  document.body.appendChild(host);
  const term = new Terminal({
    cols: 8,
    rows: 2,
    fontSize: 16,
    fontFamily: "monospace",
    cursorInactiveStyle: "none",
    theme: { background: "#000000", foreground: "#ffffff", cursor: "#000000" },
  });
  let gl = null as WebGL2RenderingContext | null;
  try {
    term.open(host);
    // A throw in here (the addon failing to load) rejects, and reads as `error`.
    return await new Promise<RenderProbeVerdict>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const subs: IDisposable[] = [];
      let rendered = false;
      const finish = (verdict: RenderProbeVerdict) => {
        clearTimeout(timer);
        for (const sub of subs.splice(0)) sub.dispose();
        resolve(verdict);
      };
      const addon = createAddon();
      addon.onContextLoss(() => finish("error"));
      term.loadAddon(addon);
      const context = webglContextIn(host);
      gl = context;
      if (!context) return finish("error");
      timer = setTimeout(() => finish("no-frame"), firstFrameMs);
      const sub = term.onRender(() => {
        if (!rendered) {
          rendered = true;
          clearTimeout(timer);
          timer = setTimeout(() => finish("blank"), timeoutMs);
        }
        try {
          if (anyLit(context)) finish("ok");
        } catch {
          finish("error");
        }
      });
      subs.push(sub);
      // Hide the cursor, then a full block and letters.
      term.write("\x1b[?25l██WM\r\n██WM");
    });
  } catch {
    return "error";
  } finally {
    try {
      term.dispose();
    } catch {
      // The addon may already be torn down.
    }
    // Hand the context back now rather than at garbage collection: a webview
    // keeps only so many.
    try {
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // Already lost.
    }
    host.remove();
  }
}
