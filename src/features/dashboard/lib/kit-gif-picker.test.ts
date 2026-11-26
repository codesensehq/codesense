// SPDX-License-Identifier: MIT
/**
 * `kit.chat.gifPicker` and `kit.chat.gifStage` (/kit/v1/chat.js), driven the way the Inbox pane drives them: a fake `act`
 * (the bridge) answers gifProvider, gifSearch, gifPicked and setUiState, and the spy on it is the consent guard: no
 * gifSearch or gifPicked call goes out before the person allows the provider.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KIT = join(process.cwd(), "src-tauri/src/http/routes/dashboard_kit");
const CHAT_JS = readFileSync(join(KIT, "chat.js"), "utf8");
const CHAT_CSS = readFileSync(join(KIT, "chat.css"), "utf8");

type Row = Record<string, any>;
type Act = (verb: string, args?: Row) => Promise<any>;
interface Picker {
  root: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  destroy(): void;
}
interface Stage {
  root: HTMLElement;
  alt(): string;
  valid(): boolean;
  focusAlt(): void;
  media(): Row;
  remove(): void;
  clear(): void;
}
interface Chat {
  gifPicker(el: HTMLElement, options: Row): Picker;
  gifStage(el: HTMLElement, options: Row): Stage;
}
const chat = () => (window as unknown as { codesense: { kit: { chat: Chat } } }).codesense.kit.chat;

const candidate = (id: string, title = `GIF ${id}`, still = true): Row => ({
  provider: "giphy",
  id,
  title,
  url: `https://media.giphy.com/media/${id}/giphy.gif`,
  previewUrl: `https://media.giphy.com/media/${id}/giphy_s.gif`,
  width: 480,
  height: 270,
  autoLoads: false,
  ...(still ? { previewData: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" } : {}),
});

// The world the fake bridge answers from. `search` answers each gifSearch in turn (the last one repeats).
// `ui` is read with `in`, so `{ ui: undefined }` is a missing ui:gif rather than the allowed default.
function world(options: { provider?: string | Row; ui?: unknown; search?: Row[] } = {}) {
  const {
    provider = "giphy",
    search = [{ status: "ok", provider: "giphy", candidates: [candidate("a1"), candidate("a2")] }],
  } = options;
  const ui = "ui" in options ? options.ui : { consent: { giphy: true } };
  const state = { provider, ui, search: [...search] };
  const writes: Row[] = [];
  const act = vi.fn<Act>(async (verb, args = {}) => {
    if (verb === "gifProvider")
      return typeof state.provider === "string"
        ? { status: "ok", provider: state.provider }
        : state.provider;
    if (verb === "gifSearch")
      return state.search.length > 1 ? state.search.shift() : state.search[0];
    if (verb === "gifPicked") return { status: "ok" };
    if (verb === "setUiState") {
      writes.push(args);
      state.ui = { ...(state.ui as Row), ...(args.patch as Row) };
      return null;
    }
    throw new Error(`unexpected verb ${verb}`);
  });
  const uiState = vi.fn(async () => state.ui);
  const onStage = vi.fn();
  const onClose = vi.fn();
  const openSettings = vi.fn();
  const el = document.createElement("form");
  const anchor = document.createElement("button");
  el.append(anchor);
  document.body.append(el);
  const picker = chat().gifPicker(el, { act, uiState, onStage, onClose, openSettings, anchor });
  const calls = (verb: string) => act.mock.calls.filter(([v]) => v === verb);
  const $ = <T extends Element = HTMLElement>(selector: string) =>
    picker.root.querySelector<T & HTMLElement>(selector);
  const input = () => $<HTMLInputElement>(".gp-input")!;
  const type = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const text = () => picker.root.querySelector(".gp-body")!.textContent ?? "";
  const button = (label: string) =>
    [...picker.root.querySelectorAll<HTMLButtonElement>(".gp-body button")].find(
      (b) => b.textContent?.trim() === label,
    );
  return {
    state,
    writes,
    act,
    uiState,
    onStage,
    onClose,
    openSettings,
    el,
    anchor,
    picker,
    calls,
    $,
    input,
    type,
    text,
    button,
  };
}
const settle = () => vi.advanceTimersByTimeAsync(0);
const pause = () => vi.advanceTimersByTimeAsync(400);
const key = (target: Element, name: string) =>
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
  );

beforeEach(() => {
  vi.useFakeTimers();
  (window as unknown as { codesense: unknown }).codesense = { kit: {} };
  new Function(CHAT_JS)();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  document.head.querySelector("link[data-codesense-chat]")?.remove();
});

describe("kit.chat.gifPicker: open, search and pick", () => {
  it("opens with focus in the field, four starter chips and no search", async () => {
    const w = world();
    expect(w.picker.root.hidden).toBe(true);
    w.picker.open();
    await settle();
    expect(w.picker.root.hidden).toBe(false);
    expect(w.picker.root.getAttribute("role")).toBe("dialog");
    expect(w.anchor.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(w.input());
    expect([...w.picker.root.querySelectorAll(".gp-chip")].map((c) => c.textContent)).toEqual([
      "thumbs up",
      "thank you",
      "ship it",
      "on it",
    ]);
    expect(w.input().placeholder).toBe("Search GIPHY");
    expect(w.$(".gp-attr")!.textContent).toBe("Powered By GIPHY");
    expect(w.calls("gifSearch")).toHaveLength(0);
    expect(w.calls("gifProvider")).toHaveLength(1);
  });

  it("searches once, after two characters and a 400 ms pause, with the provider it asked consent for", async () => {
    const w = world();
    w.picker.open();
    await settle();
    w.type("s");
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.calls("gifSearch")).toHaveLength(0);
    w.type("sh");
    await vi.advanceTimersByTimeAsync(399);
    w.type("shi");
    await vi.advanceTimersByTimeAsync(399);
    w.type("ship");
    expect(w.calls("gifSearch")).toHaveLength(0);
    await pause();
    expect(w.calls("gifSearch")).toEqual([
      ["gifSearch", { query: "ship", limit: 10, provider: "giphy" }],
    ]);
  });

  it("shows skeleton cells while it searches, then the stills in a listbox", async () => {
    let answer!: (value: Row) => void;
    const w = world();
    w.act.mockImplementationOnce(async () => ({ status: "ok", provider: "giphy" }));
    w.picker.open();
    await settle();
    w.act.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    w.type("cat");
    await pause();
    expect(w.picker.root.querySelectorAll(".gp-cell.skel")).toHaveLength(10);
    expect(w.$(".gp-now")!.textContent).toBe("Searching GIPHY…");
    answer({
      status: "ok",
      provider: "giphy",
      candidates: [candidate("c1"), candidate("c2", "No still", false)],
    });
    await settle();
    const grid = w.$(".gp-grid[role=listbox]")!;
    expect(grid.tabIndex).toBe(0);
    const cells = grid.querySelectorAll("[role=option]");
    expect(cells).toHaveLength(2);
    expect(cells[0].querySelector("img")!.getAttribute("src")).toMatch(/^data:image\/gif/);
    // A still that is missing (or fails to draw) is an empty tile, never an error.
    expect(cells[1].classList.contains("failed")).toBe(true);
    expect(cells[1].querySelector("img")).toBeNull();
    cells[0].querySelector("img")!.dispatchEvent(new Event("error"));
    expect(cells[0].classList.contains("failed")).toBe(true);
  });

  it("drops a stale search's answer", async () => {
    const answers: Array<(value: Row) => void> = [];
    const w = world();
    w.picker.open();
    await settle();
    w.act.mockImplementation(async (verb) =>
      verb === "gifSearch" ? new Promise((resolve) => answers.push(resolve)) : { status: "ok" },
    );
    w.type("cat");
    await pause();
    w.type("dog");
    await pause();
    expect(answers).toHaveLength(2);
    answers[1]({ status: "ok", provider: "giphy", candidates: [candidate("dog1", "Dog")] });
    await settle();
    answers[0]({
      status: "ok",
      provider: "giphy",
      candidates: [candidate("cat1", "Cat"), candidate("cat2")],
    });
    await settle();
    expect(
      [...w.picker.root.querySelectorAll("[role=option]")].map((c) => c.getAttribute("aria-label")),
    ).toEqual(["Dog"]);
  });

  it("a starter chip fills the field and searches at once", async () => {
    const w = world();
    w.picker.open();
    await settle();
    w.button("ship it")!.click();
    await settle();
    expect(w.input().value).toBe("ship it");
    expect(w.calls("gifSearch")).toEqual([
      ["gifSearch", { query: "ship it", limit: 10, provider: "giphy" }],
    ]);
  });

  it("the grid is one Tab stop: the arrows move the ring, the footer names the GIF, Enter stages it", async () => {
    const titles = ["One", "Two", "Three", "Four", "Five"];
    const w = world({
      search: [
        {
          status: "ok",
          provider: "giphy",
          candidates: titles.map((t, i) => candidate(`g${i}`, t)),
        },
      ],
    });
    w.picker.open();
    await settle();
    w.type("count");
    await pause();
    const grid = w.$(".gp-grid")!;
    grid.focus();
    expect(grid.getAttribute("aria-activedescendant")).toBe(
      grid.querySelector("[role=option]")!.id,
    );
    expect(w.$(".gp-now")!.textContent).toBe("One · Enter add · Esc close");
    key(grid, "ArrowRight");
    key(grid, "ArrowDown");
    const active = () => grid.querySelector(`#${grid.getAttribute("aria-activedescendant")}`)!;
    expect(active().getAttribute("aria-label")).toBe("Five");
    expect(active().getAttribute("aria-selected")).toBe("true");
    key(grid, "ArrowDown");
    expect(active().getAttribute("aria-label")).toBe("Five");
    key(grid, "Home");
    expect(active().getAttribute("aria-label")).toBe("One");
    key(grid, "End");
    key(grid, "ArrowUp");
    expect(active().getAttribute("aria-label")).toBe("Two");
    expect(grid.querySelectorAll("button, a, [tabindex]").length).toBe(0);
    key(grid, "Enter");
    await settle();
    expect(w.onStage).toHaveBeenCalledTimes(1);
    expect(w.onStage.mock.calls[0][0]).toMatchObject({
      provider: "giphy",
      id: "g1",
      alt: "Two",
      title: "Two",
    });
    expect(w.calls("gifPicked")).toEqual([["gifPicked", { provider: "giphy", id: "g1" }]]);
    expect(w.picker.isOpen()).toBe(false);
    expect(w.onClose).toHaveBeenLastCalledWith("pick");
  });

  it("a click stages the GIF and calls gifPicked once per pick; hover names it in the footer", async () => {
    const w = world();
    w.picker.open();
    await settle();
    w.type("cat");
    await pause();
    const cell = w.picker.root.querySelectorAll<HTMLElement>("[role=option]")[1];
    cell.dispatchEvent(new MouseEvent("mouseenter"));
    expect(w.$(".gp-now")!.textContent).toBe("GIF a2 · click to add");
    cell.click();
    await settle();
    expect(w.calls("gifPicked")).toEqual([["gifPicked", { provider: "giphy", id: "a2" }]]);
    // Picking again is another pick.
    w.picker.open();
    await settle();
    w.type("cat");
    await pause();
    w.picker.root.querySelector<HTMLElement>("[role=option]")!.click();
    await settle();
    expect(w.calls("gifPicked")).toHaveLength(2);
    expect(w.onStage).toHaveBeenCalledTimes(2);
  });

  it("Esc, × and a click outside close it and say why; a click on its own button does not count as outside", async () => {
    const w = world();
    w.picker.open();
    await settle();
    key(w.input(), "Escape");
    expect(w.picker.isOpen()).toBe(false);
    expect(w.onClose).toHaveBeenLastCalledWith("escape");
    expect(w.anchor.getAttribute("aria-expanded")).toBe("false");
    w.picker.open();
    await settle();
    w.$(".gp-close")!.click();
    expect(w.onClose).toHaveBeenLastCalledWith("close");
    w.picker.open();
    await settle();
    w.anchor.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(w.picker.isOpen()).toBe(true);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(w.picker.isOpen()).toBe(false);
    expect(w.onClose).toHaveBeenLastCalledWith("outside");
  });

  it("an answer that lands after it closed paints nothing and searches nothing", async () => {
    const w = world();
    w.picker.open();
    await settle();
    w.type("cat");
    w.picker.close();
    await pause();
    expect(w.calls("gifSearch")).toHaveLength(0);
  });
});

describe("kit.chat.gifPicker: consent", () => {
  it("asks before any keystroke, with Allow search focused, and sends nothing before Allow", async () => {
    const w = world({ ui: undefined });
    w.picker.open();
    await settle();
    expect(w.text()).toContain("Search GIFs with GIPHY?");
    expect(document.activeElement).toBe(w.button("Allow search"));
    expect(w.input().disabled).toBe(true);
    w.type("cats");
    await pause();
    w.$<HTMLInputElement>(".gp-input")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await pause();
    expect(w.calls("gifSearch")).toHaveLength(0);
    expect(w.calls("gifPicked")).toHaveLength(0);
    w.button("Allow search")!.click();
    await settle();
    expect(w.writes).toEqual([{ topic: "ui:gif", patch: { consent: { giphy: true } } }]);
    expect(w.input().disabled).toBe(false);
    expect(document.activeElement).toBe(w.input());
    w.type("cats");
    await pause();
    expect(w.calls("gifSearch")).toHaveLength(1);
  });

  it("Not now writes nothing, closes, and the next open asks again", async () => {
    const w = world({ ui: {} });
    w.picker.open();
    await settle();
    w.button("Not now")!.click();
    expect(w.picker.isOpen()).toBe(false);
    expect(w.onClose).toHaveBeenLastCalledWith("notNow");
    expect(w.writes).toEqual([]);
    w.picker.open();
    await settle();
    expect(w.text()).toContain("Search GIFs with GIPHY?");
    expect(w.calls("gifSearch")).toHaveLength(0);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["a string", "yes"],
    ["consent as an array", { consent: ["giphy"] }],
    ["a truthy non-true value", { consent: { giphy: "true" } }],
    ["another provider only", { consent: { klipy: true } }],
  ])("a %s ui:gif counts as not allowed", async (_name, ui) => {
    const w = world({ ui });
    w.picker.open();
    await settle();
    expect(w.text()).toContain("Search GIFs with GIPHY?");
    expect(w.input().disabled).toBe(true);
  });

  it("an unreadable ui:gif counts as not allowed", async () => {
    const w = world();
    w.uiState.mockRejectedValue(new Error("unavailable"));
    w.picker.open();
    await settle();
    expect(w.text()).toContain("Search GIFs with GIPHY?");
  });

  it("Allow keeps the other provider's answer: it reads the current map and writes it back whole", async () => {
    const w = world({ provider: "klipy", ui: { consent: { giphy: true }, other: 1 } });
    w.picker.open();
    await settle();
    expect(w.text()).toContain("Search GIFs with KLIPY?");
    expect(w.input().placeholder).toBe("Search KLIPY");
    expect(w.$(".gp-attr")!.textContent).toBe("Powered by KLIPY");
    // Another window allowed nothing new, but the map is read again at Allow.
    w.state.ui = { consent: { giphy: true } };
    w.button("Allow search")!.click();
    await settle();
    expect(w.uiState).toHaveBeenCalledTimes(2);
    expect(w.writes).toEqual([
      { topic: "ui:gif", patch: { consent: { giphy: true, klipy: true } } },
    ]);
  });

  it("when Settings switches the provider while it is open, the mismatch re-reads the provider and asks again", async () => {
    const w = world({
      search: [
        {
          status: "error",
          error: "badQuery",
          message: "Bad GIF search input: provider is not the active GIF provider.",
        },
      ],
    });
    w.picker.open();
    await settle();
    w.state.provider = "klipy";
    w.type("cat");
    await pause();
    expect(w.calls("gifSearch")).toEqual([
      ["gifSearch", { query: "cat", limit: 10, provider: "giphy" }],
    ]);
    expect(w.calls("gifProvider")).toHaveLength(2);
    expect(w.text()).toContain("Search GIFs with KLIPY?");
    expect(w.input().disabled).toBe(true);
    w.button("Allow search")!.click();
    await settle();
    w.state.search = [{ status: "ok", provider: "klipy", candidates: [candidate("k1")] }];
    w.type("cat");
    await pause();
    expect(w.calls("gifSearch").at(-1)).toEqual([
      "gifSearch",
      { query: "cat", limit: 10, provider: "klipy" },
    ]);
  });

  it("a switch to a provider already allowed searches it again at once", async () => {
    const w = world({
      ui: { consent: { giphy: true, klipy: true } },
      search: [
        { status: "error", error: "badQuery", message: "mismatch" },
        { status: "ok", provider: "klipy", candidates: [candidate("k1", "Klipy cat")] },
      ],
    });
    w.picker.open();
    await settle();
    w.state.provider = "klipy";
    w.type("cat");
    await pause();
    await settle();
    expect(w.calls("gifSearch").map(([, a]) => a!.provider)).toEqual(["giphy", "klipy"]);
    expect(w.picker.root.querySelector("[role=option]")!.getAttribute("aria-label")).toBe(
      "Klipy cat",
    );
  });
});

describe("kit.chat.gifPicker: states", () => {
  const opened = async (options: Parameters<typeof world>[0]) => {
    const w = world(options);
    w.picker.open();
    await settle();
    return w;
  };
  const failing = (error: string, extra: Row = {}) => ({
    search: [{ status: "error", error, message: `host says ${error}`, ...extra }],
  });
  // Typing in an inert state sends nothing.
  const typeAndWait = async (w: ReturnType<typeof world>, text: string) => {
    w.type(text);
    await pause();
    await settle();
  };

  it("noProvider from the provider read: Open Settings, the field inert, no search; the next open reads again", async () => {
    const w = await opened({ provider: { status: "error", error: "noProvider", message: "off" } });
    expect(w.text()).toContain("Turn on GIF search and add a key");
    expect(w.text()).toContain("Settings › Messaging › GIF search");
    expect(w.input().disabled).toBe(true);
    w.button("Open Settings")!.click();
    expect(w.openSettings).toHaveBeenCalledTimes(1);
    await typeAndWait(w, "cats");
    expect(w.calls("gifSearch")).toHaveLength(0);
    w.picker.close();
    w.state.provider = "giphy";
    w.picker.open();
    await settle();
    expect(w.calls("gifProvider")).toHaveLength(2);
    expect(w.input().disabled).toBe(false);
  });

  it("noProvider from a search (no key): Open Settings and the field stays inert", async () => {
    const w = await opened(failing("noProvider"));
    await typeAndWait(w, "cats");
    expect(w.text()).toContain("Turn on GIF search and add a key");
    expect(w.button("Open Settings")).toBeDefined();
    await typeAndWait(w, "dogs");
    expect(w.calls("gifSearch")).toHaveLength(1);
  });

  it("invalidKey: the key was refused, with Open Settings, and typing sends nothing", async () => {
    const w = await opened(failing("invalidKey"));
    await typeAndWait(w, "cats");
    expect(w.text()).toContain("The key was refused");
    expect(w.text()).toContain("GIPHY didn't accept the key");
    expect(w.button("Open Settings")).toBeDefined();
    await typeAndWait(w, "dogs");
    expect(w.calls("gifSearch")).toHaveLength(1);
  });

  it("mediaOff: the team's media is off, with no action, from the provider read before any search", async () => {
    const w = await opened({ provider: { status: "error", error: "mediaOff", message: "off" } });
    expect(w.text()).toContain("GIFs are off for this team");
    expect(w.text()).toContain("media.remote: off");
    expect(w.picker.root.querySelectorAll(".gp-body button")).toHaveLength(0);
    await typeAndWait(w, "cats");
    expect(w.calls("gifSearch")).toHaveLength(0);
  });

  it("keychainUnavailable names the provider whose key it couldn't read", async () => {
    const w = await opened({
      provider: "klipy",
      ui: { consent: { klipy: true } },
      search: [{ status: "error", error: "keychainUnavailable", message: "locked" }],
    });
    await typeAndWait(w, "cats");
    expect(w.text()).toContain("Couldn't read your KLIPY key");
  });

  it("keychainUnavailable: Try again once; a second failure keeps the message with no button", async () => {
    const w = await opened(failing("keychainUnavailable"));
    await typeAndWait(w, "cats");
    expect(w.text()).toContain("Couldn't read your GIPHY key");
    expect(w.input().disabled).toBe(true);
    await typeAndWait(w, "dogs");
    expect(w.calls("gifSearch")).toHaveLength(1);
    w.button("Try again")!.click();
    await settle();
    expect(w.calls("gifSearch")).toEqual([
      ["gifSearch", { query: "cats", limit: 10, provider: "giphy" }],
      ["gifSearch", { query: "cats", limit: 10, provider: "giphy" }],
    ]);
    expect(w.text()).toContain("Couldn't read your GIPHY key");
    expect(w.button("Try again")).toBeUndefined();
    await typeAndWait(w, "birds");
    expect(w.calls("gifSearch")).toHaveLength(2);
  });

  it("rateLimited: shows the wait from retryAfter, no retry button, and the field wakes when it ends", async () => {
    const w = await opened(failing("rateLimited", { retryAfter: 720 }));
    await typeAndWait(w, "cats");
    expect(w.text()).toContain("GIF search limit reached");
    expect(w.text()).toContain("Try again in 12 min.");
    expect(w.picker.root.querySelectorAll(".gp-body button")).toHaveLength(0);
    await typeAndWait(w, "dogs");
    expect(w.calls("gifSearch")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(720_000);
    expect(w.input().disabled).toBe(false);
    w.state.search = [{ status: "ok", provider: "giphy", candidates: [candidate("a1")] }];
    await typeAndWait(w, "birds");
    expect(w.calls("gifSearch")).toHaveLength(2);
  });

  it("rateLimited: a short wait reads in seconds", async () => {
    const w = await opened(failing("rateLimited", { retryAfter: 42 }));
    await typeAndWait(w, "cats");
    expect(w.text()).toContain("Try again in 42 s.");
  });

  describe("an inert state outlives a close", () => {
    const reopen = async (w: ReturnType<typeof world>) => {
      w.picker.close();
      w.picker.open();
      await settle();
    };

    it("invalidKey: a reopen shows the refusal again and sends nothing until Open Settings", async () => {
      const w = await opened(failing("invalidKey"));
      await typeAndWait(w, "cats");
      await reopen(w);
      expect(w.text()).toContain("The key was refused");
      expect(w.input().disabled).toBe(true);
      expect(w.input().value).toBe("cats");
      await typeAndWait(w, "dogs");
      expect(w.calls("gifSearch")).toHaveLength(1);
      w.button("Open Settings")!.click();
      w.state.search = [{ status: "ok", provider: "giphy", candidates: [candidate("a1")] }];
      await reopen(w);
      expect(w.input().disabled).toBe(false);
      await typeAndWait(w, "birds");
      expect(w.calls("gifSearch")).toHaveLength(2);
    });

    it("keychainUnavailable: a reopen keeps a used Try again used", async () => {
      const w = await opened(failing("keychainUnavailable"));
      await typeAndWait(w, "cats");
      await reopen(w);
      expect(w.text()).toContain("Couldn't read your GIPHY key");
      w.button("Try again")!.click();
      await settle();
      expect(w.calls("gifSearch")).toHaveLength(2);
      await reopen(w);
      expect(w.text()).toContain("Couldn't read your GIPHY key");
      expect(w.button("Try again")).toBeUndefined();
      await typeAndWait(w, "dogs");
      expect(w.calls("gifSearch")).toHaveLength(2);
    });

    it("rateLimited: a reopen shows the rest of the wait, and one after it ends searches", async () => {
      const w = await opened(failing("rateLimited", { retryAfter: 720 }));
      await typeAndWait(w, "cats");
      w.picker.close();
      await vi.advanceTimersByTimeAsync(360_000);
      w.picker.open();
      await settle();
      expect(w.text()).toContain("Try again in 6 min.");
      await typeAndWait(w, "dogs");
      expect(w.calls("gifSearch")).toHaveLength(1);
      w.picker.close();
      await vi.advanceTimersByTimeAsync(360_000);
      w.state.search = [{ status: "ok", provider: "giphy", candidates: [candidate("a1")] }];
      w.picker.open();
      await settle();
      expect(w.input().disabled).toBe(false);
      await typeAndWait(w, "birds");
      expect(w.calls("gifSearch")).toHaveLength(2);
    });

    it("a different provider from Settings releases it", async () => {
      const w = await opened({
        ...failing("invalidKey"),
        ui: { consent: { giphy: true, klipy: true } },
      });
      await typeAndWait(w, "cats");
      w.state.provider = "klipy";
      w.state.search = [{ status: "ok", provider: "klipy", candidates: [candidate("k1")] }];
      await reopen(w);
      expect(w.input().disabled).toBe(false);
      await typeAndWait(w, "birds");
      expect(w.calls("gifSearch").at(-1)![1]).toMatchObject({ query: "birds", provider: "klipy" });
    });
  });

  it("providerUnavailable: the draft is safe, Try again once, and typing goes on", async () => {
    const w = await opened(failing("providerUnavailable"));
    await typeAndWait(w, "cats");
    expect(w.text()).toContain("GIPHY isn't answering");
    expect(w.text()).toContain("Your message is safe");
    w.button("Try again")!.click();
    await settle();
    expect(w.calls("gifSearch")).toHaveLength(2);
    expect(w.button("Try again")).toBeUndefined();
    await typeAndWait(w, "dogs");
    expect(w.calls("gifSearch")).toHaveLength(3);
  });

  it("badQuery with the same provider: Try different words, and typing goes on", async () => {
    const w = await opened(failing("badQuery"));
    await typeAndWait(w, "cats");
    expect(w.calls("gifProvider")).toHaveLength(2);
    expect(w.text()).toContain("Try different words");
    expect(w.input().disabled).toBe(false);
    await typeAndWait(w, "dogs");
    expect(w.calls("gifSearch")).toHaveLength(2);
  });

  it("no results: No GIFs for the query, the chips, and typing goes on", async () => {
    const w = await opened({ search: [{ status: "ok", provider: "giphy", candidates: [] }] });
    await typeAndWait(w, "shipit deploy friday");
    expect(w.text()).toContain("No GIFs for “shipit deploy friday”");
    expect(w.text()).toContain("Try fewer or different words.");
    expect(w.picker.root.querySelectorAll(".gp-body .gp-chip")).toHaveLength(4);
    await typeAndWait(w, "ship");
    expect(w.calls("gifSearch")).toHaveLength(2);
  });

  it("a refused call shows its reason, and typing goes on", async () => {
    const w = await opened({});
    w.act.mockImplementation(async (verb) => {
      if (verb === "gifSearch") throw new Error("denied: gifSearch requires the Inbox pane");
      return { status: "ok", provider: "giphy" };
    });
    await typeAndWait(w, "cats");
    expect(w.text()).toContain("denied: gifSearch requires the Inbox pane");
    expect(w.input().disabled).toBe(false);
  });

  it("without openSettings, the states name the Settings path with no button", async () => {
    const act = vi.fn<Act>(async () => ({ status: "error", error: "noProvider", message: "off" }));
    const el = document.createElement("div");
    document.body.append(el);
    const picker = chat().gifPicker(el, { act, uiState: {} });
    picker.open();
    await settle();
    expect(picker.root.textContent).toContain("Settings › Messaging › GIF search");
    expect(picker.root.querySelectorAll(".gp-body button")).toHaveLength(0);
  });

  it("never puts a key in the page: a key-shaped field in an answer reaches neither the DOM, a later verb nor the pick", async () => {
    const KEY = "FAKE".repeat(8);
    const w = await opened({
      provider: { status: "ok", provider: "giphy", apiKey: KEY, key: KEY },
      search: [
        {
          status: "ok",
          provider: "giphy",
          apiKey: KEY,
          candidates: [{ ...candidate("a1"), apiKey: KEY, key: KEY, api_key: KEY }],
        },
      ],
    });
    await typeAndWait(w, "cats");
    expect(document.documentElement.outerHTML).not.toContain(KEY);
    w.$(".gp-grid [role=option]")!.click();
    await settle();
    expect(w.calls("gifPicked")).toHaveLength(1);
    for (const [verb, args] of w.act.mock.calls)
      expect(JSON.stringify([verb, args])).not.toContain(KEY);
    const [pick] = w.onStage.mock.calls[0];
    expect(JSON.stringify(pick)).not.toContain(KEY);
    const box = document.createElement("div");
    document.body.append(box);
    const stage = chat().gifStage(box, { pick });
    expect(document.documentElement.outerHTML).not.toContain(KEY);
    expect(JSON.stringify(stage.media())).not.toContain(KEY);
  });
});

describe("kit.chat.gifStage", () => {
  const pick = {
    provider: "giphy",
    id: "a1",
    url: "https://media.giphy.com/media/a1/giphy.gif",
    title: "Ship It Dog",
    alt: "Ship It Dog",
    previewData: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
  };
  const staged = (extra: Row = {}) => {
    const box = document.createElement("div");
    const draft = document.createElement("textarea");
    box.append(draft);
    document.body.append(box);
    const onRemove = vi.fn();
    const onChange = vi.fn();
    const onEnter = vi.fn();
    const stage = chat().gifStage(box, { pick, onRemove, onChange, onEnter, ...extra });
    const alt = stage.root.querySelector<HTMLInputElement>(".gs-in")!;
    const edit = (value: string) => {
      alt.value = value;
      alt.dispatchEvent(new Event("input", { bubbles: true }));
    };
    return { box, draft, stage, alt, edit, onRemove, onChange, onEnter };
  };

  it("sits first in the box, above the text, with the still, the attribution and the title as alt text, selected", () => {
    const s = staged();
    expect(s.box.firstElementChild).toBe(s.stage.root);
    expect(s.stage.root.querySelector(".gs-thumb img")!.getAttribute("src")).toBe(pick.previewData);
    expect(s.stage.root.querySelector(".gs-attr")!.textContent).toBe("Powered By GIPHY");
    s.stage.focusAlt();
    expect(document.activeElement).toBe(s.alt);
    expect(s.alt.value.slice(s.alt.selectionStart!, s.alt.selectionEnd!)).toBe("Ship It Dog");
    expect(s.stage.valid()).toBe(true);
    expect(s.stage.media()).toEqual({
      url: pick.url,
      alt: "Ship It Dog",
      provider: "giphy",
      providerId: "a1",
    });
  });

  it.each([
    ["a provider URL", "https://media.giphy.com/media/a1/giphy_s.gif"],
    ["a protocol-relative URL", "//media.giphy.com/media/a1/giphy_s.gif"],
    ["a non-image data: URL", "data:text/html,<b>hi</b>"],
    ["no still", undefined],
  ])(
    "draws only a data:image/ still: %s is the empty icon, with no <img>",
    (_label, previewData) => {
      const s = staged({ pick: { ...pick, previewData } });
      expect(s.stage.root.querySelector("img")).toBeNull();
      expect(s.stage.root.querySelector(".gs-thumb svg.gp-i")).not.toBeNull();
      expect(s.stage.valid()).toBe(true);
    },
  );

  it("requires alt text: empty, the field is red, says why, and valid() is false", () => {
    const s = staged();
    s.edit("   ");
    expect(s.stage.valid()).toBe(false);
    expect(s.onChange).toHaveBeenLastCalledWith(false);
    expect(s.alt.classList.contains("err")).toBe(true);
    expect(s.alt.getAttribute("aria-invalid")).toBe("true");
    const help = document.getElementById(s.alt.getAttribute("aria-describedby")!)!;
    expect(help.textContent).toBe("Add alt text to send. Agents only see this text.");
    s.edit("A dog ships it");
    expect(s.stage.valid()).toBe(true);
    expect(s.onChange).toHaveBeenLastCalledWith(true);
    expect(s.alt.hasAttribute("aria-invalid")).toBe(false);
    expect(s.stage.media().alt).toBe("A dog ships it");
  });

  it("Enter in the alt field moves to the message and never sends", () => {
    const s = staged();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    s.alt.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(s.onEnter).toHaveBeenCalledTimes(1);
  });

  it("× or Backspace on the thumbnail unstages it", () => {
    const a = staged();
    a.stage.root.querySelector<HTMLButtonElement>(".gs-x")!.click();
    expect(a.onRemove).toHaveBeenCalledTimes(1);
    expect(a.box.querySelector(".gs")).toBeNull();
    const b = staged();
    const thumb = b.stage.root.querySelector<HTMLElement>(".gs-thumb")!;
    expect(thumb.tabIndex).toBe(0);
    key(thumb, "Backspace");
    expect(b.onRemove).toHaveBeenCalledTimes(1);
    expect(b.box.querySelector(".gs")).toBeNull();
    // Backspace in the alt field edits the text.
    const c = staged();
    key(c.alt, "Backspace");
    expect(c.onRemove).not.toHaveBeenCalled();
  });

  it("clear() after a send removes it without onRemove", () => {
    const s = staged();
    s.stage.clear();
    expect(s.box.querySelector(".gs")).toBeNull();
    expect(s.onRemove).not.toHaveBeenCalled();
  });

  it("names KLIPY's attribution for a KLIPY pick", () => {
    const s = staged({ pick: { ...pick, provider: "klipy" } });
    expect(s.stage.root.querySelector(".gs-attr")!.textContent).toBe("Powered by KLIPY");
    expect(s.stage.root.textContent).toContain("From KLIPY's title.");
  });
});

describe("kit.chat GIFs and Reduce Motion", () => {
  it("nothing in the picker or the stage moves: no animation or transition in the .cs-gif rules", () => {
    const rules = CHAT_CSS.split("}").filter((rule) => rule.includes(".cs-gif"));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule).not.toMatch(/animation|transition/);
  });

  it.each([
    ["on", true],
    ["off", false],
  ])(
    "with Reduce Motion %s, the stage shows the still, never the animated URL, and has no play button",
    (_name, reduce) => {
      const matchMedia = vi.fn((query: string) => ({
        matches: query.includes("prefers-reduced-motion") ? reduce : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
      vi.stubGlobal("matchMedia", matchMedia);
      try {
        const box = document.createElement("div");
        document.body.append(box);
        const url = "https://media.giphy.com/media/a1/giphy.gif";
        const still = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
        const stage = chat().gifStage(box, {
          pick: { provider: "giphy", id: "a1", url, title: "T", alt: "T", previewData: still },
        });
        const thumb = stage.root.querySelector(".gs-thumb")!;
        expect([...thumb.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
          still,
        ]);
        expect(thumb.innerHTML).not.toContain("giphy.gif");
        // The only button is ×: no play button, and nothing to start motion.
        expect([...stage.root.querySelectorAll("button")].map((b) => b.className)).toEqual([
          "gs-x",
        ]);
        thumb.dispatchEvent(new MouseEvent("mouseenter"));
        (thumb as HTMLElement).focus();
        expect(thumb.querySelector("img")!.getAttribute("src")).toBe(still);
        // Without a still, an empty tile.
        const bare = chat().gifStage(box, {
          pick: { provider: "giphy", id: "a2", url, title: "T", alt: "T" },
        });
        expect(bare.root.querySelector("img")).toBeNull();
        expect(bare.root.querySelector(".gs-thumb")!.innerHTML).not.toContain("giphy.gif");
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});
