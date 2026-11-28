// SPDX-License-Identifier: MIT
import fs from "node:fs";
import { expect, type Page } from "@playwright/test";

/**
 * The satellite probe dashboard (`tests/windows/fixtures/probe.html`, the one the real-app
 * driver seeds) in the mock world: `writeSatelliteProbe` puts it in the mock's pane store, and
 * `probeResults` reads what it posted to the satellite's top page.
 */

const HTML = fs.readFileSync(
  new URL("../../../windows/fixtures/probe.html", import.meta.url),
  "utf8",
);

/** Writes the probe into the mock's pane store as `<team>/<id>`, as an agent's pane_write would. */
export async function writeSatelliteProbe(page: Page, team: string, id: string): Promise<void> {
  const response = await page.request.put(`/__mock-panes/${team}/${id}`, { data: HTML });
  expect(response.status()).toBe(204);
}

/** The `probe:result` answers the probe route kept, by key. */
export function probeResults(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => ({
    ...(window as { __CODESENSE_PROBE_RESULTS__?: Record<string, string> })
      .__CODESENSE_PROBE_RESULTS__,
  }));
}
