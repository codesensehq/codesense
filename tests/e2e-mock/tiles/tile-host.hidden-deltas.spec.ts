// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";
import { leaf, mountTileHost, split } from "./fixtures/tile-host";

/**
 * A hidden tile's body stays on the hub's hidden path: it hears the changes its badge needs, in
 * batches at most one per 2,000 ms, while a shown sibling hears each as it comes.
 */

const HIDDEN_THROTTLE_MS = 2_000;

test("a hidden tile hears hub deltas at most once per 2,000 ms @p0", async ({ page }) => {
  test.setTimeout(60_000);
  const host = await mountTileHost(page, split("row", [leaf("ws-shown"), leaf("ws-hidden")]));
  await host.call("close", "ws-hidden");
  await host.settle();
  expect(await host.shown()).toEqual(["ws-shown"]);
  expect(await host.mounted()).toContain("ws-hidden");
  const hiddenBefore = (await host.counts("ws-hidden")).deltas.length;
  const shownBefore = (await host.counts("ws-shown")).deltas.length;

  // A delta every 250 ms for 6 s.
  const started = Date.now();
  for (let i = 0; i < 24; i++) {
    await host.fire();
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(HIDDEN_THROTTLE_MS + 500);
  const elapsed = Date.now() - started;

  const shown = (await host.counts("ws-shown")).deltas.slice(shownBefore);
  expect(shown.length).toBeGreaterThanOrEqual(20);

  const hidden = (await host.counts("ws-hidden")).deltas.slice(hiddenBefore);
  expect(hidden.length).toBeGreaterThan(0);
  // Deltas arrive in batches; batches are throttled.
  const batches: number[] = [];
  for (const { at } of hidden)
    if (!batches.length || at - batches[batches.length - 1] > 200) batches.push(at);
  expect(batches.length).toBeLessThanOrEqual(Math.ceil(elapsed / HIDDEN_THROTTLE_MS) + 1);
  for (let i = 1; i < batches.length; i++)
    expect(batches[i] - batches[i - 1]).toBeGreaterThanOrEqual(HIDDEN_THROTTLE_MS - 100);
});
