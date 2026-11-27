// SPDX-License-Identifier: MIT
import { expect, test, type Page } from "@playwright/test";

/**
 * A satellite window boots the same bundle with `?window=<label>`. The mock hands that label to
 * the webview as Tauri metadata, as the real app does, and logs every invoke by name. The
 * satellite boots clean and writes nothing `main` owns: no app-state save, no viewer mirror push.
 * The `main` boot is the control, so the zero counts cannot pass on a log that records nothing.
 */

async function boot(page: Page, search: string) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/${search}`);
  await expect
    .poll(() =>
      page.evaluate(() => window.__stores?.useViewerStore.getState().stateLoaded ?? false),
    )
    .toBe(true);
  return errors;
}

const invokes = (page: Page) =>
  page.evaluate(() => [...((window as { __mockInvokes?: string[] }).__mockInvokes ?? [])]);

test("main saves the app state and pushes the viewer mirror on boot (control)", async ({
  page,
}) => {
  const errors = await boot(page, "?window=main");
  await expect.poll(() => invokes(page)).toContain("push_viewer_state");
  expect(await invokes(page)).toContain("save_app_state");
  expect(errors).toEqual([]);
});

test("a satellite boots clean, labelled from ?window=, and saves and pushes nothing", async ({
  page,
}) => {
  const errors = await boot(page, "?window=pane-x");

  const label = await page.evaluate(() => {
    const internals = (
      window as {
        __TAURI_INTERNALS__?: {
          metadata: { currentWindow: { label: string }; currentWebview: { label: string } };
        };
      }
    ).__TAURI_INTERNALS__;
    return [internals?.metadata.currentWindow.label, internals?.metadata.currentWebview.label];
  });
  expect(label).toEqual(["pane-x", "pane-x"]);

  // Past the 300 ms persist debounce, so a save that was going to happen has happened.
  await page.waitForTimeout(1500);
  const names = await invokes(page);
  expect(names).toContain("load_app_state");
  expect(names.filter((name) => name === "save_app_state")).toEqual([]);
  expect(names.filter((name) => name === "push_viewer_state")).toEqual([]);
  expect(errors).toEqual([]);
});
