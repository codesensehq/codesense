// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";
import { mountProbe } from "./fixtures/probe";

/**
 * The probe dashboard counts its own loads, so tile specs can tell a frame that stayed put from
 * one that reloaded or remounted. This checks the probe itself, on both engines.
 */

test("a probe mounted once counts one load @p0", async ({ page }) => {
  const probe = await mountProbe(page);
  expect(await probe.counts()).toMatchObject({ inFrame: 1, stored: 1 });
  expect(await probe.hostLoads()).toBe(1);
});

test("a reload of the same frame keeps the stored count and resets the in-frame one @p0", async ({
  page,
}) => {
  const probe = await mountProbe(page);
  const src = await probe.frame.getAttribute("src");
  await probe.reload();
  expect(await probe.frame.getAttribute("src")).toBe(src);
  await expect.poll(() => probe.hostLoads()).toBe(2);
  expect(await probe.counts()).toMatchObject({ inFrame: 1, stored: 2 });
});

test("a remount as a new frame is caught by the host count @p0", async ({ page }) => {
  const probe = await mountProbe(page);
  const origin = new URL((await probe.frame.getAttribute("src"))!).origin;
  await probe.remount();
  expect(new URL((await probe.frame.getAttribute("src"))!).origin).not.toBe(origin);
  await expect.poll(() => probe.hostLoads()).toBe(2);
  // The new frame's origin starts with empty storage: only the host saw both loads.
  expect(await probe.counts()).toMatchObject({ inFrame: 1, stored: 1 });
});

test("a foreign message is recorded and the count request is not @p0", async ({ page }) => {
  const probe = await mountProbe(page);
  await probe.frame.evaluate((frame: HTMLIFrameElement) =>
    frame.contentWindow?.postMessage({ type: "host:hello", n: 7 }, "*"),
  );
  await expect
    .poll(async () => (await probe.counts()).received.map((message) => message.data))
    .toContainEqual({ type: "host:hello", n: 7 });
  const { received } = await probe.counts();
  const types = received.map((message) => (message.data as { type?: string } | null)?.type);
  expect(types).not.toContain("probe:count");
});
