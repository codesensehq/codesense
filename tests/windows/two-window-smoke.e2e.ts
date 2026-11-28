// SPDX-License-Identifier: MIT
// The driver itself: `main` opens a satellite, the spec drives it, then closes it.
import { browser, expect } from "@wdio/globals";
import { freshId, invoke, MAIN, open, seed } from "./lib/driver";

describe("two windows", () => {
  before(async () => {
    await seed();
  });

  it("opens a registered satellite, drives it and closes it", async () => {
    const id = freshId("smoke");
    const label = await open({ id });
    expect(label).toBe(`pane-${id}`);
    expect(await browser.getWindowHandle()).toBe(label);

    // Driven in the satellite: it reads its own registry entry, which `e2e_open_window`
    // created before the window, with no items and no Layout.
    const own = await invoke("window_get_slice", { label });
    expect(own).toMatchObject({
      ok: true,
      value: { label, kind: "satellite", items: [], layoutRef: null },
    });

    await browser.closeWindow();
    await browser.switchToWindow(MAIN);
    await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(label), {
      timeoutMsg: `${label} still has a window handle after its close`,
    });
    expect(await browser.getWindowHandles()).toContain(MAIN);
  });

  it("seeds the same probe twice", async () => {
    const first = await seed();
    expect(await seed()).toEqual(first);
  });
});
