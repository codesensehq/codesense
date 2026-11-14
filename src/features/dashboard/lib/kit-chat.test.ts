// SPDX-License-Identifier: MIT
/**
 * `kit.chat` (/kit/v1/chat.js): the bundle a live doc loads, driven the way a page drives it, with a fake
 * transport and roster. The marks rule and the card parser have their own cases in
 * src/features/inbox/lib/chat-core.test.ts; the browser-level layout cases run where the pages are built.
 */
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../../../src-tauri/src/http/routes/dashboard_kit/codesense.d.ts" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error -- a plain Node ESM script without type declarations.
import { bundleChat } from "../../../../scripts/gen-dashboard-kit-chat.mjs";
import type * as ChatCore from "../../inbox/lib/chat-core";

const KIT_DIR = join(process.cwd(), "src-tauri/src/http/routes/dashboard_kit");
const CHAT_JS = readFileSync(join(KIT_DIR, "chat.js"), "utf8");

type Row = Record<string, unknown>;
// The page-facing types are the contract: a member the served kit gains without a type here fails tsc, and so
// does a core rule whose signature the types no longer accept.
type Kit = { chat: CodesenseSdk.KitChat };
const _coreMatchesTypes: CodesenseSdk.KitChat["core"] = {} as typeof ChatCore;
void _coreMatchesTypes;

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const lead = (state: string): Row => ({
  sessionId: "s1",
  handle: "lead-1",
  state,
  story: "demo-story",
  role: "lead",
  unread: 0,
  mailNotice: null,
  notifiedAt: null,
});

function setup(roster: Row[], thread: CodesenseSdk.ChatRow[] = []) {
  const listeners = new Map<string, Set<() => void>>();
  const emit = (event: string) => listeners.get(event)?.forEach((fn) => fn());
  const send = vi.fn(async () => ({ status: "sent", messageId: 41 }));
  const reply = vi.fn(async () => ({ status: "sent" }));
  const transport = {
    launch: vi.fn(async () => ({ sessionId: "s1" })),
    send,
    reply,
    stop: vi.fn(async () => ({})),
    gotoAgent: vi.fn(async () => ({})),
    stream: null,
    threadOf: async () => thread,
    roleThread: async () => [],
  };
  const reads = {
    on(event: string, fn: () => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return () => listeners.get(event)!.delete(fn);
    },
    async sessions() {
      emit("sessions");
    },
    latestSessions: () => roster,
    usage: async () => ({}),
  };
  const el = document.createElement("div");
  document.body.append(el);
  return { transport, reads, el, send, reply };
}

const kitOf = () => (window as unknown as { codesense: { kit: Kit } }).codesense.kit;
const mountOn = (s: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) =>
  kitOf().chat.mount(s.el, {
    storyId: "demo-story",
    leadRole: "lead",
    transport: s.transport,
    reads: s.reads,
    ...extra,
  });
const typeAndSend = async (el: HTMLElement, text: string) => {
  const input = el.querySelector<HTMLTextAreaElement>("#sv-composer-input")!;
  input.value = text;
  el.querySelector<HTMLButtonElement>("#sv-send")!.click();
  await flush();
};

beforeEach(() => {
  (window as unknown as { codesense: unknown }).codesense = { kit: {} };
  new Function(CHAT_JS)();
});
afterEach(() => {
  document.body.replaceChildren();
});

