// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// kit.chat.gifPicker and gifStage in a bare page, in Chromium and WebKit: the kit as /kit/v1 serves it, a fake `act` in place
// of the bridge, and the pane's image policy (`img-src 'self' data:`), so the stills are the only images that can draw.

const KIT = join(process.cwd(), "src-tauri/src/http/routes/dashboard_kit");
const FILES: Record<string, [string, string]> = {
  "/kit/v1/tokens.css": ["text/css", readFileSync(join(KIT, "tokens.css"), "utf8")],
  "/kit/v1/kit.css": ["text/css", readFileSync(join(KIT, "kit.css"), "utf8")],
  "/kit/v1/kit.js": ["text/javascript", readFileSync(join(KIT, "kit.js"), "utf8")],
  "/kit/v1/chat.js": ["text/javascript", readFileSync(join(KIT, "chat.js"), "utf8")],
  "/kit/v1/chat.css": ["text/css", readFileSync(join(KIT, "chat.css"), "utf8")],
};
const STILL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// The page: a composer-like box at the bottom, the picker mounted on it, every act call recorded.
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:">
<link rel="stylesheet" href="/kit/v1/tokens.css"><link rel="stylesheet" href="/kit/v1/kit.css">
<script>window.codesense = { has: () => true, invoke: () => Promise.reject(new Error("no bridge")) };</script>
<script src="/kit/v1/kit.js"></script><script src="/kit/v1/chat.js"></script>
<style>body{margin:0;height:600px;display:flex;flex-direction:column;justify-content:flex-end;font-family:sans-serif}
#comp{position:relative;padding:8px 12px 12px;box-shadow:0 -1px 0 #ccc;--cs-gif-inset:12px}#box{border:1px solid #999;padding:8px}</style>
</head><body><form id="comp"><div id="box"><textarea id="draft"></textarea></div><button type="button" id="gif">GIF</button></form>
<script>
const params = new URLSearchParams(location.search);
const consent = params.get("consent") === "1" ? { consent: { giphy: true } } : {};
window.calls = [];
window.staged = [];
const candidates = Array.from({ length: 10 }, (_, i) => ({ provider: "giphy", id: "g" + i, title: "GIF " + i, url: "https://media.giphy.com/media/g" + i + "/giphy.gif", previewUrl: "", width: 480, height: 270, autoLoads: false, previewData: ${JSON.stringify(STILL)} }));
let ui = consent;
async function act(verb, args) {
  window.calls.push([verb, args]);
  if (verb === "gifProvider") return { status: "ok", provider: "giphy" };
  if (verb === "gifSearch") return { status: "ok", provider: "giphy", candidates };
  if (verb === "gifPicked") return { status: "ok" };
  if (verb === "setUiState") { ui = { ...ui, ...args.patch }; return null; }
}
const chat = window.codesense.kit.chat;
window.picker = chat.gifPicker(document.getElementById("comp"), {
  act, uiState: async () => ui, anchor: document.getElementById("gif"),
  onStage: (pick) => { window.staged.push(pick); window.stage = chat.gifStage(document.getElementById("box"), { pick }); },
});
document.getElementById("gif").onclick = () => window.picker.toggle();
</script></body></html>`;

// Any script error in the page fails the test (a pick once threw from the dropped grid's blur).
let errors: string[] = [];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(() => expect(errors).toEqual([]));

async function open(page: Page, consent = true): Promise<Page> {
  await page.route("http://kit.test/**", (route) => {
    const url = new URL(route.request().url());
    const file = FILES[url.pathname];
    if (file) return route.fulfill({ contentType: file[0], body: file[1] });
    return route.fulfill({ contentType: "text/html", body: PAGE });
  });
  await page.goto(`http://kit.test/page?consent=${consent ? 1 : 0}`);
  await page.locator("#gif").click();
  await expect(page.locator(".cs-gif.gp")).toBeVisible();
  return page;
}
const calls = (page: Page, verb: string) =>
  page.evaluate(
    (v) => (window as unknown as { calls: [string, unknown][] }).calls.filter(([c]) => c === v),
    verb,
  );

test("opens above the composer at its full width, 292 px tall, with focus in the field and the start screen", async ({
  page,
}) => {
  await open(page);
  const pop = await page.locator(".cs-gif.gp").boundingBox();
  const comp = await page.locator("#comp").boundingBox();
  expect(pop!.height).toBe(292);
  expect(pop!.x).toBeCloseTo(comp!.x + 12, 0);
  expect(pop!.width).toBeCloseTo(comp!.width - 24, 0);
  expect(pop!.y + pop!.height).toBeCloseTo(comp!.y - 4, 0);
  await expect(page.locator(".gp-input")).toBeFocused();
  await expect(page.locator(".gp-input")).toHaveAttribute("placeholder", "Search GIPHY");
  await expect(page.locator(".gp-attr")).toHaveText("Powered By GIPHY");
  await expect(page.locator(".gp-chip")).toHaveText(["thumbs up", "thank you", "ship it", "on it"]);
  expect(await calls(page, "gifSearch")).toEqual([]);
  // The stylesheet is linked once, however many mounts.
  await page.evaluate(() => {
    const chat = (
      window as unknown as {
        codesense: { kit: { chat: { gifPicker: (...a: unknown[]) => unknown } } };
      }
    ).codesense.kit.chat;
    chat.gifPicker(document.body, { act: async () => ({}) });
  });
  await expect(page.locator("link[data-codesense-chat]")).toHaveCount(1);
});

