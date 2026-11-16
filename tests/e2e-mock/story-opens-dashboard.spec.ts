// SPDX-License-Identifier: MIT
import { expect, test, type Page } from "@playwright/test";

/**
 * A story file (an `.md` whose front matter says `type: story`) opens its team's story page in the
 * tab of that file, from the ways of opening a file the left nav offers, in a real browser
 * (`?nav=demo`, whose team sets `story_page`). Opening it again focuses that tab; a plain
 * markdown file stays markdown.
 */
async function openDemo(page: Page) {
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.goto("/?nav=demo");
  await page.getByRole("button", { name: /^26-agent-inbox/ }).click();
}

const storyPage = (page: Page) => page.locator('iframe[title="story.html"]');
const tabs = (page: Page, id: string) =>
  page.getByRole("button", { name: `${id} Close tab`, exact: true });

test("a pipeline card opens the story page, and opening it again keeps one tab", async ({
  page,
}) => {
  await openDemo(page);
  const card = page.getByRole("button", { name: /^AID-4Dashboards from the inbox/ });
  await card.click();
  await expect(page.getByRole("heading", { name: "Dashboards from the inbox" })).toHaveCount(0);
  await expect(storyPage(page).first()).toBeVisible();
  await expect(page.getByTestId("story-no-page")).toHaveCount(0);
  await expect(tabs(page, "AID-4")).toHaveCount(1);
  await card.dblclick();
  await expect(tabs(page, "AID-4")).toHaveCount(1);
  await expect(storyPage(page).first()).toBeVisible();
});

test("a story file with no workspace opens its page without opening one", async ({ page }) => {
  await openDemo(page);
  await expect(page.getByText("No workspace open")).toBeVisible();
  await page.getByRole("button", { name: /^AID-3Rail list and filters/ }).click();
  await expect(storyPage(page).first()).toBeVisible();
  await expect(page.getByText("No workspace open")).toBeVisible();
});

test("a link to a story in a viewer opens the story page", async ({ page }) => {
  await openDemo(page);
  await page
    .getByRole("button", { name: /^README\.md$/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "26-agent-inbox", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "the first story" }).click();
  await expect(storyPage(page).first()).toBeVisible();
  await expect(tabs(page, "AID-1")).toHaveCount(1);
});

test("a plain markdown file stays markdown", async ({ page }) => {
  await openDemo(page);
  await page
    .getByRole("button", { name: /^README\.md$/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "26-agent-inbox", level: 1 })).toBeVisible();
  await expect(storyPage(page)).toHaveCount(0);
  await expect(page.getByTestId("story-no-page")).toHaveCount(0);
});

/**
 * A stand-in for the Files tree pane: the mock serves no built-in panes, so this pane lists the
 * same rows and opens one the way the Files tree does, with `codesense.openFile` (the page bridge's
 * opener, which ends in `openFileInTeam`).
 */
const FILES = ["26-agent-inbox/AID-4.md", "26-agent-inbox/AID-6.html", "26-agent-inbox/AID-7.html"];
async function openFilesPane(page: Page) {
  await page.request.put(`/__mock-panes/getting-started/story-files`, {
    data: `<!doctype html><title>Story files</title><output></output>${FILES.map(
      (path) => `<button data-path="${path}">${path}</button>`,
    ).join("")}<script>
      codesense.ready();
      for (const row of document.querySelectorAll("button"))
        row.onclick = () =>
          codesense.openFile({ path: row.dataset.path }).catch((error) => {
            document.querySelector("output").textContent = String(error);
          });
    </script>`,
  });
  await openDemo(page);
  await page.evaluate(() =>
    (
      window as unknown as { __codesenseMockPanes: { open: (id: string) => void } }
    ).__codesenseMockPanes.open("pane:codesense/docs:getting-started/story-files"),
  );
  const pane = page.frameLocator('iframe[title="Story files"]');
  await expect(pane.getByRole("button", { name: FILES[0] })).toBeVisible();
  return pane;
}

test("a story file opened from the Files tree opens the story page", async ({ page }) => {
  const pane = await openFilesPane(page);
  await pane.getByRole("button", { name: "26-agent-inbox/AID-4.md" }).click();
  await expect(storyPage(page).first()).toBeVisible();
  await expect(tabs(page, "AID-4")).toHaveCount(1);
  await expect(pane.locator("output")).toHaveText("");
});

