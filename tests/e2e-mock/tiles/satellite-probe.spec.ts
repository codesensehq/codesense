// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { probeResults, writeSatelliteProbe } from "./fixtures/satellite-probe";

/**
 * The satellite probe route (`?window=<label>&probe=<path>`) mounts one file's viewer through
 * the satellite root, with a one-item slice and no registry entry behind it. The probe dashboard
 * reads a team file through the bridge and hears it change, and its answers reach the
 * satellite's top page, where a spec reads them without entering the frame.
 */

const CONTENT = "/mock-ctx/default/content";

test("a satellite probe reads a team file and hears it change @p0", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Each test its own pane id: the dev server tells every open page about each pane write.
  const id = `satellite-probe-${randomUUID().slice(0, 8)}`;
  await writeSatelliteProbe(page, "default", id);
  await page.goto(`/?window=pane-probe&probe=/mock-ctx/default/panes/${id}.html`);
  const root = page.locator('[data-e2e-probe="codesense-e2e-satellite-probe"]');
  await expect(root.locator("[data-satellite-root]")).toBeAttached();
  await expect(root.locator(`iframe[src*="/${id}.html"]`)).toHaveCount(1);
  // The file is not there yet: the bridge refuses the read, and the refusal reaches the page.
  await expect.poll(async () => (await probeResults(page)).read).toMatch(/^refused: /);
  await page.evaluate(
    ([path, content]) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke("write_content_file", { path, content }),
    [`${CONTENT}/probe-read.txt`, "written after the probe loaded"] as const,
  );
  await expect
    .poll(() => probeResults(page))
    .toEqual({
      read: "written after the probe loaded",
      push: "probe-read.txt",
      // When the viewer's frame first drew, which the real-app first-paint spec reads.
      painted: expect.stringMatching(/^\d{13}$/),
    });
  expect(errors).toEqual([]);
});
