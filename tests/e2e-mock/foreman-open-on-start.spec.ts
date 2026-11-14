// SPDX-License-Identifier: MIT
import { expect, test, type Page } from "@playwright/test";

/**
 * The Foreman tab opening on start and from the identity menu and the palette, against the
 * frontend mock backend. The mock has no native bridge or CLI, so a send from the page and the
 * launch it makes are not covered here.
 *
 * `CI=1 PORT=<free port> pnpm test:e2e:mock tests/e2e-mock/foreman-open-on-start.spec.ts`
 */

const FOREMAN_PAGE = "getting-started/content/foreman/index.html";

async function stores(page: Page) {
  await page.waitForFunction(() => !!window.__stores?.useViewerStore);
}

/** Every open tab path, across teams. */
function openPaths(page: Page) {
  return page.evaluate(() =>
    Object.values(window.__stores!.useViewerStore.getState().openTabs)
      .flat()
      .map((t) => t.path),
  );
}

async function openMenu(page: Page) {
  // The menu can swallow the first click while the app is still booting: retry the opening.
  await expect(async () => {
    await page.getByTestId("identity-menu-trigger").click();
    await expect(page.getByTestId("identity-menu-foreman")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

for (const scenario of ["noOrg", "onboarded"]) {
  test(`${scenario}: start opens one focused Foreman tab and no setup tab`, async ({ page }) => {
    await page.goto(`/?scenario=${scenario}`);
    await stores(page);
    await expect
      .poll(async () => (await openPaths(page)).filter((p) => p.endsWith(FOREMAN_PAGE)).length)
      .toBe(1);
    // The docs team is the one on screen, with the Foreman as its active tab.
    const state = await page.evaluate(() => {
      const viewer = window.__stores!.useViewerStore.getState();
      const { activeOrgSlug, activeTeamName } = window.__stores!.useOrgStore.getState();
      return {
        team: activeTeamName,
        activeTab: viewer.activeTab[`${activeOrgSlug}:${activeTeamName}`] ?? null,
      };
    });
    expect(state.team).toBe("getting-started");
    expect(state.activeTab?.endsWith(FOREMAN_PAGE)).toBe(true);
    expect((await openPaths(page)).some((p) => p.includes("guide/index.html"))).toBe(false);
  });
}

test("the identity menu and the palette focus the open tab instead of adding one", async ({
  page,
}) => {
  await page.goto("/?scenario=onboarded");
  await stores(page);
  await expect.poll(async () => (await openPaths(page)).length).toBeGreaterThan(0);

  await openMenu(page);
  await page.getByTestId("identity-menu-foreman").click();

  await page.evaluate(() => window.__stores!.useUiStore.setState({ commandPaletteOpen: true }));
  await page.getByRole("option", { name: /^Foreman/ }).click();

  const foreman = (await openPaths(page)).filter((p) => p.endsWith(FOREMAN_PAGE));
  expect(foreman).toHaveLength(1);
});
