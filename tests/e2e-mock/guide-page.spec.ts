// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// The CodeSense setup page in a real browser: the shipped page and the kit's own files, over a fake
// `window.codesense` bridge that records every verb the page calls. No app and no Rust: the cases are
// the page's own (chips, cards, Stop, the empty state, the sign-in notice, the summary).

const KIT = "src-tauri/src/http/routes/dashboard_kit";
const PAGE = readFileSync("codesense-docs/getting-started/content/guide/index.html", "utf8");
const KIT_FILES: Record<string, [string, string]> = {
  "/kit/v1/tokens.css": [`${KIT}/tokens.css`, "text/css"],
  "/kit/v1/kit.css": [`${KIT}/kit.css`, "text/css"],
  "/kit/v1/kit.js": [`${KIT}/kit.js`, "text/javascript"],
  "/kit/v1/chat.js": [`${KIT}/chat.js`, "text/javascript"],
};

type Row = Record<string, unknown>;
interface Fake {
  calls: Array<{ verb: string; args: Record<string, any> }>;
  copied: string[];
  sessions(rows: Row[]): void;
  inbox(handle: string, rows: Row[]): void;
}
declare global {
  interface Window {
    __fake: Fake;
  }
}

const AT = Date.parse("2026-11-14T09:00:00Z");
const GUIDE = (state: string): Row => ({
  sessionId: "sess-1",
  handle: "guide-1",
  agent: "guide-claude",
  state,
  unread: 0,
});
const lead = (messageId: number, text: string, extra: Row = {}): Row => ({
  messageId,
  from: "guide-1",
  text,
  createdAtMs: AT + messageId * 1000,
  ...extra,
});
const human = (messageId: number, text: string, inReplyTo?: number): Row => ({
  messageId,
  from: "human",
  text,
  inReplyTo: inReplyTo ?? null,
  createdAtMs: AT + messageId * 1000,
});
const TEAM_CARD = lead(
  1,
  "Create your team folder?\n\nWhat: a folder for the team acme\n\ncard: team · local-write · create-team=Do it | none=Not now",
  { kind: "needs-you" },
);

interface Options {
  agents?: Record<string, { available: boolean; version?: string; resolving?: boolean }>;
  setupDone?: boolean;
  clock?: boolean;
}

/** Opens the page over the fake bridge; returns the helpers a case drives it with. */
async function open(page: Page, options: Options = {}) {
  const agents = options.agents ?? { claude: { available: true, version: "2.3.1" } };
  await page.route("http://guide.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = KIT_FILES[path];
    if (file) return route.fulfill({ contentType: file[1], body: readFileSync(file[0]) });
    return route.fulfill({ contentType: "text/html", body: PAGE });
  });
  await page.addInitScript(
    ({ agents, setupDone }) => {
      const calls: Fake["calls"] = [];
      const copied: string[] = [];
      let sessionListener: ((rows: Row[] | null, error?: unknown) => void) | null = null;
      let latest: Row[] = [];
      const threads = new Map<string, Row[]>();
      const inboxListeners = new Set<() => void>();
      const sessionsNow = () => sessionListener && sessionListener(latest);
      (window as any).codesense = {
        has: () => true,
        invoke: async (verb: string, args: Record<string, any> = {}) => {
          calls.push({ verb, args });
          if (verb === "getDependencyStatus") return { agents };
          if (verb === "setupState")
            return {
              orgs: setupDone
                ? [
                    {
                      slug: "acme",
                      teams: [
                        { name: "web", archived: false, sourceRepos: [{ slug: "acme/web" }] },
                      ],
                    },
                  ]
                : [
                    {
                      slug: "codesense/docs",
                      teams: [{ name: "getting-started", archived: false, sourceRepos: [] }],
                    },
                  ],
            };
          if (verb === "openWorkspace") return { status: "opened", handle: "guide-1" };
          if (verb === "sendAsHuman") return { status: "sent", messageId: 90 + calls.length };
          if (verb === "replyAsHuman") return { status: "sent" };
          return { status: "ok" };
        },
        onSessions: (cb: (rows: Row[] | null, error?: unknown) => void) => {
          sessionListener = cb;
          cb(latest);
          return () => {
            sessionListener = null;
          };
        },
        onInboxChanged: (cb: () => void) => {
          inboxListeners.add(cb);
          return () => inboxListeners.delete(cb);
        },
        inbox: async ({ sessionId }: { sessionId: string }) => threads.get(sessionId) ?? [],
      };
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: async (text: string) => void copied.push(text) },
      });
      (window as any).__fake = {
        calls,
        copied,
        sessions(rows: Row[]) {
          latest = rows;
          sessionsNow();
        },
        inbox(handle: string, rows: Row[]) {
          threads.set(handle, rows);
          inboxListeners.forEach((fn) => fn());
        },
      };
    },
    { agents, setupDone: options.setupDone ?? false },
  );
  if (options.clock) await page.clock.install({ time: AT });
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.goto("http://guide.test/page");
  const calls = (verb: string) =>
    page.evaluate((v) => window.__fake.calls.filter((c) => c.verb === v), verb);
  const sessions = (rows: Row[]) => page.evaluate((r) => window.__fake.sessions(r), rows);
  const inbox = (rows: Row[]) => page.evaluate((r) => window.__fake.inbox("guide-1", r), rows);
  // A running guide with these messages: what the app's roster and inbox would show after the launch.
  const live = async (rows: Row[], state = "idle") => {
    await sessions([GUIDE(state)]);
    await inbox(rows);
    if (options.clock) await page.clock.runFor(1000);
  };
  return { calls, sessions, inbox, live };
}

