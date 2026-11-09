// SPDX-License-Identifier: MIT
import { expect, test, type MountedPane } from "./harness";

const PANE = "tests/pane-harness/fixtures/sample-pane.html";

// Every engine must hear exactly one focus-in per host hand-off, whether or not it reports
// the frame's own focus on a programmatic focus.
const focusIns = async (pane: MountedPane) =>
  pane.currentFrame()
    ? (await pane.probe()).messages.filter((type) => type === "codesense:focus-in").length
    : 0;
const frameFocused = (pane: MountedPane) =>
  pane.page.evaluate(() => document.activeElement?.tagName === "IFRAME");
/** A late report of the frame's own focus must not post another one. */
async function stillAt(pane: MountedPane, count: number) {
  await pane.page.waitForTimeout(300);
  expect(await focusIns(pane)).toBe(count);
}
async function enter(pane: MountedPane) {
  await pane.page.locator("#terminal").focus();
  await pane.focus();
}

test("the host focus path posts one focus-in per hand-off into the pane", async ({ mountPane }) => {
  const pane = await mountPane(PANE, { sessions: [] });
  await expect(pane.frame.locator("#count")).toHaveText("0 sessions");
  expect(await focusIns(pane)).toBe(0);

  await enter(pane);
  await expect.poll(() => frameFocused(pane)).toBe(true);
  await expect.poll(() => focusIns(pane)).toBe(1);
  await stillAt(pane, 1);

  // Focusing the frame that already has focus is not a new hand-off.
  await pane.focus();
  await stillAt(pane, 1);

  // Leaving and entering again is the next hand-off.
  await enter(pane);
  await expect.poll(() => focusIns(pane)).toBe(2);
  await stillAt(pane, 2);
});

test("a focus request before the pane is ready posts one focus-in once it is", async ({
  mountPane,
  page,
}) => {
  // Hold the pane's document so the focus request is queued before the page can be ready.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let requested = false;
  await page.route("**/sample-pane.html*", async (route) => {
    requested = true;
    await held;
    await route.continue();
  });
  const pane = await mountPane(PANE, { sessions: [] }, { awaitFrame: false });
  await pane.page.waitForFunction(() => !!(window as any).control);
  await expect.poll(() => requested).toBe(true);
  await pane.focus();
  release();
  await expect.poll(() => focusIns(pane)).toBe(1);
  await expect.poll(() => frameFocused(pane)).toBe(true);
  await stillAt(pane, 1);
});

test("a reload while the pane has focus tells the new page once", async ({ mountPane }) => {
  const pane = await mountPane(PANE, { sessions: [] });
  await expect(pane.frame.locator("#count")).toHaveText("0 sessions");
  await enter(pane);
  await expect.poll(() => focusIns(pane)).toBe(1);
  const { boot } = await pane.probe();
  await pane.frame.evaluate(() => setTimeout(() => location.reload(), 0));
  await expect.poll(async () => (await pane.probe().catch(() => ({ boot }))).boot).not.toBe(boot);
  // The host makes a reloading frame inert until its page is themed, so focus does not stay in
  // it; the new page is still told once, never twice.
  await expect.poll(() => focusIns(pane)).toBe(1);
  await stillAt(pane, 1);
});
