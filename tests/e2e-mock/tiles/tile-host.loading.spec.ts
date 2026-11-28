// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";
import { leaf, mountTileHost, split } from "./fixtures/tile-host";

/**
 * A tile whose body is held back shows its kind's skeleton, then the word Loading, and the body
 * takes the skeleton's place in the same box: no layout jump.
 */

test("a held-back body shows its skeleton, then the body with no layout jump @p0", async ({
  page,
}) => {
  const host = await mountTileHost(page, split("row", [leaf("ws-a"), leaf("ws-b")]), ["ws-new"]);
  await host.call("hold", "ws-new");
  await host.call("split", "ws-b", "row", "after", "ws-new");
  const body = host.body("ws-new");
  const skeleton = body.locator('[data-tile-loading="skeleton"] [data-tile-skeleton="pane"]');
  await expect(skeleton).toBeVisible();
  await expect(body.getByText("Loading")).toBeVisible();
  const held = await body.boundingBox();
  const skeletonBox = await skeleton.boundingBox();
  expect(skeletonBox).toEqual(held);
  const siblings = await host.body("ws-b").boundingBox();

  await host.call("release", "ws-new");
  await host.loaded("ws-new");
  await expect(body.locator("[data-tile-loading]")).toHaveCount(0);
  expect(await body.boundingBox()).toEqual(held);
  expect(await host.body("ws-b").boundingBox()).toEqual(siblings);
  const frame = await host.frameOf("ws-new").boundingBox();
  expect(frame!.width).toBeCloseTo(held!.width, 0);
  expect(frame!.height).toBeCloseTo(held!.height, 0);
});