test("a pair shell and a single .html story open as themselves, not the story page", async ({
  page,
}) => {
  const pane = await openFilesPane(page);
  for (const id of ["AID-6", "AID-7"]) {
    await pane.getByRole("button", { name: `26-agent-inbox/${id}.html` }).click();
    await expect(page.locator(`iframe[title="${id}.html"]`).first()).toBeVisible();
    await expect(page.getByTestId("story-no-page")).toHaveCount(0);
  }
  await expect(storyPage(page)).toHaveCount(0);
  await expect(pane.locator("output")).toHaveText("");
});

/**
 * The inbox's open-file chip, in an agent's chat (the agent works in the user's own team, which has
 * no story page). The mock backend has no session inbox, so `list_session_inbox` answers here with
 * two messages naming the story file: one by its path in the agent's team, one by its full path in
 * the docs team's content (whose story page the demo serves).
 */
async function openAgentChat(page: Page) {
  await page.addInitScript(() => {
    type Internals = { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> };
    let inner: Internals | undefined;
    const DOCS = "/mock/.codesense/users/4242/codesense-docs/getting-started/content";
    const message = (id: number, path: string) => ({
      id,
      team: { org: "acme/widgets", team: "default" },
      from: "nav-aid4-a",
      fromName: "claude",
      to: "human",
      toName: "You",
      toRole: null,
      text: `See the story (message ${id}).`,
      contentType: "markdown",
      createdAtMs: Date.now() - (3 - id) * 60_000,
      inReplyTo: null,
      via: null,
      replyTo: null,
      summary: null,
      unread: false,
      delivery: null,
      onClick: { type: "open-file", path },
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => inner,
      set: (v: Internals) => {
        const orig = v.invoke.bind(v);
        v.invoke = (cmd, args) =>
          cmd === "list_session_inbox" || cmd === "list_thread_inbox"
            ? Promise.resolve({
                handle: String(args?.handle ?? args?.session ?? "x"),
                roles: [],
                messages: [
                  message(1, `${DOCS}/26-agent-inbox/AID-4.md`),
                  message(2, "26-agent-inbox/AID-4.md"),
                ],
              })
            : orig(cmd, args);
        inner = v;
      },
    });
  });
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.goto("/?nav=demo");
  await page.getByRole("button", { name: "CodeSense Docs / getting-started" }).click();
  await page.getByText("Acme Widgets", { exact: true }).click();
  await page.getByText("AID-4", { exact: true }).last().click();
  await page.getByTestId("terminal-grid-caption-inbox-nav-aid4-a").click();
  const chat = page.locator('[data-testid="chat-overlay"]').first();
  await expect(chat).toBeVisible();
  return chat;
}

const activeTeam = (page: Page) =>
  page.evaluate(() => {
    const org = (
      window as unknown as {
        __stores: {
          useOrgStore: { getState: () => { activeOrgSlug: string; activeTeamName: string } };
        };
      }
    ).__stores.useOrgStore.getState();
    return `${org.activeOrgSlug}:${org.activeTeamName}`;
  });

test("an inbox chip naming a file in another team switches to it and opens its story page", async ({
  page,
}) => {
  const chat = await openAgentChat(page);
  expect(await activeTeam(page)).toBe("acme/widgets:default");
  const bubble = chat.locator("[data-mid]").filter({ hasText: "(message 1)" });
  await bubble.first().locator(".ibx-files .ibx-chip").click();
  await expect.poll(() => activeTeam(page)).toBe("codesense/docs:getting-started");
  await expect(storyPage(page).first()).toBeVisible();
  await expect(page.getByTestId("story-no-page")).toHaveCount(0);
});

test("an inbox chip in a team with no story page opens the file as markdown, and says why", async ({
  page,
}) => {
  const chat = await openAgentChat(page);
  const bubble = chat.locator("[data-mid]").filter({ hasText: "(message 2)" });
  await bubble.first().locator(".ibx-files .ibx-chip").click();
  await expect(page.getByTestId("story-no-page").first()).toBeVisible();
  expect(await activeTeam(page)).toBe("acme/widgets:default");
  await expect(storyPage(page)).toHaveCount(0);
});
