// SPDX-License-Identifier: MIT
import { expect, test, type Page } from "@playwright/test";

/**
 * The overlay's Pin… at the pin limit carries the count of pins beside its icon. The count is
 * 11 px, the icon 13 px: the count's box sits clear of the icon's, at least 1 px apart, in light
 * and dark (frontend mock backend, `?agents=team`; `agent_pins` answers three pins, so a
 * message that isn't pinned offers Pin…). SHOTS=<dir> writes a crop of the button.
 */

const AGENT_TAB = "sess-login-lead";
const SHOTS = process.env.SHOTS;

async function boot(page: Page, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await page.addInitScript((t) => window.localStorage.setItem("theme", t), scheme);
  await page.addInitScript(() => {
    const now = Date.now();
    const message = (id: number, handle: string) => {
      const mine = id % 2 === 0;
      return {
        id,
        team: { org: "acme", team: "widgets" },
        from: mine ? "human" : handle,
        fromName: mine ? "You" : "lead",
        to: mine ? handle : "human",
        toName: mine ? "lead" : "You",
        toRole: null,
        text: `Message ${id} of the thread.`,
        contentType: "markdown",
        createdAtMs: now - (6 - id) * 60_000,
        inReplyTo: null,
        via: null,
        replyTo: null,
        summary: null,
        unread: false,
        delivery: null,
      };
    };
    const pins = [1, 2, 3].map((id, position) => ({
      messageId: id,
      position,
      pinnedBy: "human",
      pinnedAtMs: now - 1000,
      preview: null,
      previewAtMs: null,
    }));
    type Internals = { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> };
    let inner: Internals | undefined;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => inner,
      set: (v: Internals) => {
        const orig = v.invoke.bind(v);
        v.invoke = (cmd, args) => {
          if (cmd === "list_session_inbox") {
            const handle = String(args?.handle ?? "x");
            return Promise.resolve({
              handle,
              roles: [],
              messages: [1, 2, 3, 4, 5].map((id) => message(id, handle)),
            });
          }
          if (cmd === "agent_pins") {
            const team = (args?.team ?? {}) as { org?: string; team?: string };
            return Promise.resolve({
              status: "pins",
              org: team.org ?? "",
              team: team.team ?? "",
              agentId: String(args?.agentId ?? ""),
              storyId: String(args?.storyId ?? ""),
              pins,
            });
          }
          return orig(cmd, args);
        };
        inner = v;
      },
    });
  });
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.goto("/?agents=team");
  await page.getByRole("button", { name: "Full screen" }).click();
  await page.getByTestId(`terminal-grid-caption-inbox-${AGENT_TAB}`).click();
  const chat = page.getByTestId("chat-overlay").first();
  await expect(chat).toBeVisible();
  return chat;
}

for (const scheme of ["light", "dark"] as const) {
  test(`the cap count sits clear of the Pin icon (${scheme})`, async ({ page }) => {
    const chat = await boot(page, scheme);
    const row = chat.locator("[data-mid]").last();
    await row.hover();
    const button = row.getByTestId("ibx-pin");
    await expect(button.locator(".ibx-pin-cap")).toBeVisible();
    const boxes = await button.evaluate((b) => {
      const box = (n: Element) => n.getBoundingClientRect().toJSON() as DOMRect;
      return { icon: box(b.querySelector("svg")!), cap: box(b.querySelector(".ibx-pin-cap")!) };
    });
    const apart =
      boxes.cap.left >= boxes.icon.right + 1 ||
      boxes.cap.right + 1 <= boxes.icon.left ||
      boxes.cap.top >= boxes.icon.bottom + 1 ||
      boxes.cap.bottom + 1 <= boxes.icon.top;
    expect(apart, JSON.stringify(boxes)).toBe(true);
    if (SHOTS) await button.screenshot({ path: `${SHOTS}/cap-${scheme}.png` });
  });
}
