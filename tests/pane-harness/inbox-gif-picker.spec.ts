// SPDX-License-Identifier: MIT
import { inboxFixtureRow } from "../../src/app/mock/inbox-fixtures";
import { expect, test } from "./harness";
import { builder, INBOX_PANE } from "./inbox-message-view-fixtures";

// The Inbox pane's GIF button, picker and staged GIF, in the real pane under the frame's own image policy.
const team = { org: "fixture", team: "dev" };
const fixtures = (ui: Record<string, unknown> = { consent: { giphy: true } }) => ({
  width: 420,
  height: 800,
  sessions: [builder],
  topics: { "ui:gif": [{ id: "ui:gif", ...ui }] },
  inbox: [
    inboxFixtureRow(
      1,
      "Ready for review",
      { from: "builder", fromName: "Builder", contentType: "markdown", unread: false },
      team,
    ),
  ],
});
// Any script error in the pane fails the test (a pick once threw from the dropped grid's blur).
let errors: string[] = [];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(() => expect(errors).toEqual([]));
const shot = (name: string) => `/tmp/gif-picker-${name}-${test.info().project.name}.png`;

test("the GIF button opens the picker over the composer; a pick stages the still and sends it as media", async ({
  mountPane,
}) => {
  const pane = await mountPane(INBOX_PANE, fixtures());
  const external: string[] = [];
  pane.page.on("request", (request) => {
    if (/giphy\.com/.test(request.url())) external.push(request.url());
  });
  const frame = pane.frame;
  await frame.locator(".ib-row").first().click();
  const button = frame.getByRole("button", { name: "Add a GIF" });
  await expect(button).toBeVisible();
  await button.click();
  const picker = frame.getByRole("dialog", { name: "GIF search" });
  await expect(picker).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(frame.locator(".gp-input")).toBeFocused();
  const pop = await picker.boundingBox();
  const comp = await frame.locator("#composer").boundingBox();
  expect(pop!.height).toBe(292);
  expect(pop!.y + pop!.height).toBeLessThanOrEqual(comp!.y);
  await picker.screenshot({ path: shot("start") });
  await frame.locator(".gp-input").fill("ship it");
  const cells = frame.locator(".gp-grid [role=option]");
  await expect(cells).toHaveCount(4);
  await expect
    .poll(() =>
      cells
        .first()
        .locator("img")
        .evaluate((i: HTMLImageElement) => i.naturalWidth),
    )
    .toBeGreaterThan(0);
  await picker.screenshot({ path: shot("results") });
  await cells.first().click();
  await expect(picker).toBeHidden();
  const alt = frame.locator(".gs-in");
  await expect(alt).toHaveValue("Ship It Dog");
  await expect(alt).toBeFocused();
  // Enter in the alt field goes to the message and never sends, and the hint row says so while it has focus.
  const hint = frame.locator("#composer-hint");
  await expect(hint).toHaveText("Enter to go to your message");
  await frame.locator("#draft").focus();
  await expect(hint).toHaveText("Enter to send · Shift+Enter for a new line");
  await alt.focus();
  await expect(hint).toHaveText("Enter to go to your message");
  await expect(frame.locator(".gs-thumb img")).toHaveAttribute("src", /^data:image\/gif/);
  await expect(frame.locator(".gs button")).toHaveCount(1);
  await expect(frame.locator("#send")).toBeEnabled();
  await frame.locator(".ib-comp").screenshot({ path: shot("staged-light") });
  await pane.setTheme({ id: "codesense", scheme: "dark" });
  await frame.locator(".ib-comp").screenshot({ path: shot("staged-dark") });
  await alt.fill("");
  await expect(frame.locator("#send")).toBeDisabled();
  await alt.fill("A dog ships it");
  await frame.locator("#send").click();
  await expect(frame.locator(".gs")).toHaveCount(0);
  const sends = (await pane.verbs()).filter(({ verb }) => /AsHuman$/.test(verb));
  expect(sends).toHaveLength(1);
  expect(sends[0].args).toMatchObject({
    media: {
      url: "https://media.giphy.com/media/fixturegif1/giphy.gif",
      alt: "A dog ships it",
      provider: "giphy",
      providerId: "fixturegif1",
    },
  });
  expect(external).toEqual([]);
});

test("without consent the picker asks first and searches nothing until Allow", async ({
  mountPane,
}) => {
  const pane = await mountPane(INBOX_PANE, fixtures({}));
  const frame = pane.frame;
  await frame.locator(".ib-row").first().click();
  await frame.getByRole("button", { name: "Add a GIF" }).click();
  const allow = frame.getByRole("button", { name: "Allow search" });
  await expect(allow).toBeFocused();
  await frame.getByRole("dialog", { name: "GIF search" }).screenshot({ path: shot("consent") });
  expect((await pane.verbs()).filter(({ verb }) => verb === "gifSearch")).toEqual([]);
  await allow.click();
  await expect(frame.locator(".gp-input")).toBeFocused();
  expect((await pane.verbs()).filter(({ verb }) => verb === "setUiState")).toEqual([
    { verb: "setUiState", args: { topic: "ui:gif", patch: { consent: { giphy: true } } } },
  ]);
});

test("Esc closes the picker and gives the draft its focus back", async ({ mountPane }) => {
  const pane = await mountPane(INBOX_PANE, fixtures());
  const frame = pane.frame;
  await frame.locator(".ib-row").first().click();
  await frame.getByRole("button", { name: "Add a GIF" }).click();
  await expect(frame.locator(".gp-input")).toBeFocused();
  await pane.page.keyboard.press("Escape");
  await expect(frame.getByRole("dialog", { name: "GIF search" })).toBeHidden();
  await expect(frame.locator("#draft")).toBeFocused();
});

test("a rate-limited search names the wait and holds the field, with no retry", async ({
  mountPane,
}) => {
  const pane = await mountPane(INBOX_PANE, fixtures());
  await pane.page.evaluate(() => {
    (window as unknown as { gifSearchResult: unknown }).gifSearchResult = {
      status: "error",
      error: "rateLimited",
      message: "GIPHY search is paused. Try again in 90 seconds.",
      retryAfter: 90,
    };
  });
  const frame = pane.frame;
  await frame.locator(".ib-row").first().click();
  await frame.getByRole("button", { name: "Add a GIF" }).click();
  await frame.locator(".gp-input").fill("cat");
  const picker = frame.getByRole("dialog", { name: "GIF search" });
  await expect(picker).toContainText("GIF search limit reached");
  await expect(picker.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(frame.locator(".gp-input")).toBeDisabled();
});
