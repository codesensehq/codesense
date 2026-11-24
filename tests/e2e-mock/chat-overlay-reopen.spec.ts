// SPDX-License-Identifier: MIT
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * An agent's chat overlay opens at its newest message every time, not only the first time
 * (frontend mock backend, `?agents=team` world). Reopened, the list is laid out once and then
 * gets shorter as the cards above it are drawn; that must not leave it short of its end. A
 * reader who scrolled up and closed the chat finds it at the newest message too: closing ends
 * that read.
 *
 * The mock backend has no session inbox, so `list_session_inbox` is answered here with a
 * generated conversation.
 */

const AGENT_TAB = "sess-login-lead";
const MESSAGES = 120;
const NEWEST = `acme/widgets#${MESSAGES}`;

async function boot(page: Page) {
  await page.addInitScript(
    ({ count }) => {
      const now = Date.now();
      const make = (handle: string) => ({
        handle,
        roles: [],
        messages: Array.from({ length: count }, (_, i) => {
          const id = i + 1;
          const mine = id % 3 === 0;
          return {
            id,
            team: { org: "acme", team: "widgets" },
            from: mine ? "human" : handle,
            fromName: mine ? "You" : "lead",
            to: mine ? handle : "human",
            toName: mine ? "lead" : "You",
            toRole: null,
            text: `line ${id}: ${"lorem ipsum dolor sit amet ".repeat((id % 4) * 3 + 1)}`,
            contentType: "markdown",
            createdAtMs: now - (count - id) * 60_000,
            inReplyTo: null,
            via: null,
            replyTo: null,
            summary: null,
            unread: false,
            delivery: null,
          };
        }),
      });
      type Internals = { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> };
      let inner: Internals | undefined;
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        configurable: true,
        get: () => inner,
        set: (v: Internals) => {
          const orig = v.invoke.bind(v);
          v.invoke = (cmd, args) =>
            cmd === "list_session_inbox" || cmd === "list_thread_inbox"
              ? Promise.resolve(make(String(args?.handle ?? args?.session ?? "x")))
              : orig(cmd, args);
          inner = v;
        },
      });
    },
    { count: MESSAGES },
  );
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.goto("/?agents=team");
  await page.getByRole("button", { name: "Full screen" }).click();
}

const chatSegment = (page: Page) => page.getByTestId(`chat-cli-switch-${AGENT_TAB}-chat`);
const cliSegment = (page: Page) => page.getByTestId(`chat-cli-switch-${AGENT_TAB}-cli`);

// A launched agent's tab opens on its chat: Chat is the open state, CLI the closed one.
async function open(page: Page): Promise<Locator> {
  await chatSegment(page).click();
  const msgs = page.getByTestId("chat-overlay").getByTestId("ibx-msgs");
  await expect(msgs.locator(`[data-mid="${NEWEST}"]`)).toBeAttached();
  return msgs;
}

async function close(page: Page) {
  await cliSegment(page).click();
  await expect(page.getByTestId("chat-overlay")).toHaveCount(0);
}

/** How far (px) the newest message's bottom sits below the list's visible edge; 0 in view. */
const gapBelow = (msgs: Locator) =>
  msgs.evaluate((list, newest) => {
    const row = list.querySelector(`[data-mid="${newest}"]`)!.getBoundingClientRect();
    return Math.max(0, Math.round(row.bottom - list.getBoundingClientRect().bottom - 1));
  }, NEWEST);

/** Settled at the newest message, and still there a moment later (nothing pulls it away). */
async function expectAtNewest(page: Page, msgs: Locator) {
  await expect.poll(() => gapBelow(msgs)).toBe(0);
  await page.waitForTimeout(500);
  expect(await gapBelow(msgs)).toBe(0);
}

test.describe("chat overlay reopen", () => {
  test("opens at the newest message the second time too", async ({ page }) => {
    await boot(page);
    await expectAtNewest(page, await open(page));
    await close(page);
    await expectAtNewest(page, await open(page));
  });

  test("a reader who scrolled up and closed it reopens at the newest message", async ({ page }) => {
    await boot(page);
    const msgs = await open(page);
    await expectAtNewest(page, msgs);
    await msgs.evaluate((el) => (el.scrollTop = el.scrollHeight / 3));
    await expect.poll(() => gapBelow(msgs)).toBeGreaterThan(0);
    await close(page);
    await expectAtNewest(page, await open(page));
  });
});
