// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

/**
 * The "what needs you" dashboard a lead sends on request is an HTML message, and the person pins
 * it like any other: from the Pin in its title bar, through the pins bridge (`agent_pins`). This
 * runs a real snapshot of that dashboard in a real browser.
 *
 * The mock backend has no session inbox and serves fixed pins, so `list_session_inbox` and
 * `agent_pins` are answered here: the conversation holds the snapshot, and the pins start empty
 * and take whatever is pinned. Every `agent_pins` call is recorded.
 */

const AGENT_TAB = "sess-login-lead";
const SNAPSHOT = readFileSync(
  new URL("../fixtures/needs-you-snapshot.html", import.meta.url),
  "utf-8",
);
const SUMMARY = "Two things wait on you";
const MESSAGE_ID = 7;

declare global {
  interface Window {
    __pinCalls: Array<Record<string, unknown>>;
  }
}

async function boot(page: Page) {
  await page.addInitScript(
    ({ html, summary, id }) => {
      window.__pinCalls = [];
      const now = Date.now();
      const pins: Array<Record<string, unknown>> = [];
      const conversation = (handle: string) => ({
        handle,
        roles: [],
        messages: [
          {
            id: id - 1,
            team: { org: "acme", team: "widgets" },
            from: "human",
            fromName: "You",
            to: handle,
            toName: "lead",
            toRole: null,
            text: "What needs me?",
            contentType: "markdown",
            createdAtMs: now - 120_000,
            inReplyTo: null,
            via: null,
            replyTo: null,
            summary: null,
            unread: false,
            delivery: null,
          },
          {
            id,
            team: { org: "acme", team: "widgets" },
            from: handle,
            fromName: "lead",
            to: "human",
            toName: "You",
            toRole: null,
            text: html,
            contentType: "html",
            createdAtMs: now - 60_000,
            inReplyTo: id - 1,
            via: null,
            replyTo: null,
            summary,
            unread: false,
            delivery: null,
          },
        ],
      });
      type Internals = {
        invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown>;
      };
      let inner: Internals | undefined;
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        configurable: true,
        get: () => inner,
        set: (v: Internals) => {
          const orig = v.invoke.bind(v);
          v.invoke = (cmd, args) => {
            if (cmd === "list_session_inbox" || cmd === "list_thread_inbox")
              return Promise.resolve(conversation(String(args?.handle ?? args?.session ?? "x")));
            if (cmd === "agent_pins") {
              window.__pinCalls.push({ ...(args ?? {}) });
              if (args?.op === "pin")
                pins.push({
                  messageId: args.messageId,
                  position: pins.length,
                  pinnedBy: "human",
                  pinnedAtMs: Date.now(),
                  preview: null,
                  previewAtMs: null,
                  // What the pins read says the message is: the snapshot.
                  message: {
                    from: "lead",
                    createdAtMs: now - 60_000,
                    text: html,
                    contentType: "html",
                    summary,
                  },
                });
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
    },
    { html: SNAPSHOT, summary: SUMMARY, id: MESSAGE_ID },
  );
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.goto("/?agents=team");
  await page.getByRole("button", { name: "Full screen" }).click();
  await page.getByTestId(`chat-cli-switch-${AGENT_TAB}-chat`).click();
  const chat = page.locator('[data-testid="chat-overlay"]').first();
  await expect(chat).toBeVisible();
  return chat;
}

test("the needs-you dashboard pins from its title bar through the pins bridge, named by its summary", async ({
  page,
}) => {
  const chat = await boot(page);
  const bar = chat.getByTestId("ibx-dm-bar");
  await expect(bar).toContainText(SUMMARY);
  await bar.getByTestId("ibx-pin").click();

  await expect
    .poll(() => page.evaluate(() => window.__pinCalls.filter((c) => c.op === "pin")))
    .toEqual([expect.objectContaining({ op: "pin", messageId: MESSAGE_ID })]);
  const pin = chat.getByTestId(`chat-overlay-pin-${MESSAGE_ID}`);
  await expect(pin).toContainText(SUMMARY);
  await expect(pin).not.toContainText("What needs you");
});
