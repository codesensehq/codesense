// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebglAddon } from "@xterm/addon-webgl";

import {
  installFakeCanvasContexts,
  restoreCanvasContexts,
} from "@/shared/lib/__test-utils__/webgl-addon-harness";
import { probeWebglRender } from "./terminal-render-probe";

describe("the render probe (the real WebGL addon over a stub GL context)", () => {
  /** What the stub drawing buffer reads back: lit (a glyph drew) or all black. */
  let lit = false;
  /** Called on each read-back, before it fills the buffer. */
  let onRead: () => void = () => {};
  const loseContext = vi.fn();

  beforeEach(() => {
    installFakeCanvasContexts();
    const fakeGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      const ctx = (fakeGetContext as (...a: unknown[]) => unknown).call(this, kind, ...rest);
      if (kind !== "webgl2" || !ctx) return ctx;
      return new Proxy(ctx as object, {
        get(target, prop) {
          if (prop === "drawingBufferWidth" || prop === "drawingBufferHeight") return 4;
          if (prop === "getExtension")
            return (name: string) => (name === "WEBGL_lose_context" ? { loseContext } : null);
          if (prop === "readPixels")
            return (_x: number, _y: number, _w: number, _h: number, ...a: unknown[]) => {
              onRead();
              if (lit) (a[2] as Uint8Array)[5] = 255;
            };
          return Reflect.get(target, prop);
        },
      });
    } as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    lit = false;
    onRead = () => {};
    loseContext.mockClear();
    restoreCanvasContexts();
    vi.restoreAllMocks();
  });

  /** A real addon whose dispose is watched. */
  function watchedAddon() {
    const addon = new WebglAddon();
    const dispose = vi.spyOn(addon, "dispose");
    return { addon, dispose };
  }

  it("ok when a frame lights a pixel, and it releases the addon and its context", async () => {
    lit = true;
    const { addon, dispose } = watchedAddon();
    await expect(probeWebglRender(() => addon)).resolves.toBe("ok");
    expect(dispose).toHaveBeenCalled();
    expect(loseContext).toHaveBeenCalledTimes(1);
    expect(document.body.children).toHaveLength(0);
  });

  it("blank when frames draw and nothing is lit, and it releases the addon and its context", async () => {
    const { addon, dispose } = watchedAddon();
    await expect(probeWebglRender(() => addon, 300)).resolves.toBe("blank");
    expect(dispose).toHaveBeenCalled();
    expect(loseContext).toHaveBeenCalledTimes(1);
    expect(document.body.children).toHaveLength(0);
  });

  it("error when the context is lost, without waiting for the timeout", async () => {
    const addon = new WebglAddon();
    let fireLoss: () => void = () => {};
    vi.spyOn(addon, "onContextLoss").mockImplementation((listener) => {
      fireLoss = () => listener();
      return { dispose: () => {} };
    });
    onRead = () => fireLoss();
    const started = performance.now();
    await expect(probeWebglRender(() => addon, 5_000)).resolves.toBe("error");
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(document.body.children).toHaveLength(0);
  });

  it("error when the addon throws", async () => {
    const verdict = await probeWebglRender(() => {
      throw new Error("no WebGL2");
    });
    expect(verdict).toBe("error");
    expect(document.body.children).toHaveLength(0);
  });

  it("waits for a hidden page to become visible before it draws", async () => {
    lit = true;
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const create = vi.fn(() => new WebglAddon());
    const pending = probeWebglRender(create);
    await new Promise((done) => setTimeout(done, 50));
    expect(create).not.toHaveBeenCalled();
    expect(document.body.children).toHaveLength(0);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await expect(pending).resolves.toBe("ok");
    expect(create).toHaveBeenCalledTimes(1);
  });
});