test("it opens the setup agent by itself: its own team workspace, the runtime's guide, the setup model, the skill", async ({
  page,
}) => {
  const { calls } = await open(page);
  await expect.poll(async () => (await calls("openWorkspace")).length).toBe(1);
  const [{ args }] = await calls("openWorkspace");
  expect(args.target).toMatchObject({
    kind: "team-workspace",
    org: "codesense/docs",
    team: "getting-started",
  });
  expect(args.agent).toBe("guide-claude");
  expect(args.model).toBe("claude-sonnet-5-5");
  expect(args.initialPrompt).toBe("/codesense-setup");
  await expect(page.locator("#rt")).toContainText("Claude · Sonnet 5.5 · your login");
});

test("once setup is done it asks for the cheaper model, and Codex gets its own skill syntax", async ({
  page,
}) => {
  const { calls } = await open(page, {
    setupDone: true,
    agents: { codex: { available: true, version: "0.167.0" } },
  });
  await expect.poll(async () => (await calls("openWorkspace")).length).toBe(1);
  const [{ args }] = await calls("openWorkspace");
  expect(args.agent).toBe("guide-codex");
  expect(args.model).toBe("gpt-6-luna");
  expect(args.initialPrompt).toBe("$codesense-setup");
});

test("a consent card shows its class and buttons, and a click replies to that card", async ({
  page,
}) => {
  const { live, calls } = await open(page);
  await live([TEAM_CARD]);
  const card = page.locator('[data-card="1"]');
  await expect(card).toHaveAttribute("data-step", "team");
  await expect(card.locator(".cls")).toHaveText("local change");
  await expect(card).not.toContainText("card:");
  await expect(card.locator("[data-ans]")).toHaveText(["Do it", "Not now"]);
  await expect(page.getByText("Needs you", { exact: true }).first()).toBeVisible();
  await card.locator('[data-ans="Do it"]').click();
  await expect.poll(async () => (await calls("replyAsHuman")).length).toBe(1);
  expect((await calls("replyAsHuman"))[0].args).toEqual({ messageId: 1, text: "Do it" });
});

test("the agent's Next line becomes chips; a click sends, the pencil edits first", async ({
  page,
}) => {
  const { live, calls } = await open(page);
  await live([
    lead(2, "Hi. What do you work on?\n\nNext: `I work on acme/web`, `What is CodeSense?`"),
  ]);
  const chips = page.locator(".chips");
  await expect(chips.locator("[data-chip]")).toHaveText([
    "I work on acme/web",
    "What is CodeSense?",
  ]);
  await expect(page.getByText("Next:")).toHaveCount(0);
  await chips.locator('[data-chip-edit="What is CodeSense?"]').click();
  await expect(page.locator("#sv-composer-input")).toHaveValue("What is CodeSense?");
  expect(await calls("sendAsHuman")).toHaveLength(0);
  await chips.locator('[data-chip="I work on acme/web"]').click();
  await expect.poll(async () => (await calls("sendAsHuman")).length).toBe(1);
  expect((await calls("sendAsHuman"))[0].args).toEqual({
    to: "guide-1",
    text: "I work on acme/web",
  });
});

test("while the agent works the page shows the activity line and a Stop that stops it", async ({
  page,
}) => {
  const { live, calls } = await open(page);
  await live([lead(2, "Cloning now.")], "running");
  await expect(page.locator('[data-row="activity"]')).toBeVisible();
  const stop = page.locator("[data-stop]");
  await expect(stop).toBeVisible();
  await stop.click();
  await expect.poll(async () => (await calls("stopSession")).length).toBe(1);
  expect((await calls("stopSession"))[0].args).toEqual({ handle: "guide-1" });
  // Idle again: no Stop.
  await page.evaluate((row) => window.__fake.sessions([row]), GUIDE("idle"));
  await expect(stop).toHaveCount(0);
});

test("with no agent CLI it shows the empty state and starts nothing; Check again reads the Mac again", async ({
  page,
}) => {
  const { calls } = await open(page, { agents: { claude: { available: false } } });
  await expect(page.getByRole("heading", { name: "No agent CLI found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Install Claude Code" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Install Codex" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Install OpenCode" })).toBeVisible();
  await expect(page.locator("#sv-composer-input")).toHaveCount(0);
  expect(await calls("openWorkspace")).toHaveLength(0);
  const before = (await calls("getDependencyStatus")).length;
  await page.getByRole("button", { name: "Check again" }).click();
  await expect
    .poll(async () => (await calls("getDependencyStatus")).length)
    .toBeGreaterThan(before);
});

