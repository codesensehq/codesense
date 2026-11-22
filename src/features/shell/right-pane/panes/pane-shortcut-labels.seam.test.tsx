// SPDX-License-Identifier: MIT
/**
 * The built-in panes' shortcut hints and machine words, end to end: the slot context the real
 * viewer posts reaches the real shim while the pane document is still loading, as it does in the
 * app, and every hint reads right once the document has loaded.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error jsdom ships no types in this repo; the shapes used are typed below.
import { JSDOM as JsdomClass, VirtualConsole as VirtualConsoleClass } from "jsdom";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MintFrameArgs } from "@/tauri/commands";
import { HtmlViewer } from "@/features/dashboard/components/html-viewer";
import { restorePlatform, setPlatform } from "@/test/platform";
import { FrameMessageEvent } from "../../../../../tests/support/fixtures/frame";
import { shimSource } from "../../../../../tests/support/page-shim";

vi.mock("@/tauri/commands", async (importOriginal) => {
  const frame = await import("../../../../../tests/support/fixtures/frame");
  return {
    ...(await importOriginal<typeof import("@/tauri/commands")>()),
    ...frame.frameCommands(),
    mintFrame: async (args: MintFrameArgs) => frame.frameFixture(args),
    getHttpApiPort: () => Promise.resolve(9123),
    bridgeDocContext: () => Promise.resolve(null),
  };
});
globalThis.fetch = vi.fn().mockResolvedValue({ status: 200 }) as never;

type PaneWindow = Window & typeof globalThis;
interface Jsdom {
  window: PaneWindow;
}
const JSDOM = JsdomClass as new (
  html: string,
  options: {
    runScripts: "dangerously";
    pretendToBeVisual: boolean;
    url: string;
    virtualConsole: unknown;
    beforeParse(win: PaneWindow): void;
  },
) => Jsdom;
const VirtualConsole = VirtualConsoleClass as new () => {
  on(event: "jsdomError", listener: (error: Error & { detail?: { stack?: string } }) => void): void;
};
const SHIM = shimSource();
const NOTES = readFileSync(
  resolve("src/features/shell/right-pane/__fixtures__/notes-pane.html"),
  "utf8",
)
  .replace('<script type="module">', "<script>")
  .replace(
    'import { createEditor } from "/kit/v1/editor.js";',
    "const createEditor = window.createEditor;",
  );
const INBOX = readFileSync(
  resolve("src/features/shell/right-pane/__fixtures__/inbox-pane.html"),
  "utf8",
);
/** The members an app before the shortcut SDK lacks. */
const NEW_MEMBERS = [
  "formatKeys",
  "fillKeys",
  "formatModifierClick",
  "localMachineLabel",
  "localMachinePhrase",
];

/** Any property or call of it gives itself back: an editor that does nothing. */
const inert: unknown = new Proxy(function () {}, {
  get: (_target, key) => (key === Symbol.toPrimitive ? () => "" : inert),
  apply: () => inert,
});
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const docs: Jsdom[] = [];
afterEach(() => {
  cleanup();
  restorePlatform();
  for (const dom of docs.splice(0)) dom.window.close();
});

/** The slot context the real viewer posts after the shim's ready, on `platform`. */
async function hostSlotContext(platform: string) {
  setPlatform(platform);
  render(
    <HtmlViewer filePath="/ctx/acme/a/content/pane.html" teamContentPath="/ctx/acme/a/content" />,
  );
  await waitFor(() => expect(document.querySelector("iframe")?.getAttribute("src")).toBeTruthy());
  const iframe = document.querySelector("iframe")!;
  const postMessage = vi.fn();
  const frameWindow = { postMessage } as unknown as Window;
  Object.defineProperty(iframe, "contentWindow", { value: frameWindow, configurable: true });
  act(() => {
    window.dispatchEvent(
      new FrameMessageEvent("message", { data: { type: "codesense:ready" }, source: frameWindow }),
    );
  });
  await waitFor(() =>
    expect(postMessage.mock.calls.some(([m]) => m.type === "codesense:slot-context")).toBe(true),
  );
  const message = postMessage.mock.calls.find(([m]) => m.type === "codesense:slot-context")![0];
  cleanup();
  restorePlatform();
  return message as Record<string, unknown>;
}

/**
 * Loads `html` behind the shim and delivers `slot` from a script right after it, while the
 * document is still loading and before `<body>` exists. `older` removes the SDK members an older
 * app lacks, and its slot context carries no platform flag. Resolves after DOMContentLoaded.
 */
