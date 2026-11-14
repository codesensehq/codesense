// SPDX-License-Identifier: MIT
import { expect, test, type Page } from "@playwright/test";

/**
 * Real-browser layout guards for a terminal tab's body:
 *
 *  - Each tab's agent inbox pane opens INSIDE that tab's own space (its grid
 *    cell, or the tab shown one at a time), starting exactly under that tab's
 *    caption and running to the tile's bottom — never one shared pane at the
 *    tile's edge. Two open cells show two panes, one in each.
 *  - The terminal is SIZED to what is left (tile − tab bar − caption − pane),
 *    never taller than the tile: a terminal box that overflows its tile has its
 *    bottom rows (a TUI's status line) cut off, and a focused terminal scrolls
 *    the tile up until its tab bar slides under the workspace pills.
 *
 * Runs against the frontend mock backend (`?agents=team` world):
 * `npm run test:e2e:mock` starts its own mock vite (see
 * playwright.mock.config.ts; `PORT=<p>` picks the port).
 */

const BUG = "BUG-142";
const AGENT_TAB = "sess-login-lead";
const OTHER_TAB = "sess-login-repro";
const MANAGER_TAB = "sess-manager";
const SHELL_TAB = "demo-shell";
const CONTENT_WS = "generic:/mock/users/4242/orgs/acme/widgets/default/content";

async function boot(page: Page) {
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.goto("/?agents=team");
  await page.getByRole("button", { name: "Full screen" }).click();
  await expect(page.getByTestId(`terminal-grid-caption-inbox-${AGENT_TAB}`)).toBeVisible();
}

async function expand(page: Page, wsId: string) {
  await page.getByTestId(`tile-zoom-${wsId}`).click();
  await expect(page.getByTestId(`tile-zoom-${wsId}`)).toHaveAttribute("aria-label", /^Back to/);
}

