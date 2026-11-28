// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";
import { leaf, mountTileHost, split } from "./fixtures/tile-host";

/**
 * A body a keep predicate names (a dirty edit) survives the keep-alive cap: with it and 15 other
 * bodies hidden, the 10 kept include it although it was shown least recently.
 */

test("a body a keep predicate names outlives a full keep-alive @p0", async ({ page }) => {
  test.setTimeout(120_000);
  const others = Array.from({ length: 15 }, (_, i) => `ws-${i + 1}`);
  const host = await mountTileHost(page, split("row", [leaf("dirty"), ...others.map(leaf)]), [
    "ws-shown",
  ]);
  const instance = await host.instanceOf("dirty");
  await host.call("keep", "dirty");

  // Every one of the 16 goes hidden, and one new tile is shown.
  await host.call("seed", leaf("ws-shown"));
  await host.loaded("ws-shown");
  await host.settle();

  const mounted = await host.mounted();
  expect(mounted).toContain("dirty");
  // The cap counts the kept body: 10 hidden, plus the one shown.
  expect(mounted).toHaveLength(11);
  // The least recent of the others went first.
  for (const gone of others.slice(0, 6)) expect(mounted).not.toContain(gone);
  expect(await host.instanceOf("dirty")).toBe(instance);
  expect(await host.counts("dirty")).toMatchObject({ inFrame: 1, stored: 1 });
});
