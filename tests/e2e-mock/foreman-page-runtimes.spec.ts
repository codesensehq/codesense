// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// The shipped Foreman page against the kit's real `kit.js`, over a fake `window.codesense` bridge. The bridge
// answers only the app's own verbs (`getDependencyStatus`, `setupState`, `openWorkspace`); `cs.kit` is never
// stubbed, so the page reads installed agent CLIs the way the app does: `cs.kit.runtimes()`, which resolves
// `{list, pick, resolving}`. The shipped page has no kit script of its own (the app injects it, `kit_tags` in
// `dashboard_kit.rs`), so the spec injects the same tags into its `<head>`.

const KIT = "src-tauri/src/http/routes/dashboard_kit";
const PAGE = readFileSync("codesense-docs/getting-started/content/foreman/index.html", "utf8");
const KIT_FILES: Record<string, [string, string]> = {
  "/kit/v1/tokens.css": [`${KIT}/tokens.css`, "text/css"],
  "/kit/v1/kit.css": [`${KIT}/kit.css`, "text/css"],
  "/kit/v1/kit.js": [`${KIT}/kit.js`, "text/javascript"],
  "/kit/v1/virtual-list.js": [`${KIT}/virtual-list.js`, "text/javascript"],
};
// The tags `kit_tags` emits: tokens and stylesheet first, then the scripts.
const KIT_TAGS =
  '<link rel="stylesheet" href="/kit/v1/tokens.css" data-codesense-kit>' +
  '<link rel="stylesheet" href="/kit/v1/kit.css" data-codesense-kit>' +
  '<script src="/kit/v1/kit.js" data-codesense-kit></script>' +
  '<script src="/kit/v1/virtual-list.js" data-codesense-kit></script>';
const SERVED = PAGE.replace("<head>", () => `<head>${KIT_TAGS}`);
const NO_CLI_READ = "couldn't check which agent CLIs are installed";

type Agents = Record<string, { available: boolean; version?: string; resolving?: boolean }>;
interface Call {
  verb: string;
  args: Record<string, any>;
}
declare global {
  interface Window {
    __calls: Call[];
  }
}

async function open(page: Page, agents: Agents) {
  await page.route("http://foreman.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = KIT_FILES[path];
    if (file) return route.fulfill({ contentType: file[1], body: readFileSync(file[0]) });
    return route.fulfill({ contentType: "text/html", body: SERVED });
  });
  await page.addInitScript((agents) => {
    const calls: Call[] = (window.__calls = []);
    const run = async (verb: string, args: Record<string, any> = {}) => {
      calls.push({ verb, args });
      if (verb === "getDependencyStatus") return { agents };
      // The docs team is the only team: the Foreman's home.
      if (verb === "setupState")
        return {
          orgs: [
            {
              slug: "codesense/docs",
              teams: [{ name: "getting-started", archived: false, sourceRepos: [] }],
            },
          ],
        };
      if (verb === "openWorkspace") return { status: "opened", handle: "foreman-1" };
      return { status: "ok" };
    };
    (window as any).codesense = {
      has: () => true,
      invoke: run,
      // The app's shim also exposes each read verb as a method; the page reads the setup state that way.
      setupState: () => run("setupState"),
      act: run,
      onSessions: (cb: (rows: unknown[]) => void) => {
        cb([]);
        return () => {};
      },
      onInboxChanged: () => () => {},
      inbox: async () => [],
    };
  }, agents);
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.goto("http://foreman.test/page");
  const calls = (verb: string) =>
    page.evaluate((v) => window.__calls.filter((c) => c.verb === v), verb);
  const send = async (text: string) => {
    await page.fill("#sv-composer-input", text);
    await page.press("#sv-composer-input", "Enter");
  };
  return { calls, send };
}

test("with Claude installed a send starts the Foreman, and the page never says it could not check the CLIs", async ({
  page,
}) => {
  const { calls, send } = await open(page, {
    claude: { available: true, version: "2.3.1" },
    codex: { available: true, version: "0.167.0" },
  });
  await send("hello");
  await expect.poll(async () => (await calls("openWorkspace")).length).toBe(1);
  const [{ args }] = await calls("openWorkspace");
  expect(args.target).toMatchObject({
    kind: "team-workspace",
    org: "codesense/docs",
    team: "getting-started",
  });
  // The Foreman's docs-team key, the only one the launch grant allows.
  expect(args.agent).toBe("codesense/docs/getting-started/foreman-claude");
  // The person's text never rides the launch prompt: it goes in as mail the Foreman answers with
  // reply, once its session joins.
  expect(args.initialPrompt).not.toContain("hello");
  expect(args.initialPrompt).toContain("read_messages");
  expect((await calls("getDependencyStatus")).length).toBeGreaterThan(0);
  await expect(page.locator("body")).not.toContainText(NO_CLI_READ);
});

test("with no agent CLI the page shows its install card and starts nothing", async ({ page }) => {
  const { calls } = await open(page, { claude: { available: false } });
  await expect(page.locator(".fm-guide:not([hidden])")).toBeVisible();
  expect((await calls("openWorkspace")).length).toBe(0);
  await expect(page.locator("body")).not.toContainText(NO_CLI_READ);
});
