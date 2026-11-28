// SPDX-License-Identifier: MIT
import { expect, test, type Page } from "@playwright/test";
import { leaf, mountTileHost, split } from "./fixtures/tile-host";

/**
 * Pointer input never reaches a hidden frame, and the host's layer sits under every portal: with
 * a modal open, or a drag layer over the window, a click lands there and not on any frame.
 */

const centerOf = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
/** The tile body (or portal test id) under a point. */
const hitAt = (page: Page, point: { x: number; y: number }) =>
  page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return (
      el?.closest<HTMLElement>("[data-testid^='harness-']")?.dataset.testid ??
      el?.closest<HTMLElement>("[data-tile-body]")?.dataset.tileBody ??
      el?.tagName ??
      null
    );
  }, point);

test("a hidden frame takes no pointer input @p0", async ({ page }) => {
  const host = await mountTileHost(page, split("row", [leaf("ws-a"), leaf("ws-b")]));
  const hiddenAt = await centerOf(page, '[data-tile-body="ws-b"]');
  await host.call("close", "ws-b");
  await host.settle();
  // ws-b's body still sits where it was, hidden; ws-a's grew under it.
  expect(await host.mounted()).toContain("ws-b");
  expect(await hitAt(page, hiddenAt)).toBe("ws-a");
});

test("a modal and the drag layer sit above every frame @p0", async ({ page }) => {
  const host = await mountTileHost(page, split("row", [leaf("ws-a"), leaf("ws-b")]));
  const frameAt = await centerOf(page, '[data-tile-body="ws-b"]');
  // Above the dialog's box, still over ws-b's frame.
  const outside = { x: frameAt.x, y: 20 };
  expect(await hitAt(page, frameAt)).toBe("ws-b");
  expect(await hitAt(page, outside)).toBe("ws-b");

  await host.call("modal", true);
  await expect(page.getByTestId("harness-modal")).toBeVisible();
  const buttonAt = await centerOf(page, '[data-testid="harness-modal-button"]');
  expect(await hitAt(page, buttonAt)).toBe("harness-modal-button");
  // Outside the dialog the overlay takes the click (and closes it), not the frame under it.
  expect(await hitAt(page, outside)).not.toMatch(/^ws-/);
  await page.mouse.click(outside.x, outside.y);
  await expect(page.getByTestId("harness-modal")).toBeHidden();

  // During a drag across a frame, the drag layer takes every point.
  await host.call("dragLayer", true);
  await page.mouse.move(frameAt.x - 100, frameAt.y);
  await page.mouse.down();
  for (const dx of [-50, 0, 50]) {
    const point = { x: frameAt.x + dx, y: frameAt.y };
    await page.mouse.move(point.x, point.y);
    expect(await hitAt(page, point)).toBe("harness-drag-layer");
  }
  await page.mouse.up();
  expect(await host.counts("ws-b")).toMatchObject({ inFrame: 1 });
});
