// SPDX-License-Identifier: MIT
/**
 * A `ResizeObserver` stand-in for jsdom (which does no layout): every observed
 * element reports `width`, and `setWidth` re-reports a new width to all of
 * them. Install it before rendering and restore it after.
 */
export function stubResizeObserver(initialWidth: number) {
  let width = initialWidth;
  const live = new Set<{ cb: ResizeObserverCallback; el: Element; ro: ResizeObserver }>();
  const original = globalThis.ResizeObserver;

  const report = (entry: { cb: ResizeObserverCallback; el: Element; ro: ResizeObserver }) =>
    entry.cb(
      [{ target: entry.el, contentRect: { width } as DOMRectReadOnly } as ResizeObserverEntry],
      entry.ro,
    );

  class StubResizeObserver {
    private entries: { cb: ResizeObserverCallback; el: Element; ro: ResizeObserver }[] = [];
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element) {
      const entry = { cb: this.cb, el, ro: this as unknown as ResizeObserver };
      this.entries.push(entry);
      live.add(entry);
      report(entry);
    }
    unobserve() {}
    disconnect() {
      for (const entry of this.entries) live.delete(entry);
      this.entries = [];
    }
  }
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;

  return {
    setWidth(next: number) {
      width = next;
      for (const entry of live) report(entry);
    },
    restore() {
      globalThis.ResizeObserver = original;
    },
  };
}
