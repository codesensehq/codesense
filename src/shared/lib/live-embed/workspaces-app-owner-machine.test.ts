// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The workspaces page (and the bug-triage and mission-control pages that share it) names the
// owner's computer with CS.ownerMachine(), the noun the host wrote in the page's meta.

const SRC = join(process.cwd(), "src-tauri/src");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");
const INDEX_HTML = read("dashboard_publish/templates/workspaces/index.html");
const APP_JS = read("dashboard_publish/templates/workspaces/app.js");

type Listener = (rows: unknown[], state: string, detail?: string) => void;
type Page = {
  status: () => string;
  banner: () => string;
  presence: (mac: string) => void;
  agents: Listener;
  workspaces: Listener;
};

// The page body with the placeholders the host fills in, and app.js run over a stand-in CS.
function openPage(noun: string): Page {
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(INDEX_HTML)![1];
  document.body.innerHTML = body
    .replace(/<script[^>]*><\/script>/g, "")
    .replaceAll("{{title}}", "Team")
    .replaceAll("{{owner_machine}}", noun);
  const caught: Partial<Record<"presence" | "agents" | "workspaces" | "inbox", unknown>> = {};
  const capture = (key: keyof typeof caught) => (cb: unknown) => {
    caught[key] = cb;
    return () => {};
  };
  const CS = {
    ownerMachine: () => noun,
    role: () => "viewer",
    fontRange: { min: 6, max: 18, initial: 13 },
    ready: () => new Promise(() => {}),
    passing: () => false,
    onPresence: capture("presence"),
    listAgents: capture("agents"),
    listWorkspaces: capture("workspaces"),
    inbox: capture("inbox"),
  };
  new Function("CS", APP_JS)(CS);
  return {
    status: () => document.getElementById("status")!.textContent ?? "",
    banner: () => document.querySelector("#list .banner")?.textContent ?? "",
    presence: (mac) => (caught.presence as (p: unknown) => void)({ mac, mac_seen_at: null }),
    agents: (...args) => (caught.agents as Listener)(...args),
    workspaces: (...args) => (caught.workspaces as Listener)(...args),
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe.each([
  {
    noun: "computer",
    connecting: "Connecting to the owner's computer",
    online: "Computer online · 0 agents",
    offline: "Owner's computer is offline",
    note: "The owner's computer is offline.",
  },
  {
    noun: "Mac",
    connecting: "Connecting to the owner's Mac",
    online: "Mac online · 0 agents",
    offline: "Owner's Mac is offline",
    note: "The owner's Mac is offline.",
  },
])("the workspaces page on the owner's $noun", ({ noun, connecting, online, offline, note }) => {
  it("names it while connecting, online and offline", () => {
    const page = openPage(noun);
    expect(page.status()).toBe(connecting);
    page.presence("online");
    expect(page.status()).toBe(connecting);
    page.workspaces([], "live");
    page.agents([], "live");
    expect(page.status()).toBe(online);
    page.presence("offline");
    expect(page.status()).toBe(offline);
    expect(page.banner().startsWith(note)).toBe(true);
    expect(page.banner()).toMatch(/ Showing the list from .+\.$/);
  });

  it("an owner offline before the lists are live reads offline", () => {
    const page = openPage(noun);
    page.presence("offline");
    expect(page.status()).toBe(offline);
  });
});

describe("the shipped page sources", () => {
  // Every user-visible "Mac" now comes from the reader. What may still say it: the reader's default
  // (once in each copy of the kit core), CS.ownerMachine's fallback for an older core, and the
  // toolkit's navigator.platform test, which is not wording.
  const ALLOWED: [string, number][] = [
    ["http/routes/dashboard_kit/kit-core.js", 1],
    ["http/routes/dashboard_kit/kit.js", 1],
    ["dashboard_publish/toolkit/cs-live.js", 3],
    ["dashboard_publish/templates/workspaces/app.js", 0],
    ["dashboard_publish/templates/workspaces/index.html", 0],
  ];

  it.each(ALLOWED)("%s says Mac only where it is allowed", (path, allowed) => {
    const hits = read(path)
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .filter((line) => /\bMac\b/.test(line));
    for (const line of hits) expect(line).toMatch(/"Mac"|navigator\.platform/);
    expect(hits, hits.join("\n")).toHaveLength(allowed);
  });

  it("the page template carries the host's noun in its head and its status line", () => {
    const head = /<head>([\s\S]*)<\/head>/.exec(INDEX_HTML)![1];
    expect(head).toContain('<meta name="codesense:owner-machine" content="{{owner_machine}}">');
    expect(INDEX_HTML).toContain(
      '<p class="status" id="status" role="status" aria-live="polite">Connecting to the owner\'s {{owner_machine}}</p>',
    );
  });
});
