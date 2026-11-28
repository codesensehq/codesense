// SPDX-License-Identifier: MIT
// The command ACL in a real satellite: a main-only command is refused there and accepted in
// `main`, and a dashboard rendered in a satellite reads a team file through its bridge and
// hears it change. The dashboard (`fixtures/probe.html`) posts what it got to the satellite's
// top page, so nothing here enters its cross-origin frame.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { browser, expect } from "@wdio/globals";
import { freshId, invoke, MAIN, open, principal, probeResults, seed } from "./lib/driver";

describe("a satellite under the command ACL", () => {
  let probeHtml: string;
  let expectedPrincipal: string;

  before(async () => {
    ({ probeHtml } = await seed());
    expectedPrincipal = await principal();
  });

  it("refuses a main-only command in a bare satellite and accepts it in main", async () => {
    const args = { state: "{}", patch: true, expectedPrincipal };
    await open({ id: freshId("acl") });
    expect(await invoke("save_app_state", args)).toEqual({
      ok: false,
      refusal: "not allowed in this window: save_app_state",
    });
    await browser.closeWindow();

    await browser.switchToWindow(MAIN);
    const before = await invoke("load_app_state", { expectedPrincipal });
    expect(await invoke("save_app_state", args)).toEqual({ ok: true, value: null });
    expect(await invoke("load_app_state", { expectedPrincipal })).toEqual(before);
  });

  it("reads a team file through a satellite dashboard's bridge, then hears it change", async () => {
    const readFile = path.join(path.dirname(probeHtml), "probe-read.txt");
    const label = await open({ id: freshId("probe"), probe: probeHtml });

    // The probe route reports its window ready, so its entry is no longer pending.
    await browser.waitUntil(
      async () => {
        const own = await invoke("window_get_slice", { label });
        return own.ok && (own.value as { pending: boolean }).pending === false;
      },
      { timeoutMsg: `${label} stayed pending` },
    );

    await browser.waitUntil(async () => "read" in (await probeResults()), {
      timeout: 30_000,
      timeoutMsg: "the probe dashboard never reported its read",
    });
    expect((await probeResults()).read).toBe(readFileSync(readFile, "utf8"));

    // A rewrite from outside the app reaches the dashboard as a files push, and its re-read
    // sees the new text.
    const changed = `rewritten by the driver ${Date.now()}\n`;
    writeFileSync(readFile, changed);
    await browser.waitUntil(async () => (await probeResults()).read === changed, {
      timeout: 30_000,
      timeoutMsg: "the probe dashboard never heard the rewrite",
    });
    expect((await probeResults()).push).toContain("probe-read.txt");
    await browser.closeWindow();
  });
});
