// SPDX-License-Identifier: MIT
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * The status line in the title bar, in a real browser: a posted line, its "+N waiting ▾" menu and
 * its live region pass axe. Lines are posted through the mock backend's test hook,
 * `window.__codesenseMock.postStatusLine`, which only mock builds carry.
 */

type Post = { text: string; kind: string; action?: { label: string; keyHint?: string } };

async function post(page: Page, line: Post) {
  await page.evaluate((line) => {
    const mock = (window as { __codesenseMock?: { postStatusLine?: (p: unknown) => void } })
      .__codesenseMock;
    if (!mock?.postStatusLine) throw new Error("window.__codesenseMock.postStatusLine is missing");
    mock.postStatusLine({
      ...line,
      ...(line.action ? { action: { ...line.action, run: () => {} } } : {}),
    });
  }, line);
}

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .include('[data-testid="title-bar"]')
    .include('[aria-label="status line"]')
    .withTags(["wcag2a", "wcag2aa"]);

test(
  "a posted line, its waiting menu and its live region pass axe",
  { tag: "@p0" },
  async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("title-bar")).toBeVisible();

    await post(page, {
      text: "design opened critique-log.html",
      kind: "offer",
      action: { label: "Show" },
    });
    await post(page, {
      text: "review agent opened Routines",
      kind: "offer",
      action: { label: "Show" },
    });
    const line = page.getByRole("group", { name: "Status line" });
    await expect(line).toContainText("design opened critique-log.html");
    await expect(page.getByRole("status", { name: "status line" })).toContainText(
      "design opened critique-log.html",
    );
    await line.hover();
    expect((await axe(page).analyze()).violations).toEqual([]);

    const waiting = line.getByRole("button", { name: "+1 waiting ▾" });
    await waiting.click();
    await expect(page.getByRole("menu")).toBeVisible();
    expect((await axe(page).include('[role="menu"]').analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(waiting).toBeFocused();

    await post(page, {
      text: "design moved critique-log.html beside design",
      kind: "undo",
      action: { label: "Undo", keyHint: "⌥⌘Z" },
    });
    await expect(line.getByRole("button", { name: "Undo ⌥⌘Z" })).toBeVisible();
    expect((await axe(page).analyze()).violations).toEqual([]);
  },
);