async function showAllTabs(page: Page, wsId: string) {
  await page.getByTestId(`tile-grid-toggle-${wsId}`).click();
  await expect(page.getByTestId(`tile-grid-toggle-${wsId}`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

async function openInbox(page: Page, tabId: string) {
  await page.getByTestId(`terminal-grid-caption-inbox-${tabId}`).click();
  const pane = page.locator(paneOf(tabId));
  await expect(pane).toBeInViewport();
  return pane;
}

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  return b;
}

const byTestId = (id: string) => `[data-testid="${id}"]`;
/** A tab's body under its caption: its terminal and, when open, its docked inbox. */
const regionOf = (tabId: string) => byTestId(`inbox-split-${tabId}`);
/** The agent's chat in that tab's own body. */
const paneOf = (tabId: string) => `${regionOf(tabId)} [data-testid="chat-overlay"]`;

async function paneGeometry(page: Page, tabId: string, wsId: string) {
  return {
    caption: await box(page, byTestId(`terminal-grid-caption-${tabId}`)),
    pane: await box(page, paneOf(tabId)),
    region: await box(page, regionOf(tabId)),
    tile: await box(page, byTestId(`workspace-panels-${wsId}`)),
  };
}

function expectPaneInItsTab(g: Awaited<ReturnType<typeof paneGeometry>>) {
  // Under its own caption, to the tile's bottom.
  expect(Math.abs(g.pane.y - (g.caption.y + g.caption.height))).toBeLessThanOrEqual(1);
  expect(Math.abs(g.pane.y + g.pane.height - (g.tile.y + g.tile.height))).toBeLessThanOrEqual(1);
  // Inside its own tab's region (so inside its cell), flush right.
  expect(g.pane.x).toBeGreaterThanOrEqual(g.region.x - 1);
  expect(Math.abs(g.pane.x + g.pane.width - (g.region.x + g.region.width))).toBeLessThanOrEqual(1);
}

/** The shown terminal's slot and xterm screen fit inside the tile, and the
 *  tile's tab bar is on screen below the window's top chrome. */
async function expectTerminalFitsTile(page: Page, tabId: string, wsId: string) {
  const geo = await page.evaluate(
    ({ tabId, wsId }) => {
      const rect = (el: Element | null) => el?.getBoundingClientRect() ?? null;
      const region = document.querySelector(`[data-testid="inbox-split-${tabId}"]`);
      const slot = region?.querySelector(".cs-terminal-display") ?? null;
      const frames = [...document.querySelectorAll(`[data-pane-id="${wsId}"]`)].filter(
        (f) => f.getBoundingClientRect().height > 0,
      );
      const scrolled: number[] = [];
      for (let n = frames[0] ?? null; n; n = n.parentElement) {
        if (n.scrollTop !== 0) scrolled.push(n.scrollTop);
      }
      return {
        tile: rect(document.querySelector(`[data-testid="workspace-panels-${wsId}"]`)),
        region: rect(region),
        slot: rect(slot),
        tabBar: rect(frames[0]?.querySelector('[role="tablist"]') ?? null),
        scrolled,
      };
    },
    { tabId, wsId },
  );
  expect(geo.tile && geo.region).toBeTruthy();
  expect(geo.region!.bottom).toBeLessThanOrEqual(geo.tile!.bottom + 1);
  if (geo.slot) expect(geo.slot.bottom).toBeLessThanOrEqual(geo.tile!.bottom + 1);
  if (geo.tabBar) expect(geo.tabBar.top).toBeGreaterThanOrEqual(0);
  expect(geo.scrolled).toEqual([]);
}

test.describe("a tab's agent inbox pane lives in that tab", () => {
  test.beforeEach(async ({ page }) => boot(page));

  test("one tab at a time · agent tab", async ({ page }) => {
    await expand(page, BUG);
    await openInbox(page, AGENT_TAB);
    expectPaneInItsTab(await paneGeometry(page, AGENT_TAB, BUG));
    await expectTerminalFitsTile(page, AGENT_TAB, BUG);
  });

  test("one tab at a time · agent in the team's content workspace", async ({ page }) => {
    await expand(page, CONTENT_WS);
    await showAllTabs(page, CONTENT_WS);
    await openInbox(page, MANAGER_TAB);
    expectPaneInItsTab(await paneGeometry(page, MANAGER_TAB, CONTENT_WS));
    await expectTerminalFitsTile(page, MANAGER_TAB, CONTENT_WS);
  });

  test("a plain shell has no inbox: only a tab with a live agent offers one", async ({ page }) => {
    await expand(page, CONTENT_WS);
    await showAllTabs(page, CONTENT_WS);
    await expect(page.getByTestId(`terminal-grid-caption-inbox-${MANAGER_TAB}`)).toBeVisible();
    await expect(page.getByTestId(`terminal-grid-caption-inbox-${SHELL_TAB}`)).toHaveCount(0);
  });

  test("tab grid · two cells open → two panes, each in its own cell", async ({ page }) => {
    await expand(page, BUG);
    await showAllTabs(page, BUG);
    await openInbox(page, AGENT_TAB);
    await openInbox(page, OTHER_TAB);
    await expect(page.getByTestId("chat-overlay")).toHaveCount(2);
    for (const tab of [AGENT_TAB, OTHER_TAB]) {
      const cell = page.getByTestId(`terminal-grid-cell-${tab}`);
      await expect(cell.getByTestId("chat-overlay")).toHaveCount(1);
      expectPaneInItsTab(await paneGeometry(page, tab, BUG));
    }
  });

  test("a wide tab docks the chat at 420 px and the terminal reflows beside it", async ({
    page,
  }) => {
    await expand(page, BUG);
    const before = await box(page, `${regionOf(AGENT_TAB)} .ibx-split-term`);
    await openInbox(page, AGENT_TAB);
    const chat = page.locator(paneOf(AGENT_TAB));
    await expect(chat).toHaveAttribute("data-placement", "dock");
    const g = await paneGeometry(page, AGENT_TAB, BUG);
    expect(g.region.width).toBeGreaterThanOrEqual(840);
    expect(Math.round(g.pane.width)).toBe(420);
    const term = await box(page, `${regionOf(AGENT_TAB)} .ibx-split-term`);
    // Beside the chat, not under it: the terminal gave up exactly the chat's width.
    expect(Math.abs(term.x + term.width - g.pane.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(before.width - term.width - 420)).toBeLessThanOrEqual(1);
    await expect(page.locator(`${regionOf(AGENT_TAB)} .ibx-split-term`)).not.toHaveAttribute(
      "inert",
      /.*/,
    );
  });

  test("narrow tile: the docked pane stays inside its tab, still under the caption", async ({
    page,
  }) => {
    await openInbox(page, AGENT_TAB);
    expectPaneInItsTab(await paneGeometry(page, AGENT_TAB, BUG));
    await expectTerminalFitsTile(page, AGENT_TAB, BUG);
  });
});

test.describe("the shown terminal is sized to its tile", () => {
  test.beforeEach(async ({ page }) => boot(page));

  test("one tab at a time: caption + terminal fit the tile, nothing scrolled", async ({ page }) => {
    await expand(page, BUG);
    await expectTerminalFitsTile(page, AGENT_TAB, BUG);
    // Focusing the terminal (a newly opened tab's autofocus) scrolls nothing.
    await page.locator(`${regionOf(AGENT_TAB)} .xterm textarea`).focus();
    await expectTerminalFitsTile(page, AGENT_TAB, BUG);
  });
});

/** The design's acceptance sizes, with the layout each must get (its breakpoint table). */
const SIZES = [
  { w: 250, h: 250, width: "XS", height: "short", head: "one-line", pins: "line" },
  { w: 300, h: 700, width: "XS", height: "tall", head: "two-line", pins: "rows" },
  { w: 900, h: 250, width: "L", height: "short", head: "one-line", pins: "rail" },
  { w: 640, h: 480, width: "M", height: "medium", head: "two-line", pins: "tiles" },
] as const;

test.describe("the agent's chat at any pane size", () => {
  test.beforeEach(async ({ page }) => boot(page));

  for (const size of SIZES) {
    test(`${size.w} × ${size.h}: chat, composer and pins usable, nothing scrolls sideways`, async ({
      page,
    }) => {
      await expand(page, BUG);
      await openInbox(page, AGENT_TAB);
      // Give the tab's body exactly this size; the chat covers it (every size here is under
      // 840 wide or 360 tall).
      await page.evaluate(
        ({ tabId, w, h }) => {
          const el = document.querySelector<HTMLElement>(`[data-testid="inbox-split-${tabId}"]`)!;
          Object.assign(el.style, { flex: "none", width: `${w}px`, height: `${h}px` });
        },
        { tabId: AGENT_TAB, w: size.w, h: size.h },
      );
      const chat = page.locator(paneOf(AGENT_TAB));
      await expect(chat).toHaveAttribute("data-placement", "cover");
      for (const k of ["width", "height", "head", "pins"] as const)
        await expect(chat).toHaveAttribute(`data-${k}`, size[k]);
      const b = await box(page, paneOf(AGENT_TAB));
      expect(Math.round(b.width)).toBe(size.w);
      expect(Math.round(b.height)).toBe(size.h);

      // Pins: both of the lead's, as previews, inside the chat.
      const pins = chat.locator('[data-testid^="chat-overlay-pin-"]');
      await expect(pins).toHaveCount(2);
      await expect(pins.first()).toContainText("0H 0M 0L");
      await expect(chat.getByTestId("chat-overlay-pin-9")).toContainText("stopped");

      // The newest message and the composer are on screen, inside the chat.
      await expect(chat.getByText(/staging verification is waiting/)).toBeInViewport();
      const composer = chat.locator(".ibx-comp textarea");
      await expect(composer).toBeEnabled();
      await expect(composer).toBeInViewport();
      const c = await composer.boundingBox();
      expect(c).not.toBeNull();
      expect(c!.y + c!.height).toBeLessThanOrEqual(b.y + b.height + 1);
      expect(c!.x + c!.width).toBeLessThanOrEqual(b.x + b.width + 1);

      // Nothing in the chat scrolls sideways; a wide table or code block inside a message
      // scrolls in its own box, as everywhere in the inbox.
      const wide = await chat.evaluate((root) =>
        [root, ...root.querySelectorAll<HTMLElement>("*")]
          .filter((el) => !el.parentElement?.closest(".ibx-m"))
          .filter((el) => {
            const o = getComputedStyle(el).overflowX;
            return (o === "auto" || o === "scroll") && el.scrollWidth > el.clientWidth + 1;
          })
          .map((el) => el.className),
      );
      expect(wide).toEqual([]);
      expect(await chat.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    });
  }
});

test.describe("every agent's chat entry, and none for a headless run", () => {
  test("a headless run in the agent list has no chat icon; a running agent does", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?agents=teams&headless=1");
    const headless = page.locator('.ag-row[data-agent-handle="BUG-142#nightly"]').first();
    await expect(headless).toBeVisible();
    await headless.hover();
    await expect(headless.getByTestId("agent-row-message")).toHaveCount(0);

    const lead = page.locator('.ag-row[data-agent-handle="BUG-142#lead"]').first();
    await lead.hover();
    await expect(lead.getByTestId("agent-row-message")).toBeVisible();
  });
});

test.describe("the chat is ready when it opens", () => {
  test.beforeEach(async ({ page }) => boot(page));

  // The newest message in view and an enabled composer, timed from the click in the page's
  // own clock. The first open of a booted app is the cold read; the reopen is the warm one.
  const COLD_MS = 3000;
  const WARM_MS = 1500;

  async function openToReady(page: Page, tabId: string) {
    const msg = await page.evaluate(
      (id) =>
        new Promise<number>((resolve, reject) => {
          const caption = document.querySelector<HTMLElement>(
            `[data-testid="terminal-grid-caption-inbox-${id}"]`,
          );
          if (!caption) return reject(new Error("no chat button"));
          performance.mark("chat-open:click");
          caption.click();
          const ready = () => {
            const chat = document.querySelector(
              `[data-testid="inbox-split-${id}"] [data-testid="chat-overlay"]`,
            );
            const composer = chat?.querySelector<HTMLTextAreaElement>(".ibx-comp textarea");
            const list = chat?.querySelector<HTMLElement>('[data-testid="ibx-msgs"]');
            const newest = [...(list?.querySelectorAll<HTMLElement>(".ibx-m") ?? [])]
              .reverse()
              .find((el) => el.textContent?.includes("staging verification is waiting"));
            // In view: inside the list's own box, not scrolled out of it.
            const inView =
              !!list &&
              !!newest &&
              newest.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom + 1 &&
              newest.getBoundingClientRect().top >= list.getBoundingClientRect().top - 1;
            return !!composer && !composer.disabled && inView;
          };
          const done = () => {
            performance.mark("chat-open:ready");
            resolve(
              performance.measure("chat-open", "chat-open:click", "chat-open:ready").duration,
            );
          };
          if (ready()) return done();
          const obs = new MutationObserver(() => {
            if (!ready()) return;
            obs.disconnect();
            done();
          });
          obs.observe(document.body, { subtree: true, childList: true, attributes: true });
        }),
      tabId,
    );
    return msg;
  }

  test("newest message and composer within 3 s cold and 1.5 s warm", async ({ page }) => {
    await expand(page, BUG);
    const cold = await openToReady(page, AGENT_TAB);
    expect(cold).toBeLessThan(COLD_MS);

    // Close it and open it again: the thread is already read, so this is the warm open.
    await page.getByTestId(`terminal-grid-caption-inbox-${AGENT_TAB}`).click();
    await expect(page.locator(paneOf(AGENT_TAB))).toHaveCount(0);
    const warm = await openToReady(page, AGENT_TAB);
    expect(warm).toBeLessThan(WARM_MS);
  });
});
