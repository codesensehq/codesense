// SPDX-License-Identifier: MIT
import { expect, test, type Page } from "@playwright/test";

/**
 * A fresh profile (nothing persisted, no context repo of the person's own) opens the CodeSense
 * setup page as the active tab of the bundled docs team; the identity menu row and the palette
 * item reopen it without adding a second tab. The mock app serves the page's file, the page's own
 * agent is covered by guide-page.spec.ts.
 */

const SETUP = "/getting-started/content/guide/index.html";
const KEY = "codesense/docs:getting-started";

declare global {
  interface Window {
    __stores?: Record<string, { getState: () => any }>;
  }
}

/** Boots with no saved session at all: the first launch of a profile, with the scenario's repos. */
async function bootFresh(page: Page, url = "/?scenario=noOrg") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    type Internals = {
      invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
    let installed: Internals;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => installed,
      set: (internals: Internals) => {
        installed = internals;
        const original = internals.invoke.bind(internals);
        internals.invoke = async (command, args = {}) =>
          command === "load_app_state" ? JSON.stringify({ repos: [] }) : original(command, args);
      },
    });
  });
  await page.goto(url);
  await page.waitForFunction(() => Boolean(window.__stores?.useViewerStore));
}

const active = (page: Page) =>
  page.evaluate((key) => window.__stores!.useViewerStore.getState().activeTab[key] ?? null, KEY);
const setupTabs = (page: Page) =>
  page.evaluate(
    ([key, suffix]) =>
      (
        (window.__stores!.useViewerStore.getState().openTabs[key] ?? []) as { path: string }[]
      ).filter((tab) => tab.path.endsWith(suffix)).length,
    [KEY, SETUP],
  );

test("a fresh profile opens the setup page, and the menu row and palette reopen it", async ({
  page,
}) => {
  await bootFresh(page);
  await expect.poll(() => active(page)).toMatch(/guide\/index\.html$/);
  expect(await setupTabs(page)).toBe(1);

  // Move off it, then reopen from the identity menu.
  await page.evaluate((key) => {
    const store = window.__stores!.useViewerStore.getState();
    store.openFile(key, "", "/mock/other.md");
  }, KEY);
  await expect.poll(() => active(page)).toBe("/mock/other.md");
  await page.getByTestId("identity-menu-trigger").click();
  await page.getByTestId("identity-menu-setup").click();
  await expect.poll(() => active(page)).toMatch(/guide\/index\.html$/);
  expect(await setupTabs(page)).toBe(1);

  // And from the palette.
  await page.evaluate((key) => {
    window.__stores!.useViewerStore.getState().openFile(key, "", "/mock/other.md");
  }, KEY);
  await page.evaluate(() => window.__stores!.useUiStore.getState().setCommandPaletteOpen(true));
  await page.getByRole("option", { name: /Set up CodeSense/ }).click();
  await expect.poll(() => active(page)).toMatch(/guide\/index\.html$/);
  expect(await setupTabs(page)).toBe(1);
});

const discovered = (page: Page) =>
  page.waitForFunction(() => window.__stores!.useOrgStore.getState().discoveryComplete === true);

test("a profile that has opened a context repo before does not land on the setup page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__stores?.useViewerStore));
  await discovered(page);
  // Discovery is done and the launch decision has run (it follows the restore in the same tick).
  await page.waitForFunction(() => window.__stores!.useOrgStore.getState().stateLoaded === true);
  expect(await setupTabs(page)).toBe(0);
});

test("a profile with a context repo of its own and no saved selection lands on the docs README, not the setup page", async ({
  page,
}) => {
  await bootFresh(page, "/");
  await discovered(page);
  await expect.poll(() => active(page)).toMatch(/README\.html$/);
  expect(await setupTabs(page)).toBe(0);
});
