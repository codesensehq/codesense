// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@/test-utils";

import { MiddleTruncate } from "./middle-truncate";

describe("MiddleTruncate", () => {
  it("keeps the space at the head/tail seam (no 'Notificationstriage')", () => {
    render(<MiddleTruncate data-testid="mt" text="Notifications triage" />);
    const root = screen.getByTestId("mt");
    expect(root.textContent).toBe("Notifications triage");
    const head = root.firstElementChild as HTMLElement;
    expect(head.textContent).toBe("Notifications ");
    // `nowrap` would collapse that trailing space when rendered; `pre` keeps it.
    expect(head.className).toContain("whitespace-pre");
    expect(head.className).not.toMatch(/\btruncate\b/);
  });
});

describe("MiddleTruncate in a slot squeezed shut", () => {
  const realRO = globalThis.ResizeObserver;
  const realRect = HTMLElement.prototype.getBoundingClientRect;
  let notify: (width: number) => void = () => {};
  beforeEach(() => {
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        notify = (width) =>
          cb(
            [{ contentRect: { width } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    HTMLElement.prototype.getBoundingClientRect = () => ({ width: 120 }) as DOMRect;
  });
  afterEach(() => {
    globalThis.ResizeObserver = realRO;
    HTMLElement.prototype.getBoundingClientRect = realRect;
  });

  it("drops the tail once the width falls to 0, and brings it back with room", () => {
    render(<MiddleTruncate data-testid="mt" text="Login timeout lead for the team" />);
    expect(screen.getByTestId("mt").children).toHaveLength(2);
    act(() => notify(0));
    const root = screen.getByTestId("mt");
    expect(root.children).toHaveLength(0);
    expect(root.className).toMatch(/\btruncate\b/);
    expect(root.textContent).toBe("Login timeout lead for the team");
    act(() => notify(120));
    expect(screen.getByTestId("mt").children).toHaveLength(2);
  });
});