describe("kit.chat", () => {
  it("is the committed bundle of its modules, and a plain script", () => {
    expect(bundleChat()).toBe(CHAT_JS);
    expect(CHAT_JS).not.toMatch(/^\s*(import|export)\b/m);
    expect(Object.keys(kitOf().chat).sort()).toEqual(["core", "mount", "pinToBottom", "thread"]);
  });

  it("does not replace a chat that is already there", () => {
    const first = kitOf().chat;
    new Function(CHAT_JS)();
    expect(kitOf().chat).toBe(first);
  });

  it("a message to an idle lead goes out at once and reads Delivered", async () => {
    const s = setup([lead("idle")]);
    mountOn(s);
    await flush();
    await typeAndSend(s.el, "hello");
    expect(s.send).toHaveBeenCalledWith("lead-1", "hello");
    const bubble = s.el.querySelector(".log .msg.you")!;
    expect(bubble.querySelector(".body")!.textContent).toBe("hello");
    expect(bubble.querySelector(".mark")!.getAttribute("data-mark")).toBe("delivered");
  });

  it("a message to a busy lead reads Queued until the lead's notice says it was told", async () => {
    const roster = [lead("running")];
    const s = setup(roster);
    mountOn(s);
    await flush();
    await typeAndSend(s.el, "when you can");
    expect(s.el.querySelector(".mark")!.getAttribute("data-mark")).toBe("queued");
    roster[0] = {
      ...roster[0],
      mailNotice: "told",
      notifiedAt: new Date(Date.now() + 1000).toISOString(),
    };
    await s.reads.sessions();
    await flush();
    expect(s.el.querySelector(".mark")!.getAttribute("data-mark")).toBe("delivered");
  });

  it("a needs-you message is a card; a pick answers it once through the transport", async () => {
    const text = "Ship it?\n\nOptions: `Ship`, `Hold`. My pick: Ship, because green.";
    const s = setup(
      [lead("idle")],
      [{ messageId: 9, from: "lead-1", kind: "needs-you", text, createdAtMs: 1000 }],
    );
    mountOn(s);
    await flush();
    const card = s.el.querySelector('[data-card="9"]')!;
    expect(card.getAttribute("data-state")).toBe("open");
    const options = [...card.querySelectorAll<HTMLButtonElement>("[data-ans]")];
    expect(options.map((b) => b.dataset.ans)).toEqual(["Ship", "Hold"]);
    options[1].click();
    await flush();
    expect(s.reply).toHaveBeenCalledTimes(1);
    expect(s.reply).toHaveBeenCalledWith(9, "Hold");
    expect(s.el.querySelector('[data-card="9"]')!.getAttribute("data-state")).toBe("answered");
  });

  it("cards: false shows a needs-you message as a message", async () => {
    const text = "Ship it?\n\nOptions: `Ship`, `Hold`.";
    const s = setup(
      [lead("idle")],
      [{ messageId: 9, from: "lead-1", kind: "needs-you", text, createdAtMs: 1000 }],
    );
    mountOn(s, { cards: false });
    await flush();
    expect(s.el.querySelector("[data-card]")).toBeNull();
    expect(s.el.querySelector('[data-mid="9"] .body')!.textContent).toBe(text);
  });

  it("chips send their text like a typed message", async () => {
    const s = setup([lead("idle")]);
    mountOn(s, { chips: [{ label: "Status?", text: "What is the status?" }] });
    await flush();
    s.el.querySelector<HTMLButtonElement>('[data-chip="Status?"]')!.click();
    await flush();
    expect(s.send).toHaveBeenCalledWith("lead-1", "What is the status?");
  });

  it("layout.source, headerSlot and unmount", async () => {
    const s = setup([lead("idle")]);
    const slot = document.createElement("div");
    const chat = mountOn(s, {
      layout: { source: "Transcript arrives later" },
      headerSlot: {
        slot,
        render: (state: { lead: Row | null }) => ({
          sig: String(state.lead && state.lead.state),
          nodes: [document.createTextNode(`lead ${state.lead && state.lead.state}`)],
        }),
      },
    });
    await flush();
    expect(s.el.querySelector(".src")!.textContent).toBe("Transcript arrives later");
    expect(slot.textContent).toBe("lead idle");
    chat.unmount();
    expect(s.el.childNodes.length).toBe(0);
  });
  it("pinToBottom follows the newest message until the reader scrolls up, and reset follows again", () => {
    const log = document.createElement("div");
    Object.defineProperty(log, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(log, "clientHeight", { value: 100, configurable: true });
    const pin = kitOf().chat.pinToBottom(log, { settle: false });
    expect(log.scrollTop).toBe(1000);
    log.scrollTop = 200;
    log.dispatchEvent(new Event("scroll"));
    pin.onContentChanged();
    expect(log.scrollTop).toBe(200);
    pin.reset();
    expect(log.scrollTop).toBe(1000);
  });
});