test("Hermes alone is no way to run setup", async ({ page }) => {
  const { calls } = await open(page, { agents: { hermes: { available: true, version: "1.0.0" } } });
  await expect(page.getByRole("heading", { name: "No agent CLI found" })).toBeVisible();
  await expect(page.getByText("Hermes is installed but needs a model endpoint")).toBeVisible();
  expect(await calls("openWorkspace")).toHaveLength(0);
});

test("a CLI that never answers gets the sign-in notice with its own login command, which goes away once it speaks", async ({
  page,
}) => {
  const { live, calls } = await open(page, { clock: true });
  await page.clock.runFor(1000);
  await expect.poll(async () => (await calls("openWorkspace")).length).toBe(1);
  await page.evaluate((row) => window.__fake.sessions([row]), GUIDE("idle"));
  await page.clock.runFor(26000);
  const notice = page.locator('[data-notice="login"]');
  await expect(notice).toContainText("Claude may need you to sign in");
  await expect(notice.locator("code")).toHaveText("claude auth login");
  await notice.locator('[data-act="copy-login"]').click();
  await expect(page.getByText("Copied the sign-in command.")).toBeVisible();
  expect(await page.evaluate(() => window.__fake.copied)).toEqual(["claude auth login"]);
  await live([lead(2, "Hi. I'm CodeSense.")]);
  await expect(notice).toHaveCount(0);
});

test("a session stuck at its startup screen shows the sign-in notice at once", async ({ page }) => {
  const { sessions, calls } = await open(page);
  await expect.poll(async () => (await calls("openWorkspace")).length).toBe(1);
  await sessions([{ ...GUIDE("idle"), needsYouKind: "startup" }]);
  await expect(page.locator('[data-notice="login"]')).toContainText(
    "Claude may need you to sign in",
  );
});

test("Copy setup summary copies the cards the person answered", async ({ page }) => {
  const { live } = await open(page);
  await live([
    TEAM_CARD,
    human(3, "Do it", 1),
    lead(
      4,
      "Clone these 2 repos?\n\ncard: clone · local-write · clone-repos=Do it | none=Not now",
      { kind: "needs-you" },
    ),
    human(5, "Not now", 4),
  ]);
  await expect(page.locator('[data-card="4"][data-state="answered"]')).toBeVisible();
  await page.getByRole("button", { name: "Setup menu" }).click();
  await page.getByRole("menuitem", { name: "Copy setup summary" }).click();
  await expect(page.getByText("Copied the setup summary.")).toBeVisible();
  expect(await page.evaluate(() => window.__fake.copied)).toEqual([
    [
      "CodeSense setup summary",
      "- Create your team folder? → Do it",
      "- Clone these 2 repos? → Not now (declined)",
    ].join("\n"),
  ]);
});

test("the ⋯ menu asks what is set up, and Clear conversation asks before it stops the agent", async ({
  page,
}) => {
  const { live, calls } = await open(page);
  await live([lead(2, "Hi.")]);
  await page.getByRole("button", { name: "Setup menu" }).click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "What I've set up",
    "Copy setup summary",
    "Clear conversation",
  ]);
  await page.getByRole("menuitem", { name: "What I've set up" }).click();
  await expect.poll(async () => (await calls("sendAsHuman")).length).toBe(1);
  expect((await calls("sendAsHuman"))[0].args.text).toBe("What have you set up?");
  await page.getByRole("button", { name: "Setup menu" }).click();
  await page.getByRole("menuitem", { name: "Clear conversation" }).click();
  await expect(page.getByRole("group", { name: "Clear this conversation?" })).toBeVisible();
  expect(await calls("stopSession")).toHaveLength(0);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("group", { name: "Clear this conversation?" })).toHaveCount(0);
});

test("the runtime chip lists the installed CLIs and switching asks first", async ({ page }) => {
  const { calls } = await open(page, {
    agents: {
      claude: { available: true, version: "2.3.1" },
      codex: { available: true, version: "0.167.0" },
    },
  });
  await expect.poll(async () => (await calls("openWorkspace")).length).toBe(1);
  await page.locator("#rt").click();
  const dialog = page.getByRole("dialog", { name: "Choose the setup agent's CLI" });
  await expect(dialog.getByRole("radio")).toHaveText(["Claude", "Codex"]);
  await expect(dialog.getByRole("radio", { name: "Claude" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await dialog.getByRole("radio", { name: "Codex" }).click();
  await expect(dialog.getByRole("group", { name: "Switch to Codex?" })).toBeVisible();
  // Nothing changes until it is confirmed: Claude stays checked.
  await expect(dialog.getByRole("radio", { name: "Claude" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
