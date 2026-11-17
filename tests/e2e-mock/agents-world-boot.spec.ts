// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";

/**
 * The `?agents=team` world boots into its own team (Acme Widgets), with its agents' CLI
 * workspace in the bottom pane, and stays there: the specs that drive that world start here.
 */
test("the agents world boots into its team and its agents' workspace", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.goto("/?agents=team");
  await expect(page.getByRole("button", { name: "Full screen" })).toBeVisible();
  await expect(page.getByTestId("chat-cli-switch-sess-login-lead-chat")).toBeAttached();
  const active = await page.evaluate(() => {
    const stores = (
      window as { __stores?: { useOrgStore: { getState(): { activeOrgSlug: string | null } } } }
    ).__stores;
    return stores?.useOrgStore.getState().activeOrgSlug ?? null;
  });
  expect(active).toBe("acme/widgets");
});
