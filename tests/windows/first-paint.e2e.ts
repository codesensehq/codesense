// SPDX-License-Identifier: MIT
// How long a real `pane-` window takes to paint: the first probe window of this app launch
// (cold), then five more in the same launch (warm). Each time is epoch ms from just before
// `open()` in `main` to the first animation frame after the window's probe viewer has its frame
// (`painted`, recorded by the probe route). The WebKit web processes' RSS is summed before and
// after each open. Nothing is asserted on the numbers: the job keeps them as an artifact, and
// `COLD_FIRST_PAINTS_MS` (`src-tauri/src/windows/pending_timeout.rs`) is set from the cold
// times of five launches.
//
// The runner runs this spec alone (CODESENSE_WINDOWS_E2E_FIRST_PAINT=1, see
// wdio.windows.conf.ts), so its first window is the launch's first.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browser, expect } from "@wdio/globals";
import { freshId, MAIN, open, probeResults, seed } from "./lib/driver";

const WARM = 5;
const artifacts = path.join(path.dirname(fileURLToPath(import.meta.url)), "artifacts");

/** The summed RSS, in KB, of the WebKit web processes now running. */
function webProcessRssKb(): number {
  const rows = execFileSync("ps", ["-A", "-o", "rss=,comm="], { encoding: "utf8" });
  return rows
    .split("\n")
    .map((row) => row.trim().match(/^(\d+)\s+(.*)$/))
    .filter((row) => row !== null && /WebKitWebProces|WebKit\.WebContent/.test(row[2]))
    .reduce((sum, row) => sum + Number(row![1]), 0);
}

function appRev(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

describe("first paint of a pane window", () => {
  let probeHtml: string;

  before(async () => {
    ({ probeHtml } = await seed());
  });

  it("times one cold and five warm opens", async () => {
    const times: number[] = [];
    const rssDeltaKb: number[] = [];
    for (let i = 0; i <= WARM; i++) {
      await browser.switchToWindow(MAIN);
      const rssBefore = webProcessRssKb();
      const start = await browser.execute(() => Date.now());
      await open({ id: freshId("paint"), probe: probeHtml });
      await browser.waitUntil(async () => "painted" in (await probeResults()), {
        interval: 50,
        timeout: 60_000,
        timeoutMsg: "the probe viewer never drew its frame",
      });
      times.push(Number((await probeResults()).painted) - start);
      rssDeltaKb.push(webProcessRssKb() - rssBefore);
      await browser.closeWindow();
    }
    const [cold, ...warm] = times;
    const run = [
      process.env.GITHUB_RUN_ID ?? "local",
      process.env.FIRST_PAINT_LAUNCH ?? Date.now(),
    ];
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(
      path.join(artifacts, `first-paint-${run.join("-")}.json`),
      `${JSON.stringify(
        {
          platform: `${process.platform}-${process.arch}`,
          appRev: appRev(),
          cold: [cold],
          warm,
          rssDeltaKb,
        },
        null,
        2,
      )}\n`,
    );
    expect(times).toHaveLength(WARM + 1);
  });
});
