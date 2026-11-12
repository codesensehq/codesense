// SPDX-License-Identifier: MIT
import { expect, test, type Page } from "@playwright/test";

/**
 * Files Changes renders every changed file through the shared file diff, in a
 * real browser (`?nav=demo`): a markdown change opens as the redline with the
 * mode switch in its header strip, side by side shows both rendered sides, and a
 * changed HTML file shows Before and After live side by side once the diff body
 * is at least 900 px wide (the Before | After toggle below that).
 *
 * `SHOTS=<dir>` also saves the screenshots the PR shows.
 */
const SHOTS = process.env.SHOTS;

async function openChanges(page: Page, width: number) {
  await page.setViewportSize({ width, height: 860 });
  await page.goto("/?nav=demo");
  await page.locator('button[aria-label^="On main;"]').click();
}

test("markdown opens as the redline and switches to side by side", async ({ page }) => {
  await openChanges(page, 1400);
  await page.getByRole("button", { name: /^AID-4Dashboards from the inbox/ }).click();
  const diff = page.getByTestId("file-diff-markdown").last();
  await expect(diff.getByRole("button", { name: "Redline" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(diff.locator(".cs-redline-prose")).toContainText("Dashboards from the inbox");
  await diff.getByRole("button", { name: "Side by side" }).click();
  await expect(diff.getByTestId("file-diff-side-by-side")).toBeVisible();
  if (SHOTS) await diff.screenshot({ path: `${SHOTS}/files-markdown-side-by-side.png` });
});

test("a changed HTML file is Before and After side by side at 900 px and wider", async ({
  page,
}) => {
  await openChanges(page, 1400);
  await page.getByRole("button", { name: /^inbox-board/ }).click();
  const diff = page.getByTestId("file-diff-rendered").last();
  const body = diff.getByTestId("file-diff-side-by-side");
  await expect(body).toBeVisible();
  expect((await body.boundingBox())!.width).toBeGreaterThanOrEqual(900);
  await expect(body.locator("iframe")).toHaveCount(2);
  if (SHOTS) await diff.screenshot({ path: `${SHOTS}/files-html-side-by-side.png` });
});

test("below 900 px the HTML diff is a Before | After toggle", async ({ page }) => {
  await openChanges(page, 1000);
  await page.getByRole("button", { name: /^inbox-board/ }).click();
  const diff = page.getByTestId("file-diff-rendered").last();
  await expect(diff.getByTestId("file-diff-toggle")).toBeVisible();
  await expect(diff.getByRole("button", { name: "After" })).toHaveAttribute("aria-pressed", "true");
  await diff.getByRole("button", { name: "Before" }).click();
  await expect(diff.getByRole("button", { name: "Before" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
