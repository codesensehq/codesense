// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useStickToBottom } from "./use-stick-to-bottom";

describe("useStickToBottom", () => {
  const observers: { cb: () => void; targets: Element[] }[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets: Element[] = [];
      constructor(public cb: () => void) {
        observers.push(this);
      }
      observe(el: Element) {
        this.targets.push(el);
      }
      disconnect() {}
    },
  );
  afterEach(() => void (observers.length = 0));

  function scroller(height: { value: number }) {
    const el = document.createElement("div");
    el.appendChild(document.createElement("div"));
    Object.defineProperty(el, "scrollHeight", { get: () => height.value });
    Object.defineProperty(el, "clientHeight", { get: () => 100 });
    return el;
  }

  it("follows content that grows after layout (an HTML message drawn late) while pinned", () => {
    const height = { value: 300 };
    const el = scroller(height);
    renderHook(() => useStickToBottom({ current: el }, "t1", 1));
    expect(el.scrollTop).toBe(300);
    height.value = 900;
    const ro = observers.at(-1)!;
    expect(ro.targets).toContain(el.firstElementChild);
    ro.cb();
    expect(el.scrollTop).toBe(900);
  });

  it("stays at the bottom when the list's own box resizes (a popup dragged smaller)", () => {
    const height = { value: 300 };
    const el = scroller(height);
    renderHook(() => useStickToBottom({ current: el }, "t1", 1));
    const ro = observers.at(-1)!;
    expect(ro.targets).toContain(el);
    // The box got shorter: the same content now scrolls further.
    height.value = 340;
    ro.cb();
    expect(el.scrollTop).toBe(340);
  });

  it("stays pinned when a layout change fires a scroll event without the reader moving (cards drawn above a reopened list)", () => {
    const height = { value: 300 };
    const el = scroller(height);
    renderHook(() => useStickToBottom({ current: el }, "t1", 1));
    expect(el.scrollTop).toBe(300);
    // The box above the list grew and the list got shorter: the browser fires a scroll event
    // with scrollTop unchanged, now well past "near the bottom", before the resize settles it.
    height.value = 478;
    el.dispatchEvent(new Event("scroll"));
    observers.at(-1)!.cb();
    expect(el.scrollTop).toBe(478);
  });

  it("unpins a reader who scrolls up in 1 px steps (a slow trackpad), so new content doesn't pull them back", () => {
    const height = { value: 900 };
    const el = scroller(height);
    renderHook(() => useStickToBottom({ current: el }, "t1", 1));
    // The browser clamps the pinned list to its last screenful.
    el.scrollTop = 800;
    el.dispatchEvent(new Event("scroll"));
    for (let i = 0; i < 60; i++) {
      el.scrollTop -= 1;
      el.dispatchEvent(new Event("scroll"));
    }
    height.value = 1200;
    observers.at(-1)!.cb();
    expect(el.scrollTop).toBe(740);
  });

  it("leaves a reader who scrolled up where they are when content grows", () => {
    const height = { value: 300 };
    const el = scroller(height);
    renderHook(() => useStickToBottom({ current: el }, "t1", 1));
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
    height.value = 900;
    observers.at(-1)!.cb();
    expect(el.scrollTop).toBe(0);
  });

  it("says when the reader is away from the bottom, and jumps back to it", () => {
    const height = { value: 900 };
    const el = scroller(height);
    const { result } = renderHook(() => useStickToBottom({ current: el }, "t1", 1));
    expect(result.current.away).toBe(false);
    act(() => {
      el.scrollTop = 100;
      el.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.away).toBe(true);
    act(() => result.current.jump());
    act(() => void el.dispatchEvent(new Event("scroll")));
    expect(el.scrollTop).toBe(900);
    expect(result.current.away).toBe(false);
    // Pinned again: content that grows keeps it at the bottom.
    height.value = 1200;
    observers.at(-1)!.cb();
    expect(el.scrollTop).toBe(1200);
  });
});
