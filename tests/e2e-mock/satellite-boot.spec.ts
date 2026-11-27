// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * A satellite window boots the same bundle with `?window=<label>`. The mock hands that label to
 * the webview as Tauri metadata, as the real app does, and logs every invoke by name. The
 * satellite boots clean and writes nothing `main` owns: no app-state save, no viewer mirror push.
 * The `main` boot is the control, so the zero counts cannot pass on a log that records nothing.
 * A satellite renders `satellite-root.tsx`, never `App`, and calls no command `main` owns.
 */

/** The commands only `main` may call (the Rust ACL's list), and the layout snapshot. */
const MAIN_ONLY = [
  ...(
    JSON.parse(readFileSync("src-tauri/src/windows/command_acl.json", "utf8")) as { name: string }[]
  ).map((entry) => entry.name),
  "terminal_layout_snapshot",
];

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function boot(page: Page, search: string) {
  const errors = collectErrors(page);
  await page.goto(`/${search}`);
  await expect
    .poll(() =>
      page.evaluate(() => window.__stores?.useViewerStore.getState().stateLoaded ?? false),
    )
    .toBe(true);
  return errors;
}

async function bootSatellite(page: Page, label: string) {
  const errors = collectErrors(page);
  await page.goto(`/?window=${label}`);
  await expect(page.locator("[data-satellite-root]")).toBeAttached();
  await expect.poll(() => invokes(page)).toContain("load_app_state");
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
  const errors = await bootSatellite(page, "pane-x");

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

test("a satellite calls no main-only command, reads through the bridge, and patches its own prefs", async ({
  page,
}) => {
  const errors = await bootSatellite(page, "pane-y");
  await page.waitForTimeout(1500);
  expect((await invokes(page)).filter((name) => MAIN_ONLY.includes(name))).toEqual([]);

  // One bridge read: a read command a satellite may call.
  const context = await page.evaluate(async () => {
    const { bridgeDocContext } = await import("/src/tauri/commands.ts");
    return bridgeDocContext("/mock/content/index.html").then(
      () => "ok",
      (error: unknown) => String(error),
    );
  });
  expect(context).toBe("ok");
  expect(await invokes(page)).toContain("bridge_doc_context");

  // A shortcut change is a key patch through patch_app_state_keys, never a full save.
  await page.evaluate(async () => {
    const shortcuts = await import("/src/shared/stores/shortcuts-store.ts");
    shortcuts.useShortcutsStore.getState().clearShortcut("app.command-palette");
    await shortcuts.flushShortcutsForProfileSwitch();
  });
  await expect.poll(() => invokes(page)).toContain("patch_app_state_keys");
  const names = await invokes(page);
  expect(names.filter((name) => name === "save_app_state")).toEqual([]);
  expect(names.filter((name) => MAIN_ONLY.includes(name))).toEqual([]);
  expect(errors).toEqual([]);
});