test("consent first: no search before Allow, then one search per pause", async ({ page }) => {
  await open(page, false);
  await expect(page.getByRole("button", { name: "Allow search" })).toBeFocused();
  await expect(page.locator(".gp-input")).toBeDisabled();
  await page.getByRole("button", { name: "Allow search" }).click();
  await expect(page.locator(".gp-input")).toBeFocused();
  await page.locator(".gp-input").pressSequentially("ship it", { delay: 50 });
  await expect(page.locator(".gp-grid [role=option]")).toHaveCount(10);
  expect(await calls(page, "gifSearch")).toEqual([
    ["gifSearch", { query: "ship it", limit: 10, provider: "giphy" }],
  ]);
  expect(await calls(page, "setUiState")).toEqual([
    ["setUiState", { topic: "ui:gif", patch: { consent: { giphy: true } } }],
  ]);
});

test("ten cover-cropped stills in three columns draw under the data:-only image policy", async ({
  page,
}) => {
  await open(page);
  await page.locator(".gp-input").fill("cat");
  const cells = page.locator(".gp-grid [role=option]");
  await expect(cells).toHaveCount(10);
  const tops = await cells.evaluateAll((all) =>
    all.map((cell) => Math.round(cell.getBoundingClientRect().top)),
  );
  expect(tops.slice(0, 3).every((top) => top === tops[0])).toBe(true);
  expect(tops[3]).toBeGreaterThan(tops[0]);
  const img = cells.first().locator("img");
  await expect(img).toHaveCSS("object-fit", "cover");
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
});

test("the grid is one Tab stop; the arrows move a 2 px ring; Enter stages the GIF and focuses its alt text", async ({
  page,
}) => {
  await open(page);
  await page.locator(".gp-input").fill("cat");
  await expect(page.locator(".gp-grid [role=option]")).toHaveCount(10);
  // Tab from the field: past the clear and close buttons where the engine stops on buttons (Chromium), onto the grid, and on out.
  const grid = page.locator(".gp-grid");
  for (let i = 0; i < 3 && !(await grid.evaluate((g) => g === document.activeElement)); i++)
    await page.keyboard.press("Tab");
  await expect(grid).toBeFocused();
  await expect(page.locator(".gp-grid [tabindex='0']")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  const active = page.locator(".gp-grid [aria-selected=true]");
  await expect(active).toHaveCount(1);
  await expect(active).toHaveAttribute("aria-label", "GIF 4");
  const ring = await active.evaluate((cell) => getComputedStyle(cell, "::after").boxShadow);
  expect(ring).toMatch(/2px/);
  await page.keyboard.press("Enter");
  await expect(page.locator(".cs-gif.gp")).toBeHidden();
  expect(await calls(page, "gifPicked")).toEqual([["gifPicked", { provider: "giphy", id: "g4" }]]);
  const alt = page.locator(".gs-in");
  await expect(alt).toHaveValue("GIF 4");
  await page.evaluate(() =>
    (window as unknown as { stage: { focusAlt(): void } }).stage.focusAlt(),
  );
  await expect(alt).toBeFocused();
  const thumb = await page.locator(".gs-thumb").boundingBox();
  expect(Math.round(thumb!.width)).toBe(112);
});

test("Esc and a click outside close it; a click on its own button toggles", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Escape");
  await expect(page.locator(".cs-gif.gp")).toBeHidden();
  await expect(page.locator("#gif")).toHaveAttribute("aria-expanded", "false");
  await page.locator("#gif").click();
  await expect(page.locator(".cs-gif.gp")).toBeVisible();
  await page.locator("#gif").click();
  await expect(page.locator(".cs-gif.gp")).toBeHidden();
  await page.locator("#gif").click();
  await page.mouse.click(5, 5);
  await expect(page.locator(".cs-gif.gp")).toBeHidden();
});

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`Reduce Motion ${reducedMotion}: nothing in the picker or the stage animates, and the stage shows the still`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await open(page);
    await page.locator(".gp-input").fill("cat");
    await expect(page.locator(".gp-grid [role=option]")).toHaveCount(10);
    await page.locator(".gp-grid [role=option]").first().click();
    const moving = await page.evaluate(
      () =>
        [...document.querySelectorAll(".cs-gif, .cs-gif *")].filter((node) => {
          const style = getComputedStyle(node);
          return style.animationName !== "none" || parseFloat(style.transitionDuration) > 0;
        }).length,
    );
    expect(moving).toBe(0);
    await expect(page.locator(".gs-thumb img")).toHaveAttribute("src", STILL);
    await expect(page.locator(".gs button")).toHaveCount(1);
  });
}
