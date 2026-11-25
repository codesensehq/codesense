// SPDX-License-Identifier: MIT
import { expect, test, type Page } from "@playwright/test";

/**
 * A CLI started by hand gets its chat too (frontend mock backend, `?agents=team` world: in the
 * BUG-151 workspace someone typed `claude` into a tab, with no launch record; the spec delivers
 * what its host observes). Until the CLI is first Ready the tab stays on the CLI and the Chat segment carries a
 * dashed pending ring; at its first idle the chat covers the tab without taking the keyboard, and
 * ⌘I flips it both ways.
 */

const HAND_WS = "BUG-151";
const HAND_TAB = "sess-notify-hand";

const chatSeg = (page: Page) => page.getByTestId(`chat-cli-switch-${HAND_TAB}-chat`);
const cliSeg = (page: Page) => page.getByTestId(`chat-cli-switch-${HAND_TAB}-cli`);
const overlay = (page: Page) =>
  page.locator(`[data-testid="inbox-split-${HAND_TAB}"] [data-testid="chat-overlay"]`);
const terminalInput = (page: Page) =>
  page.locator(`[data-testid="inbox-split-${HAND_TAB}"] .xterm textarea`);

async function boot(page: Page) {
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.goto("/?agents=team");
  await page.getByRole("button", { name: "Full screen" }).click();
  await page.getByTestId(`tile-zoom-${HAND_WS}`).click();
  await page.getByRole("tab", { name: /^remote codese/ }).click();
  await expect(chatSeg(page)).toBeVisible();
}

/**
 * What the tab's host observes of the hand-started Claude, as its activity snapshot reports it
 * (the mock world has no observer for it, so the spec delivers one).
 */
async function observed(page: Page, state: "working" | "idle", revision: number) {
  await page.evaluate(
    async ({ session, state, revision }) => {
      const { useAgentStateStore } = await import("/src/shared/stores/agent-state-store.ts");
      useAgentStateStore.getState().recordActivity(
        {
          session,
          identity: { hostBootId: "mock", sessionIncarnation: "shell", invocationId: "claude" },
          revision,
          turnGeneration: 0,
          provider: "claude",
          state,
          observed: true,
          limited: false,
          exit: null,
          asks: [],
        } as never,
        0,
      );
    },
    { session: HAND_TAB, state, revision },
  );
}
let revision = 0;

/** ⌘I on macOS, Ctrl+I elsewhere, as the app reads the platform. */
async function flipKey(page: Page) {
  const mac = await page.evaluate(() => /Mac/i.test(navigator.platform));
  await page.keyboard.press(mac ? "Meta+i" : "Control+i");
}
/** It finishes its turn: its first Ready. */
const firstIdle = (page: Page) => observed(page, "idle", ++revision);

test.describe("a CLI started by hand", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
    // At work on its first turn, observed, so it will report Ready.
    await observed(page, "working", ++revision);
  });

  test("stays on the CLI with a pending ring, then its chat covers the tab at its first idle", async ({
    page,
  }) => {
    await expect(page.getByTestId(`terminal-grid-caption-hand-${HAND_TAB}`)).toHaveText("by hand");
    await expect(chatSeg(page)).toHaveAttribute("data-pending", "true");
    await expect(cliSeg(page)).toHaveAttribute("aria-checked", "true");
    await expect(overlay(page)).toHaveCount(0);

    // The person is typing elsewhere when the CLI becomes Ready.
    const search = page.getByPlaceholder("Find agents…");
    await search.focus();
    await firstIdle(page);

    await expect(overlay(page)).toBeVisible();
    await expect(chatSeg(page)).toHaveAttribute("aria-checked", "true");
    await expect(chatSeg(page)).not.toHaveAttribute("data-pending", /.*/);
    await expect(page.getByTestId("chat-overlay-empty")).toContainText(
      "No messages with Claude yet",
    );
    // The cover never takes the keyboard from where the person is typing.
    await expect(search).toBeFocused();
  });

  test("⌘I flips it to the CLI and back, keeping the same chat", async ({ page }) => {
    await page.getByTestId(`terminal-grid-caption-focus-${HAND_TAB}`).click();
    await firstIdle(page);
    await expect(overlay(page)).toBeVisible();
    await overlay(page).evaluate((el) => {
      (window as unknown as { handChat: Element }).handChat = el;
    });

    await flipKey(page);
    await expect(cliSeg(page)).toHaveAttribute("aria-checked", "true");
    await expect(overlay(page)).toBeHidden();
    await expect(terminalInput(page)).toBeFocused();
    // The person's flip holds: the chat does not cover the tab again on its own.
    await firstIdle(page);
    await expect(overlay(page)).toBeHidden();

    // Back from the tab's caption: off macOS the key is Ctrl+I, which a terminal reads as Tab.
    await page.getByTestId(`terminal-grid-caption-focus-${HAND_TAB}`).focus();
    await flipKey(page);
    await expect(chatSeg(page)).toHaveAttribute("aria-checked", "true");
    await expect(overlay(page)).toBeVisible();
    expect(
      await overlay(page).evaluate(
        (el) => el === (window as unknown as { handChat: Element }).handChat,
      ),
    ).toBe(true);
  });
});
