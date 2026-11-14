// SPDX-License-Identifier: MIT
import { expect, test, type Page } from "@playwright/test";

/**
 * A story file (an `.md` whose front matter says `type: story`) opens its team's story page in the
 * tab of that file, from the ways of opening a file the left nav offers, in a real browser
 * (`?nav=demo`, whose team sets `story_page`). Opening it again focuses that tab; a plain
 * markdown file stays markdown.
 */
async function openDemo(page: Page) {
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.goto("/?nav=demo");
  await page.getByRole("button", { name: /^26-agent-inbox/ }).click();
}

const storyPage = (page: Page) => page.locator('iframe[title="story.html"]');
const tabs = (page: Page, id: string) =>
  page.getByRole("button", { name: `${id} Close tab`, exact: true });

test("a pipeline card opens the story page, and opening it again keeps one tab", async ({
  page,
}) => {
  await openDemo(page);
  const card = page.getByRole("button", { name: /^AID-4Dashboards from the inbox/ });
  await card.click();
  await expect(page.getByRole("heading", { name: "Dashboards from the inbox" })).toHaveCount(0);
  await expect(storyPage(page).first()).toBeVisible();
  await expect(page.getByTestId("story-no-page")).toHaveCount(0);
  await expect(tabs(page, "AID-4")).toHaveCount(1);
  await card.dblclick();
  await expect(tabs(page, "AID-4")).toHaveCount(1);
  await expect(storyPage(page).first()).toBeVisible();
});

test("a link to a story in a viewer opens the story page", async ({ page }) => {
  await openDemo(page);
  await page
    .getByRole("button", { name: /^README\.md$/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "26-agent-inbox", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "the first story" }).click();
  await expect(storyPage(page).first()).toBeVisible();
  await expect(tabs(page, "AID-1")).toHaveCount(1);
});

test("a plain markdown file stays markdown", async ({ page }) => {
  await openDemo(page);
  await page
    .getByRole("button", { name: /^README\.md$/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "26-agent-inbox", level: 1 })).toBeVisible();
  await expect(storyPage(page)).toHaveCount(0);
  await expect(page.getByTestId("story-no-page")).toHaveCount(0);
});
