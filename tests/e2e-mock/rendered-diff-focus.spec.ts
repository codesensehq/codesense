// SPDX-License-Identifier: MIT
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The file diff's mode switch draws each segment's keyboard focus ring inside the segment,
 * in a real browser with the app's styles: the group clips its overflow, and the global
 * `:focus-visible` rule (unlayered, so it beats a layered utility) would otherwise push the
 * ring 2 px outside, where it is clipped away.
 */
/** Each segment of `group`, focused from the keyboard, draws a 2 px solid ring at −2 px. */
async function expectInsetRings(page: Page, group: Locator) {
  await expect(group).toBeVisible();
  const segments = group.getByRole("button");
  const count = await segments.count();
  expect(count).toBeGreaterThan(1);
  for (let i = 0; i < count; i++) {
    // A key press first, so the focus that follows is keyboard focus (:focus-visible).
    await page.keyboard.press("Shift");
    await segments.nth(i).focus();
    const ring = await segments.nth(i).evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        visible: el.matches(":focus-visible"),
        width: style.outlineWidth,
        styleName: style.outlineStyle,
        offset: style.outlineOffset,
      };
    });
    expect(ring).toEqual({ visible: true, width: "2px", styleName: "solid", offset: "-2px" });
  }
}

async function openChanges(page: Page, width: number) {
  await page.setViewportSize({ width, height: 860 });
  await page.goto("/?nav=demo");
  await page.locator('button[aria-label^="On main;"]').click();
}

test("a keyboard-focused mode segment draws its 2 px ring inside itself", async ({ page }) => {
  await openChanges(page, 1400);
  await page.getByRole("button", { name: /^AID-4Dashboards from the inbox/ }).click();
  await expectInsetRings(
    page,
    page.getByTestId("file-diff-markdown").last().getByRole("group", { name: "Diff mode" }),
  );
});

test("a keyboard-focused side segment (Before | After) draws its 2 px ring inside itself", async ({
  page,
}) => {
  // Below 900 px an HTML diff shows one side at a time, chosen by the side switch.
  await openChanges(page, 1000);
  await page.getByRole("button", { name: /^inbox-board/ }).click();
  await expectInsetRings(
    page,
    page.getByTestId("file-diff-rendered").last().getByRole("group", { name: "Side shown" }),
  );
});
