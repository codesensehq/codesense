// SPDX-License-Identifier: MIT
// The bundled Agent Accounts dashboard (src-tauri/assets/dashboards/agent-usage) runs in a
// frame the app embeds. It trusts only the app's own origins as its host, sends its requests
// only to that origin, and renders usage values only as numbers.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window as DocWindow } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = resolve(__dirname, "../../../..");
const HTML = readFileSync(
  resolve(ROOT, "src-tauri/assets/dashboards/agent-usage/index.html"),
  "utf8",
);
const APP_ORIGIN = "tauri://localhost";

type Sent = { data: { type: string; id?: number; command?: string }; target: string };

function boot() {
  const win = new DocWindow({
    url: "http://127.0.0.1:1/api/v1/bundled-dashboards/agent-usage",
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    } as never,
  });
  const sent: Sent[] = [];
  const parent = {
    postMessage: vi.fn((data: Sent["data"], target: string) => sent.push({ data, target })),
  };
  (win as unknown as { parent: unknown }).parent = parent;
  win.document.write(HTML);
  const post = (data: unknown, origin = APP_ORIGIN, source: unknown = parent) =>
    win.dispatchEvent(new win.MessageEvent("message", { data, origin, source: source as never }));
  return { win, doc: win.document as unknown as Document, sent, post };
}

const ACCOUNT = {
  id: "acct-1",
  provider: "codex",
  label: "Personal",
  generation: 1,
  authState: "ready",
};

function listReply(id: number, remainingPercentage: unknown) {
  return {
    type: "codesense:agent-accounts-result",
    channel: "chan-1",
    id,
    ok: true,
    data: {
      accounts: [ACCOUNT],
      detached: [],
      usage: [
        {
          accountProfileId: "acct-1",
          sequence: 1,
          usageReceivedAt: 1,
          usageFreshness: "fresh",
          allowanceWindows: [{ label: "5h", remainingPercentage, resetsAt: null }],
        },
      ],
      active: { claude: null, codex: null },
    },
  };
}

let open: DocWindow[] = [];
afterEach(async () => {
  await Promise.all(open.map((w) => w.happyDOM.close()));
  open = [];
});

describe("agent usage dashboard", () => {
  it("sends its requests only to the app origin that initialized it", async () => {
    const page = boot();
    open.push(page.win);
    page.post({ type: "codesense:agent-accounts-init", channel: "chan-1" });
    await vi.waitFor(() => expect(page.sent.length).toBeGreaterThan(0));
    expect(page.sent[0].data.command).toBe("list");
    expect(page.sent.every((s) => s.target === APP_ORIGIN)).toBe(true);
  });

  it("ignores an init from an origin that is not the app", async () => {
    const page = boot();
    open.push(page.win);
    page.post({ type: "codesense:agent-accounts-init", channel: "chan-1" }, "https://evil.example");
    await new Promise((r) => setTimeout(r, 20));
    expect(page.sent).toEqual([]);
  });

  it("ignores a reply from another app origin than the one that initialized it", async () => {
    const page = boot();
    open.push(page.win);
    page.post({ type: "codesense:agent-accounts-init", channel: "chan-1" });
    await vi.waitFor(() => expect(page.sent.length).toBeGreaterThan(0));
    const id = page.sent[0].data.id!;
    page.post(listReply(id, 50), "https://tauri.localhost");
    await new Promise((r) => setTimeout(r, 20));
    expect(page.doc.querySelector('[data-id="acct-1"]')).toBeNull();
    // The same reply from the host that initialized the page is rendered.
    page.post(listReply(id, 50));
    await vi.waitFor(() => expect(page.doc.querySelector('[data-id="acct-1"]')).not.toBeNull());
  });

  it("ignores messages from a window that is not its parent", async () => {
    const page = boot();
    open.push(page.win);
    page.post({ type: "codesense:agent-accounts-init", channel: "chan-1" }, APP_ORIGIN, {});
    await new Promise((r) => setTimeout(r, 20));
    expect(page.sent).toEqual([]);
  });

  it("sends the revoke on unload to the host origin", async () => {
    const page = boot();
    open.push(page.win);
    page.post({ type: "codesense:agent-accounts-init", channel: "chan-1" });
    await vi.waitFor(() => expect(page.sent.length).toBeGreaterThan(0));
    page.win.dispatchEvent(new page.win.Event("beforeunload"));
    const revoke = page.sent.find((s) => s.data.type === "codesense:agent-accounts-revoke");
    expect(revoke?.target).toBe(APP_ORIGIN);
  });

  it("trusts exactly the app's packaged origins", () => {
    const rust = readFileSync(resolve(ROOT, "src-tauri/src/http/app_origins.rs"), "utf8");
    const packaged = /const PACKAGED_ORIGINS: \[&str; \d+\] = \[([^\]]*)\]/.exec(rust)?.[1];
    const page = /const APP_ORIGINS=\[([^\]]*)\]/.exec(HTML)?.[1];
    const list = (src: string | undefined) =>
      [...(src ?? "").matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    expect(list(packaged).length).toBeGreaterThan(0);
    expect(list(page)).toEqual(list(packaged));
  });

  it("renders a usage value only as a number, never as markup", async () => {
    const page = boot();
    open.push(page.win);
    page.post({ type: "codesense:agent-accounts-init", channel: "chan-1" });
    await vi.waitFor(() => expect(page.sent.length).toBeGreaterThan(0));
    page.post(listReply(page.sent[0].data.id!, '50%"><img src=x id=injected>'));
    await vi.waitFor(() => expect(page.doc.querySelector('[data-id="acct-1"]')).not.toBeNull());
    expect(page.doc.getElementById("injected")).toBeNull();
    const bar = page.doc.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
  });

  it("clamps a usage number into 0 to 100", async () => {
    const page = boot();
    open.push(page.win);
    page.post({ type: "codesense:agent-accounts-init", channel: "chan-1" });
    await vi.waitFor(() => expect(page.sent.length).toBeGreaterThan(0));
    page.post(listReply(page.sent[0].data.id!, 140));
    await vi.waitFor(() => expect(page.doc.querySelector('[role="progressbar"]')).not.toBeNull());
    expect(page.doc.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe(
      "100",
    );
  });
});
