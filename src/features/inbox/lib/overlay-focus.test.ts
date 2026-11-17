// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";

import { mayCoverTakeFocus } from "./overlay-focus";

/** Two cells of a grid: each a pane frame with a terminal's textarea and a chat. */
function cells(active: "a" | "b" | "both") {
  document.body.innerHTML = ["a", "b"]
    .map(
      (id) => `
      <div data-focus-pane="${id}" ${active === id || active === "both" ? "data-pane-active" : ""}>
        <div class="xterm"><textarea data-testid="term-${id}"></textarea></div>
        <aside data-testid="chat-${id}"><input data-testid="in-${id}" /></aside>
      </div>`,
    )
    .join("");
  const el = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  return { chat: (id: string) => el(`chat-${id}`), term: (id: string) => el(`term-${id}`) };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("a covering chat and keyboard focus", () => {
  it("takes the focus from the terminal it covers", () => {
    const { chat, term } = cells("a");
    term("a").focus();
    expect(mayCoverTakeFocus(chat("a"), document.activeElement)).toBe(true);
  });

  it("never takes the focus from another cell's terminal", () => {
    const { chat, term } = cells("both");
    term("b").focus();
    expect(mayCoverTakeFocus(chat("a"), document.activeElement)).toBe(false);
  });

  it("never takes the focus from an element outside the pane", () => {
    const { chat } = cells("a");
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    expect(mayCoverTakeFocus(chat("a"), document.activeElement)).toBe(false);
  });

  it("with nothing focused, only the active tab's chat takes it", () => {
    const { chat } = cells("a");
    expect(document.activeElement).toBe(document.body);
    expect(mayCoverTakeFocus(chat("a"), document.activeElement)).toBe(true);
    expect(mayCoverTakeFocus(chat("b"), document.activeElement)).toBe(false);
  });

  it("keeps the focus on the Chat | CLI switch while an arrow key flips the view", () => {
    const { chat } = cells("a");
    const sw = document.createElement("div");
    sw.setAttribute("data-keeps-focus", "");
    sw.innerHTML = '<button data-testid="seg"></button>';
    document.querySelector('[data-focus-pane="a"]')!.append(sw);
    sw.querySelector("button")!.focus();
    expect(mayCoverTakeFocus(chat("a"), document.activeElement)).toBe(false);
  });

  it("keeps the focus where it already is inside the chat", () => {
    const { chat } = cells("a");
    document.querySelector<HTMLElement>('[data-testid="in-a"]')!.focus();
    expect(mayCoverTakeFocus(chat("a"), document.activeElement)).toBe(true);
  });
});
