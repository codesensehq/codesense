// SPDX-License-Identifier: MIT
/**
 * `kit.chat` (/kit/v1/chat.js): the bundle a live doc loads, driven the way a page drives it, with a fake
 * transport and roster. The marks rule and the card parser have their own cases in
 * src/features/inbox/lib/chat-core.test.ts; the browser-level layout cases run where the pages are built.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error -- a plain Node ESM script without type declarations.
import { bundleChat } from "../../../../scripts/gen-dashboard-kit-chat.mjs";

const KIT_DIR = join(process.cwd(), "src-tauri/src/http/routes/dashboard_kit");
const CHAT_JS = readFileSync(join(KIT_DIR, "chat.js"), "utf8");

type Row = Record<string, unknown>;
// The page-facing types are checked against the served modules in codesense-sdk.test.ts; the runtime members
// are listed here, so a member the kit gains without being listed fails this file.
interface Kit {
  chat: {
    mount(el: HTMLElement, options: Record<string, unknown>): Record<string, any>;
    pinToBottom(
      log: HTMLElement,
      options?: { settle?: boolean },
    ): { onContentChanged(): void; release(): void; reset(): void };
    core: Record<string, (...args: any[]) => any>;
    thread: Record<string, (...args: any[]) => any>;
  };
}

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

function setup(roster: Row[], thread: Row[] = []) {
  const listeners = new Map<string, Set<() => void>>();
  const emit = (event: string) => listeners.get(event)?.forEach((fn) => fn());
  const send = vi.fn(
    async (_handle: string, _text: string): Promise<Record<string, unknown>> => ({
      status: "sent",
      messageId: 41,
    }),
  );
  const reply = vi.fn(async () => ({ status: "sent" }));
  const transport = {
    launch: vi.fn(async (): Promise<Row> => ({ sessionId: "s1" })),
    send,
    reply,
    stop: vi.fn(async () => ({})),
    gotoAgent: vi.fn(async () => ({})),
    stream: null,
    threadOf: async (_id: string): Promise<Row[]> => thread,
    roleThread: async (): Promise<Row[]> => [],
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
    expect(Object.keys(kitOf().chat.core).sort()).toEqual([
      "cardAnswer",
      "createMarkLatch",
      "deliveryMark",
      "isBusy",
      "parseCard",
      "parseNext",
    ]);
    expect(Object.keys(kitOf().chat.thread).sort()).toEqual([
      "mergeThread",
      "newestFrom",
      "rowsOf",
      "sideOf",
    ]);
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

  it("with no lead running, the first send launches once, a second is held, and it flushes when the lead joins", async () => {
    const roster: Row[] = [];
    const s = setup(roster);
    const timers = new Map<number, () => void>();
    let next = 0;
    mountOn(s, {
      clock: {
        now: () => 5000,
        setTimeout: (fn: () => void) => {
          timers.set(++next, fn);
          return next;
        },
        clearTimeout: (id: number) => timers.delete(id),
      },
    });
    await flush();
    await typeAndSend(s.el, "first");
    expect(s.transport.launch).toHaveBeenCalledTimes(1);
    expect(s.transport.launch).toHaveBeenCalledWith("first");
    expect(timers.size, "the slow and fail timers run while it starts").toBe(2);
    await typeAndSend(s.el, "second");
    expect(s.transport.launch, "no second launch").toHaveBeenCalledTimes(1);
    expect(s.send).not.toHaveBeenCalled();
    const marks = () =>
      [...s.el.querySelectorAll(".msg.you .mark")].map((m) => m.getAttribute("data-mark"));
    expect(marks()).toEqual(["starting", "held"]);
    roster.push(lead("idle"));
    await s.reads.sessions();
    await flush();
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledWith("lead-1", "second");
    expect(timers.size, "joining stops the timers").toBe(0);
    expect(marks()).toEqual(["delivered", "delivered"]);
  });

  it("a send that resolves with a status other than sent keeps the message and offers Retry", async () => {
    const s = setup([lead("idle")]);
    mountOn(s);
    await flush();
    s.send.mockResolvedValueOnce({ status: "invalid", message: "no such session" });
    await typeAndSend(s.el, "hello");
    expect(s.el.querySelector(".msg.you .mark")!.getAttribute("data-mark")).toBe("kept");
    const row = s.el.querySelector('[data-row="send-failed"]')!;
    expect(row.textContent).toContain("no such session");
    row.querySelector<HTMLButtonElement>("[data-retry-send]")!.click();
    await flush();
    expect(s.send).toHaveBeenCalledTimes(2);
    expect(s.send).toHaveBeenLastCalledWith("lead-1", "hello");
    expect(s.el.querySelector('[data-row="send-failed"]')).toBeNull();
    expect(s.el.querySelector(".msg.you .mark")!.getAttribute("data-mark")).toBe("delivered");
  });

  it("a card the person answered in the Inbox reads answered, with no option left to press", async () => {
    const text = "Ship it?\n\nOptions: `Ship`, `Hold`. My pick: Ship, because green.";
    const s = setup(
      [lead("idle")],
      [
        { messageId: 9, from: "lead-1", kind: "needs-you", text, createdAtMs: 1000 },
        { messageId: 10, from: "human", inReplyTo: 9, text: "Hold", createdAtMs: 2000 },
      ],
    );
    mountOn(s);
    await flush();
    const card = s.el.querySelector('[data-card="9"]')!;
    expect(card.getAttribute("data-state")).toBe("answered");
    expect(card.textContent).toContain("Answered in your Inbox");
    expect(card.textContent).toContain("Hold");
    const options = [...card.querySelectorAll<HTMLButtonElement>("[data-ans]")];
    expect(options.every((b) => b.disabled)).toBe(true);
    options[0]?.click();
    await flush();
    expect(s.reply).not.toHaveBeenCalled();
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
  describe("page seams", () => {
    const other = (state: string, extra: Row = {}): Row => ({
      ...lead(state),
      sessionId: "s2",
      handle: "lead-2",
      ...extra,
    });
    const target = (extra: Record<string, unknown> = {}) => ({
      rows: (sessions: Row[]) => sessions,
      read: async (peers: Row[], transport: any) =>
        Promise.all(peers.map((row) => transport.threadOf(row.sessionId))),
      queue: null,
      follow: false,
      leadName: () => "Helper",
      ...extra,
    });
    const placeholder = (el: HTMLElement) =>
      el.querySelector<HTMLTextAreaElement>("#sv-composer-input")!.placeholder;

    it("copy overrides the words it names and keeps the rest", async () => {
      const s = setup([lead("idle")]);
      mountOn(s, {
        target: target(),
        copy: { placeholder: { idle: "Message the helper" }, row: { typing: "The helper types" } },
      });
      await flush();
      expect(placeholder(s.el)).toBe("Message the helper");
      s.el.querySelector("#sv-composer-input")!.dispatchEvent(new Event("input"));
      const plain = setup([lead("running")]);
      mountOn(plain, {
        target: target(),
        copy: { placeholder: { idle: "Message the helper" } },
      });
      await flush();
      expect(placeholder(plain.el)).toBe("It's working; your message waits for its next step");
    });

    it("without copy the story chat's words are unchanged", async () => {
      const s = setup([lead("idle")]);
      mountOn(s);
      await flush();
      expect(placeholder(s.el)).toBe("Reply to the story lead");
    });

    it("target.pick chooses the live row a send goes to, and handles count as the peer's side", async () => {
      const s = setup(
        [lead("idle"), other("idle")],
        [{ messageId: 5, from: "old-peer", text: "from before", createdAtMs: 1000 }],
      );
      mountOn(s, {
        target: target({
          pick: (rows: Row[]) => rows[rows.length - 1],
          handles: () => ["old-peer"],
        }),
      });
      await flush();
      expect(s.el.querySelector('[data-mid="5"]')!.className).toContain("lead");
      await typeAndSend(s.el, "hello");
      expect(s.send).toHaveBeenCalledWith("lead-2", "hello");
    });

    it("without pick a send goes to the first joinable row", async () => {
      const s = setup([lead("idle"), other("idle")]);
      mountOn(s, { target: target() });
      await flush();
      await typeAndSend(s.el, "hello");
      expect(s.send).toHaveBeenCalledWith("lead-1", "hello");
    });

    it("target.sources reads each mailbox on its own: a failed one says so, Retry reads it again", async () => {
      const s = setup([lead("idle")]);
      const mail: Record<string, Row[] | Error> = {
        a: [{ messageId: 1, from: "lead-1", text: "one", createdAtMs: 1000 }],
        b: new Error("down"),
      };
      s.transport.threadOf = async (id: string) => {
        const answer = mail[id];
        if (answer instanceof Error) throw answer;
        return answer;
      };
      const chat = mountOn(s, { target: target({ sources: () => ["a", "b"] }) });
      await flush();
      expect(s.el.querySelector('[data-mid="1"]')).not.toBeNull();
      expect(s.el.querySelector("[data-row=unread]")).not.toBeNull();
      expect(chat.threadFailed()).toBe(true);
      mail.b = [{ messageId: 2, from: "lead-1", text: "two", createdAtMs: 2000 }];
      s.el.querySelector<HTMLButtonElement>("[data-thread-retry]")!.click();
      await flush();
      expect(s.el.querySelector("[data-row=unread]")).toBeNull();
      expect(s.el.querySelector('[data-mid="2"]')).not.toBeNull();
      expect(chat.threadFailed()).toBe(false);
      expect(chat.threadSettled()).toBe(true);
    });

    it("target.sources reads the role queue on open, not only after an inbox push", async () => {
      const s = setup([lead("idle")]);
      s.transport.roleThread = async () => [
        { messageId: 7, from: "lead-1", text: "queued", createdAtMs: 500 },
      ];
      mountOn(s, { target: target({ sources: () => ["a"] }) });
      await flush();
      expect(s.el.querySelector('[data-mid="7"]')).not.toBeNull();
    });

    it("bindLaunched alone keeps presence's default rule: the first row that has not exited", async () => {
      const crashed = { ...lead("idle"), effectiveStatus: "crashed" };
      const plain = setup([crashed]);
      const a = mountOn(plain, { target: target() });
      const bound = setup([crashed]);
      const b = mountOn(bound, { target: target({ bindLaunched: true }) });
      await flush();
      expect(a.lead()).not.toBeNull();
      expect(b.lead()).toEqual(a.lead());
    });

    it("a source that answered and then failed to refresh is stale, and its mail stays", async () => {
      const s = setup([lead("idle")]);
      let down = false;
      s.transport.threadOf = async () => {
        if (down) throw new Error("down");
        return [{ messageId: 1, from: "lead-1", text: "one", createdAtMs: 1000 }];
      };
      const chat = mountOn(s, { target: target({ sources: () => ["a"] }) });
      await flush();
      expect(s.el.querySelector("[data-row=stale]")).toBeNull();
      down = true;
      await chat.refresh();
      await flush();
      expect(s.el.querySelector("[data-row=stale]")).not.toBeNull();
      expect(s.el.querySelector("[data-row=unread]")).toBeNull();
      expect(s.el.querySelector('[data-mid="1"]')).not.toBeNull();
    });

    it("a handle that comes back on a new session is read again", async () => {
      const roster = [lead("idle")];
      const s = setup(roster);
      const asked: string[] = [];
      s.transport.threadOf = async (id: string) => {
        asked.push(id);
        return [];
      };
      mountOn(s, { target: target({ sources: (rows: Row[]) => rows.map((row) => row.handle) }) });
      await flush();
      const first = asked.filter((id) => id === "lead-1").length;
      roster[0] = { ...roster[0], sessionId: "s9" };
      await s.reads.sessions();
      await flush();
      expect(asked.filter((id) => id === "lead-1").length).toBe(first + 1);
    });

    it("post sends a message from another control, and is refused while the composer is off", async () => {
      const s = setup([lead("idle")]);
      const chat = mountOn(s, { target: target() });
      await flush();
      expect(chat.post("a starter")).toBe(true);
      await flush();
      expect(s.send).toHaveBeenCalledWith("lead-1", "a starter");
      chat.setDone(true);
      expect(chat.post("again")).toBe(false);
    });

    it("bindLaunched: a launch that names only a handle binds to that row", async () => {
      const roster: Row[] = [];
      const s = setup(roster);
      s.transport.launch = vi.fn(async () => ({ handle: "lead-2", promptDelivered: false }));
      mountOn(s, {
        target: target({ bindLaunched: true }),
        timers: { slowMs: 20000, failMs: 120000 },
      });
      await flush();
      await typeAndSend(s.el, "hello");
      roster.push(lead("idle"), other("idle"));
      await s.reads.sessions();
      await flush();
      expect(s.send).toHaveBeenCalledWith("lead-2", "hello");
    });

    it("a refusal reads as any failure unless the page has words for it", async () => {
      const refuse = async () => {
        throw new Error("refused: no room");
      };
      const plain = setup([]);
      plain.transport.launch = vi.fn(refuse);
      mountOn(plain, { target: target() });
      await flush();
      await typeAndSend(plain.el, "hello");
      expect(plain.el.querySelector("[data-row=failed] .why")!.textContent).toContain(
        "Couldn't start the story lead: refused: no room.",
      );
      const own = setup([]);
      own.transport.launch = vi.fn(refuse);
      mountOn(own, {
        target: target(),
        copy: { failure: { refused: (why: string) => `Couldn't start it: ${why}.` } },
      });
      await flush();
      await typeAndSend(own.el, "hello");
      expect(own.el.querySelector("[data-row=failed] .why")!.textContent).toBe(
        "Couldn't start it: no room.",
      );
    });

    it("keepUnsent: a failed launch keeps its messages and the unload warning says they were not sent", async () => {
      const s = setup([]);
      s.transport.launch = vi.fn(async () => {
        throw new Error("denied: no");
      });
      mountOn(s, { target: target({ keepUnsent: true }) });
      await flush();
      await typeAndSend(s.el, "hello");
      expect(s.el.querySelector("[data-row=failed]")).not.toBeNull();
      let text = "";
      const event = new Event("beforeunload", { cancelable: true });
      Object.defineProperty(event, "returnValue", { set: (v) => (text = v), get: () => text });
      window.dispatchEvent(event);
      expect(text).toBe("Some messages weren't sent.");
    });
  });

  it("pinToBottom follows the newest message until the reader scrolls up, and reset follows again", () => {
    const log = document.createElement("div");
    Object.defineProperty(log, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(log, "clientHeight", { value: 100, configurable: true });
    const pin = kitOf().chat.pinToBottom(log, { settle: false });
    expect(Object.keys(pin).sort()).toEqual(["onContentChanged", "release", "reset"]);
    expect(log.scrollTop).toBe(1000);
    log.scrollTop = 200;
    log.dispatchEvent(new Event("scroll"));
    pin.onContentChanged();
    expect(log.scrollTop).toBe(200);
    pin.reset();
    expect(log.scrollTop).toBe(1000);
  });
});

describe("kit.chat page layout and activity", () => {
  const running = (note?: string): Row => ({
    ...lead("running"),
    progress: note === undefined ? null : { note, atMs: Date.now() },
  });
  const activityRow = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-row="activity"]');

  it("is the story chat's layout and shows no activity row until asked", async () => {
    const s = setup([running("Cloning acme/api · 62%")]);
    mountOn(s);
    await flush();
    const col = s.el.querySelector(".chatcol")!;
    expect(col.className).toBe("chatcol");
    expect(col.hasAttribute("data-variant")).toBe(false);
    expect(activityRow(s.el)).toBeNull();
  });

  it("layout.variant 'page' marks the column for the page's own styling; another value changes nothing", async () => {
    const s = setup([lead("idle")]);
    mountOn(s, { layout: { variant: "page" } });
    await flush();
    const col = s.el.querySelector(".chatcol")!;
    expect(col.getAttribute("data-variant")).toBe("page");
    expect(col.classList.contains("page")).toBe(true);
    const other = setup([lead("idle")]);
    mountOn(other, { layout: { variant: "wide" } });
    await flush();
    expect(other.el.querySelector(".chatcol")!.className).toBe("chatcol");
    expect(other.el.querySelector(".chatcol")!.hasAttribute("data-variant")).toBe(false);
  });

  it("activity shows the working row with the peer's current step, and drops it when the peer is idle", async () => {
    const roster = [running("Cloning acme/api · 62%")];
    const s = setup(roster);
    mountOn(s, { activity: true });
    await flush();
    const row = activityRow(s.el)!;
    expect(row.getAttribute("role")).toBe("status");
    expect(row.textContent).toContain("Cloning acme/api · 62%");
    roster[0] = lead("idle");
    await s.reads.sessions();
    await flush();
    expect(activityRow(s.el)).toBeNull();
  });

  it("activity reads Working… when the peer reports no step", async () => {
    const s = setup([running()]);
    mountOn(s, { activity: true });
    await flush();
    expect(activityRow(s.el)!.textContent).toContain("Working…");
  });

  it("activity.text puts the page's own line in the row; an empty line falls back to the peer's step", async () => {
    const s = setup([running("Checking this Mac")]);
    let line: string | null = "Cloning acme/api · 62%";
    mountOn(s, { activity: { text: () => line } });
    await flush();
    expect(activityRow(s.el)!.textContent).toContain("Cloning acme/api · 62%");
    line = null;
    await s.reads.sessions();
    await flush();
    expect(activityRow(s.el)!.textContent).toContain("Checking this Mac");
  });

  it("the activity row sits after the thread and keeps its node while nothing about it changes", async () => {
    const s = setup(
      [running("Checking this Mac")],
      [{ messageId: 1, from: "lead-1", text: "hi", createdAtMs: 1 }],
    );
    mountOn(s, { activity: true });
    await flush();
    const row = activityRow(s.el)!;
    await s.reads.sessions();
    await flush();
    expect(activityRow(s.el)).toBe(row);
    expect(row.compareDocumentPosition(s.el.querySelector(".log .msg")!)).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    );
  });
});

describe("kit.chat suggestion chips from the Next line", () => {
  const reply = (id: number, text: string, from = "lead-1", at = id * 1000): Row => ({
    messageId: id,
    from,
    text,
    createdAtMs: at,
  });
  const chipsOf = (el: HTMLElement) =>
    [...el.querySelectorAll<HTMLElement>(".chips [data-chip]")].map((node) => node.dataset.chip);
  const bodies = (el: HTMLElement) =>
    [...el.querySelectorAll(".log .msg .body")].map((node) => node.textContent);
  const NEXT = "All set.\n\nNext: `Bring in my issues`, `What have you set up?`";

  it("is off by default: the Next line stays in the message and no chips appear", async () => {
    const s = setup([lead("idle")], [reply(1, NEXT)]);
    mountOn(s);
    await flush();
    expect(s.el.querySelector(".chips")).toBeNull();
    expect(bodies(s.el)).toEqual([NEXT]);
  });

  it("next: true turns the lead's newest Next line into chips and hides the line from the message", async () => {
    const s = setup([lead("idle")], [reply(1, NEXT)]);
    mountOn(s, { next: true });
    await flush();
    expect(chipsOf(s.el)).toEqual(["Bring in my issues", "What have you set up?"]);
    expect(bodies(s.el)).toEqual(["All set."]);
    expect(s.el.querySelector(".chips")!.getAttribute("role")).toBe("group");
    expect(s.el.querySelectorAll(".chips [data-chip-edit]").length).toBe(0);
  });

  it("a Next chip sends its text like a typed message, and the chips go once the person has sent", async () => {
    const s = setup([lead("idle")], [reply(1, NEXT)]);
    mountOn(s, { next: true });
    await flush();
    s.el.querySelector<HTMLButtonElement>('[data-chip="Bring in my issues"]')!.click();
    await flush();
    expect(s.send).toHaveBeenCalledWith("lead-1", "Bring in my issues");
    expect(chipsOf(s.el)).toEqual([]);
  });

  it("offers no chips when the lead's newest message has no Next line, or the person spoke last", async () => {
    const newer = setup([lead("idle")], [reply(1, NEXT), reply(2, "Working on it.")]);
    mountOn(newer, { next: true });
    await flush();
    expect(chipsOf(newer.el)).toEqual([]);
    const answered = setup([lead("idle")], [reply(1, NEXT), reply(2, "later", "human")]);
    mountOn(answered, { next: true });
    await flush();
    expect(chipsOf(answered.el)).toEqual([]);
  });

  it("a card is not chips: a needs-you message keeps its own buttons", async () => {
    const s = setup(
      [lead("idle")],
      [
        {
          ...reply(1, "Create your team?\nOptions: `Do it`, `Not now`.\nNext: `a`, `b`"),
          kind: "needs-you",
        },
      ],
    );
    mountOn(s, { next: true });
    await flush();
    expect(chipsOf(s.el)).toEqual([]);
  });

  it("static chips follow the Next chips, and a Next chip with the same label as a static one shows once", async () => {
    const s = setup([lead("idle")], [reply(1, NEXT)]);
    mountOn(s, {
      next: true,
      chips: [
        { label: "What have you set up?", text: "What have you set up?" },
        { label: "Status?", text: "What is the status?" },
      ],
    });
    await flush();
    expect(chipsOf(s.el)).toEqual(["Bring in my issues", "What have you set up?", "Status?"]);
  });

  describe("the edit pencil", () => {
    const pencil = (el: HTMLElement, label: string) =>
      el.querySelector<HTMLButtonElement>(`[data-chip-edit="${label}"]`);

    it("next: {edit: true} adds a pencil that puts the text in the composer and sends nothing", async () => {
      const s = setup([lead("idle")], [reply(1, NEXT)]);
      mountOn(s, { next: { edit: true } });
      await flush();
      const edit = pencil(s.el, "Bring in my issues")!;
      expect(edit.getAttribute("aria-label")).toBe("Edit “Bring in my issues” before sending");
      expect(edit.title).toBe("Edit before sending");
      edit.click();
      await flush();
      const input = s.el.querySelector<HTMLTextAreaElement>("#sv-composer-input")!;
      expect(input.value).toBe("Bring in my issues");
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(input.value.length);
      expect(s.send).not.toHaveBeenCalled();
      // The person edits, then sends it: the edited text goes, not the chip's.
      input.value += " from acme/web";
      s.el.querySelector<HTMLButtonElement>("#sv-send")!.click();
      await flush();
      expect(s.send).toHaveBeenCalledWith("lead-1", "Bring in my issues from acme/web");
    });

    it("a static chip takes a pencil with edit: true, and without it has none", async () => {
      const s = setup([lead("idle")]);
      mountOn(s, {
        chips: [
          { label: "Status?", text: "What is the status?", edit: true },
          { label: "Plain", text: "plain" },
        ],
      });
      await flush();
      expect(pencil(s.el, "Status?")).not.toBeNull();
      expect(pencil(s.el, "Plain")).toBeNull();
      pencil(s.el, "Status?")!.click();
      expect(s.el.querySelector<HTMLTextAreaElement>("#sv-composer-input")!.value).toBe(
        "What is the status?",
      );
    });

    it("the pencil does nothing once the chat is done", async () => {
      const s = setup([lead("idle")], [reply(1, NEXT)]);
      mountOn(s, { next: { edit: true }, done: true });
      await flush();
      pencil(s.el, "Bring in my issues")!.click();
      expect(s.el.querySelector<HTMLTextAreaElement>("#sv-composer-input")!.value).toBe("");
    });
  });
});
