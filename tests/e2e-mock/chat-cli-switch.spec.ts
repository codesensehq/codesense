// SPDX-License-Identifier: MIT
import { expect, test, type Page } from "@playwright/test";

/**
 * A launched agent's tab opens on its chat, covering the terminal, with the caption's
 * Chat | CLI switch to flip it (frontend mock backend, `?agents=team` world: its launched agents
 * carry the "opened as agent" mark). A plain shell has no switch.
 */

const BUG = "BUG-142";
const AGENT_TAB = "sess-login-lead";
const CONTENT_WS = "generic:/mock/users/4242/orgs/acme/widgets/default/content";
const SHELL_TAB = "demo-shell";

const chatSeg = (page: Page, tab = AGENT_TAB) => page.getByTestId(`chat-cli-switch-${tab}-chat`);
const cliSeg = (page: Page, tab = AGENT_TAB) => page.getByTestId(`chat-cli-switch-${tab}-cli`);
const overlay = (page: Page) =>
  page.locator(`[data-testid="inbox-split-${AGENT_TAB}"] [data-testid="chat-overlay"]`);

async function boot(page: Page) {
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.goto("/?agents=team");
  await page.getByRole("button", { name: "Full screen" }).click();
  await page.getByTestId(`tile-zoom-${BUG}`).click();
  await expect(chatSeg(page)).toBeVisible();
}

/** Give the tab's pane (caption and body) exactly `width` px. */
async function paneWidth(page: Page, width: number) {
  await page.evaluate(
    ({ tab, width }) => {
      const pane = document.querySelector<HTMLElement>(`[data-focus-pane="${tab}"]`)!;
      Object.assign(pane.style, { flex: "none", width: `${width}px`, maxWidth: `${width}px` });
    },
    { tab: AGENT_TAB, width },
  );
}

test.describe("the Chat | CLI switch", () => {
  test.beforeEach(async ({ page }) => boot(page));

  test("a launched agent opens on its chat, covering its terminal", async ({ page }) => {
    await expect(overlay(page)).toBeVisible();
    await expect(chatSeg(page)).toHaveAttribute("aria-checked", "true");
    await expect(cliSeg(page)).toHaveAttribute("aria-checked", "false");
    await expect(
      page.locator(`[data-testid="inbox-split-${AGENT_TAB}"] .ibx-split-term`),
    ).toHaveAttribute("inert", /.*/);
    // The cover never leaves the keyboard on the hidden terminal.
    await expect(
      page.locator(`[data-testid="inbox-split-${AGENT_TAB}"] .xterm textarea`),
    ).not.toBeFocused();
  });

  test("flips to the CLI and back, in under 100 ms each way", async ({ page }) => {
    const flip = (to: "cli" | "chat") =>
      page.evaluate(
        ({ tab, to }) =>
          new Promise<number>((resolve, reject) => {
            const button = document.querySelector<HTMLElement>(
              `[data-testid="chat-cli-switch-${tab}-${to}"]`,
            );
            if (!button) return reject(new Error("no switch"));
            const shown = () => {
              const chat = document.querySelector(
                `[data-testid="inbox-split-${tab}"] [data-testid="chat-overlay"]`,
              );
              return to === "cli" ? chat === null : chat !== null;
            };
            const start = performance.now();
            button.click();
            const poll = () => {
              if (shown()) return resolve(performance.now() - start);
              requestAnimationFrame(poll);
            };
            poll();
          }),
        { tab: AGENT_TAB, to },
      );
    expect(await flip("cli")).toBeLessThan(100);
    await expect(cliSeg(page)).toHaveAttribute("aria-checked", "true");
    await expect(
      page.locator(`[data-testid="inbox-split-${AGENT_TAB}"] .xterm textarea`),
    ).toBeFocused();
    expect(await flip("chat")).toBeLessThan(100);
    await expect(chatSeg(page)).toHaveAttribute("aria-checked", "true");
    await expect(overlay(page).locator(".ibx-comp textarea")).toBeFocused();
  });

  test("arrow keys move the selection and keep focus on the switch", async ({ page }) => {
    await chatSeg(page).focus();
    await page.keyboard.press("ArrowRight");
    await expect(cliSeg(page)).toHaveAttribute("aria-checked", "true");
    await expect(cliSeg(page)).toBeFocused();
    await expect(overlay(page)).toHaveCount(0);
    await page.keyboard.press("ArrowLeft");
    await expect(chatSeg(page)).toHaveAttribute("aria-checked", "true");
    await expect(chatSeg(page)).toBeFocused();
  });

  test("the tab keeps its choice through a tab switch", async ({ page }) => {
    await cliSeg(page).click();
    await expect(overlay(page)).toHaveCount(0);
    await page
      .getByRole("tab", { name: /Reproduce timeout/ })
      .first()
      .click();
    await page
      .getByRole("tab", { name: /Login timeout lead/ })
      .first()
      .click();
    await expect(cliSeg(page)).toHaveAttribute("aria-checked", "true");
    await expect(overlay(page)).toHaveCount(0);
  });

  test("labels from 480 px of pane width, icons only below", async ({ page }) => {
    await paneWidth(page, 479);
    await expect(chatSeg(page)).not.toContainText("Chat");
    await expect(chatSeg(page)).toHaveAccessibleName(/^Chat/);
    await expect(cliSeg(page)).toHaveAccessibleName(/^CLI/);
    await paneWidth(page, 480);
    await expect(chatSeg(page)).toContainText("Chat");
    await expect(cliSeg(page)).toContainText("CLI");
  });

  test("small panes scroll nothing sideways", async ({ page }) => {
    await paneWidth(page, 250);
    const overflow = await page.evaluate((tab) => {
      const pane = document.querySelector<HTMLElement>(`[data-focus-pane="${tab}"]`)!;
      const caption = pane.querySelector<HTMLElement>(
        `[data-testid="terminal-grid-caption-${tab}"]`,
      )!;
      return {
        pane: pane.scrollWidth - pane.clientWidth,
        caption: caption.scrollWidth - caption.clientWidth,
      };
    }, AGENT_TAB);
    expect(overflow.pane).toBeLessThanOrEqual(0);
    expect(overflow.caption).toBeLessThanOrEqual(0);
  });

  test("a plain shell has no switch and no chat", async ({ page }) => {
    await page.getByTestId(`tile-zoom-${BUG}`).click();
    await page.getByTestId(`tile-zoom-${CONTENT_WS}`).click();
    await page.getByTestId(`tile-grid-toggle-${CONTENT_WS}`).click();
    await expect(page.getByTestId(`chat-cli-switch-${SHELL_TAB}`)).toHaveCount(0);
    await expect(
      page.locator(`[data-testid="inbox-split-${SHELL_TAB}"] [data-testid="chat-overlay"]`),
    ).toHaveCount(0);
  });
});
