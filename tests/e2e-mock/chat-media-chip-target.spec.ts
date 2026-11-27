// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";

// An image card's chips draw at 22px but take clicks 1px past their top and bottom edges, so
// each target is 24px tall (WCAG 2.5.8). Runs on the mock chat media harness.
const TARGETS = [
  { state: "tap-to-load", target: (row: string) => `${row} button.ibx-chip` },
  { state: "failed", target: (row: string) => `${row} button.ibx-chip` },
  { state: "blocked", target: (row: string) => `${row} .ibx-chip a` },
];

test("an image card's chips take clicks 1px past their drawn edges, and still draw at 22px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 1400 });
  await page.goto("/?harness=chat-media&theme=dark");
  for (const { state, target } of TARGETS) {
    const selector = target(`[data-state="${state}"]`);
    const el = page.locator(selector);
    await el.scrollIntoViewIfNeeded();
    const hit = await el.evaluate((node) => {
      const chip = node.closest(".ibx-chip")!.getBoundingClientRect();
      const x = chip.left + chip.width / 2;
      const owns = (y: number) => {
        const at = document.elementFromPoint(x, y);
        return !!at && (at === node || node.contains(at));
      };
      return {
        height: chip.height,
        above: owns(chip.top - 1),
        below: owns(chip.bottom + 0.99),
        outside: owns(chip.top - 2) || owns(chip.bottom + 2),
      };
    });
    expect(hit, state).toEqual({ height: 22, above: true, below: true, outside: false });
  }
  await page.locator('[data-state="failed"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/chat-media-chip-target.png", fullPage: true });
});