async function loadPane(html: string, slot: Record<string, unknown>, older = false) {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.detail?.stack ?? error.message));
  const host = { postMessage: () => {} };
  let delivered: { readyState: string; body: boolean } | undefined;
  let scriptTime: { readyState: string; paste: string } | undefined;
  const scripts = `<script>window.__codesenseProxy={token:"t"}</script><script>${SHIM}</script><script>window.__deliver()</script>`;
  const dom = new JSDOM(
    html.replace(/<head[^>]*>/i, (head) => head + scripts),
    {
      runScripts: "dangerously",
      pretendToBeVisual: true,
      url: "http://f-test.localhost:9322/pane.html",
      virtualConsole,
      beforeParse(win) {
        Object.defineProperty(win, "parent", { value: host, configurable: true });
        Object.assign(win, {
          // The kit's editor is another module, so an inert one stands in. The notes script
          // creates it while the document is still loading: note what a hint built then reads.
          createEditor: (element: Element) => {
            const cs = (win as unknown as { codesense: { formatKeys?(k: string): string } })
              .codesense;
            scriptTime = {
              readyState: win.document.readyState,
              paste: cs.formatKeys?.("CmdOrCtrl+Alt+Enter") ?? "",
            };
            const surface = element.ownerDocument.createElement("div");
            surface.setAttribute("contenteditable", "true");
            element.append(surface);
            return inert;
          },
          ResizeObserver: Observer,
          IntersectionObserver: Observer,
          matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
          __deliver() {
            const cs = (win as unknown as { codesense: Record<string, unknown> }).codesense;
            if (older) for (const name of NEW_MEMBERS) delete cs[name];
            delivered = { readyState: win.document.readyState, body: !!win.document.body };
            const event = new win.Event("message");
            const data = older ? { ...slot, mac: undefined } : slot;
            Object.defineProperties(event, { data: { value: data }, source: { value: host } });
            win.dispatchEvent(event);
          },
        });
      },
    },
  );
  docs.push(dom);
  const doc = dom.window.document;
  await new Promise<void>((done) =>
    doc.readyState === "loading" ? doc.addEventListener("DOMContentLoaded", () => done()) : done(),
  );
  // The pane's own scripts run to the end: its onSlotContext and redraws are part of the seam.
  expect(errors).toEqual([]);
  return { doc, delivered: delivered!, scriptTime };
}

const shown = (el: Element) =>
  el.ownerDocument.defaultView!.getComputedStyle(el).display !== "none";

const TABLE = {
  mac: {
    find: "⌘O",
    newNote: "New note (⌘N)",
    sendTo: "Send to… (⌘⏎)",
    emptyNew: "⌘N",
    links: "⌘⏎",
    paste: "⌘⌥⏎",
    wording: "kept on this Mac",
    send: "⌘⏎",
  },
  other: {
    find: "Ctrl+O",
    newNote: "New note (Ctrl+N)",
    sendTo: "Send to… (Ctrl+⏎)",
    emptyNew: "Ctrl+N",
    links: "Ctrl+⏎",
    paste: "Ctrl+Alt+⏎",
    wording: "kept on this computer",
    send: "Ctrl+⏎",
  },
};

describe.each([
  { platform: "MacIntel", mac: true, want: TABLE.mac },
  { platform: "Win32", mac: false, want: TABLE.other },
])("on $platform", ({ platform, mac, want }) => {
  it("the viewer's slot context carries the platform flag", async () => {
    expect((await hostSlotContext(platform)).mac).toBe(mac);
  });

  it("notes: every hint and the machine wording, from a slot context sent while loading", async () => {
    const { doc, delivered } = await loadPane(NOTES, await hostSlotContext(platform));
    expect(delivered).toEqual({ readyState: "loading", body: false });
    const $ = (selector: string) => doc.querySelector(selector)!;
    expect($("#find-note kbd").textContent).toBe(want.find);
    expect($("#new-note").getAttribute("aria-label")).toBe(want.newNote);
    expect($("#line-send").getAttribute("title")).toBe(want.sendTo);
    expect($("#line-send").getAttribute("aria-label")).toBe(want.sendTo);
    expect($("#empty-new kbd").textContent).toBe(want.emptyNew);
    expect($('.nt-empty-keys kbd[data-keys="CmdOrCtrl+Enter"]').textContent).toBe(want.links);
    expect($("#empty-state p").textContent!.replace(/\s+/g, " ")).toContain(want.wording);
  });

  it("notes: a hint its script builds while the document loads formats at once", async () => {
    const { scriptTime } = await loadPane(NOTES, await hostSlotContext(platform));
    // The send menu's paste row builds its hint this way (send-menu tests open it for real).
    expect(scriptTime).toEqual({ readyState: "loading", paste: want.paste });
  });

  it("inbox: the composer's Send hint", async () => {
    const { doc } = await loadPane(INBOX, await hostSlotContext(platform));
    expect(doc.querySelector("#send kbd")!.textContent).toBe(want.send);
  });
});

describe("an older app without the calls", () => {
  it("notes keep static key-free labels, hide every unfilled pill and say this computer", async () => {
    const { doc } = await loadPane(NOTES, await hostSlotContext("MacIntel"), true);
    const $ = (selector: string) => doc.querySelector(selector)!;
    expect($("#new-note").getAttribute("aria-label")).toBe("New note");
    expect($("#line-send").getAttribute("title")).toBe("Send to…");
    expect($("#line-send").getAttribute("aria-label")).toBe("Send to…");
    const pills = [...doc.querySelectorAll("[data-keys]")];
    expect(pills.length).toBe(3);
    for (const pill of pills) {
      expect(pill.textContent).toBe("");
      expect(shown(pill)).toBe(false);
    }
    expect($("#empty-state p").textContent!.replace(/\s+/g, " ")).toContain(
      "kept on this computer",
    );
  });

  it("inbox hides the Send pill", async () => {
    const { doc } = await loadPane(INBOX, await hostSlotContext("MacIntel"), true);
    const kbd = doc.querySelector("#send kbd")!;
    expect(kbd.textContent).toBe("");
    expect(shown(kbd)).toBe(false);
  });
});
