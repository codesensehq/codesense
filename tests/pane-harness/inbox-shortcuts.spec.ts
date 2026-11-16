// SPDX-License-Identifier: MIT
import { test, expect } from "./harness";
import { INBOX_PANE, messageViewFixtures } from "./inbox-message-view-fixtures";

// A real Chromium keystroke through the real frame key shim, not a synthesized event.
for (const [start, after] of [
  ["shared", "viewer"],
  ["viewer", "shared"],
] as const) {
  test(`Cmd-backslash from the Inbox composer takes the CLI from ${start} to ${after}`, async ({
    mountPane,
  }) => {
    const pane = await mountPane(INBOX_PANE, messageViewFixtures());
    await pane.setTeam("fixture", "dev");
    await pane.seedForegroundTile(start);
    await pane.frame.locator(".ib-row").first().click();
    const draft = pane.frame.locator("#draft");
    await draft.fill("A draft to keep");
    await pane.page.keyboard.press("Meta+Backslash");
    await expect.poll(() => pane.layoutMode()).toBe(after);
    await expect(draft).toHaveValue("A draft to keep");
  });
}
