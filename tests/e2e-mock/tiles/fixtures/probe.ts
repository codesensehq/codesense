// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { expect, type Page } from "@playwright/test";

/**
 * The probe dashboard (`probe-dashboard.html`), a pane that counts its own loads, for specs that
 * must tell a frame that stayed put from one that reloaded or remounted.
 *
 *   const probe = await mountProbe(page);  // the live-hub harness, the probe in a right-pane slot
 *   await probe.counts();                  // { key, inFrame, stored, received }, from the frame
 *   await probe.hostLoads();               // the probe:load posts the host page counted
 *   await probe.remount();                 // unmount the slot and mount it again: a new frame
 *
 * In another world: `watchProbeLoads(page)` before the page loads, `writeProbe` into the mock's
 * pane store (`/__mock-panes/`), open it there, then `probeCounts` and `hostLoads`.
 */

const HTML = fs.readFileSync(new URL("./probe-dashboard.html", import.meta.url), "utf8");

export interface ProbeCounts {
  key: string;
  /** Loads of this document: 1 after any reload or remount. */
  inFrame: number;
  /** Loads this frame's origin stored: survives a reload, starts again on a remount. */
  stored: number;
  /** Every message the probe received, other than its own count requests. */
  received: Array<{ origin: string; data: unknown }>;
}

type ProbeWindow = Window & { __probeLoads?: Record<string, number> };

/** Counts each probe:load the probe posts to the host page, by its key. Call before `goto`. */
export async function watchProbeLoads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const loads: Record<string, number> = {};
    (window as ProbeWindow).__probeLoads = loads;
    addEventListener("message", (event) => {
      const data = event.data as { type?: string; key?: unknown } | null;
      if (data?.type === "probe:load" && typeof data.key === "string")
        loads[data.key] = (loads[data.key] ?? 0) + 1;
    });
  });
}

/** Writes the probe into the mock's pane store as `<team>/<id>`, as an agent's pane_write would. */
export async function writeProbe(page: Page, team: string, id: string): Promise<void> {
  const response = await page.request.put(`/__mock-panes/${team}/${id}`, { data: HTML });
  expect(response.status()).toBe(204);
}

/** The probe frames (pane `id`) in the host page, by the file their URL names. */
const probeFrames = (id: string) => `iframe[src*="/${id}.html"]`;

/** The probe's own counts, asked for by postMessage from the host page. */
export async function probeCounts(page: Page, id: string): Promise<ProbeCounts> {
  return page.evaluate(
    (selector) =>
      new Promise<ProbeCounts>((resolve, reject) => {
        const frames = document.querySelectorAll<HTMLIFrameElement>(selector);
        if (frames.length !== 1) return reject(new Error(`${frames.length} frames ${selector}`));
        const target = frames[0].contentWindow;
        const timer = setTimeout(() => reject(new Error("the probe did not answer")), 5_000);
        const listener = (event: MessageEvent) => {
          if (event.source !== target || event.data?.type !== "probe:counts") return;
          clearTimeout(timer);
          removeEventListener("message", listener);
          const { key, inFrame, stored, received } = event.data;
          resolve({ key, inFrame, stored, received });
        };
        addEventListener("message", listener);
        target?.postMessage({ type: "probe:count" }, "*");
      }),
    probeFrames(id),
  );
}

/** The probe:load posts the host page counted for `key`. */
export async function hostLoads(page: Page, key: string): Promise<number> {
  return page.evaluate((key) => (window as ProbeWindow).__probeLoads?.[key] ?? 0, key);
}

type Harness = Window & {
  __liveHubMount: (n: number, shown?: boolean, inSlot?: boolean, id?: string) => void;
};

/**
 * The probe as a right-pane slot in the live-hub harness (`?harness=live-hub`). The dev server
 * tells every open page about each pane write, so each mount gets its own id: a shared one would
 * let a parallel test's write refresh this probe into a new frame.
 */
export async function mountProbe(page: Page, id = `probe-${randomUUID().slice(0, 8)}`) {
  await watchProbeLoads(page);
  await writeProbe(page, "default", id);
  await page.goto("/?harness=live-hub");
  await page.waitForFunction(() => !!(window as unknown as Harness).__liveHubMount);
  const mount = (n: number) =>
    page.evaluate(
      ([n, id]) => (window as unknown as Harness).__liveHubMount(n, true, true, id),
      [n, id] as const,
    );
  await mount(1);
  const frame = page.locator(probeFrames(id));
  const loaded = async () => {
    await expect(frame).toHaveCount(1);
    await expect(page.frameLocator(probeFrames(id)).locator("#in-frame")).toHaveText("1");
  };
  await loaded();
  const counts = () => probeCounts(page, id);
  return {
    id,
    frame,
    counts,
    hostLoads: async () => hostLoads(page, (await counts()).key),
    /** Reloads the probe's frame in place: same frame, same origin. */
    reload: async () => {
      const handle = await frame.elementHandle();
      await (await handle?.contentFrame())?.evaluate(() => location.reload());
      await loaded();
    },
    /** Unmounts the slot and mounts it again: a new frame on a new origin. */
    remount: async () => {
      await mount(0);
      await expect(frame).toHaveCount(0);
      await mount(1);
      await loaded();
    },
  };
}
