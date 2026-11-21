// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The hosted toolkit names the owner's computer with the noun the host wrote in the page's
// codesense:owner-machine meta (CS.ownerMachine), and says "Mac" when there is none.

const SOURCE = readFileSync(
  join(process.cwd(), "src-tauri/src/dashboard_publish/toolkit/cs-live.js"),
  "utf8",
);

type Toolkit = {
  ownerMachine: () => string;
  watchTerminal: (handle: string, element: HTMLElement) => { dispose: () => void };
};

const win = window as unknown as Record<string, unknown>;
let posted: Record<string, unknown>[] = [];
let shell: object = {};

function setOwnerMachine(content: string | null) {
  document.head
    .querySelectorAll('meta[name="codesense:owner-machine"]')
    .forEach((meta) => meta.remove());
  if (content === null) return;
  const meta = document.createElement("meta");
  meta.setAttribute("name", "codesense:owner-machine");
  meta.setAttribute("content", content);
  document.head.appendChild(meta);
}

// Just enough of xterm.js for watchTerminal: every method is a no-op that returns a disposable.
function FakeTerminal() {
  const noop = () => ({ dispose() {} });
  const buffer = {
    active: { baseY: 0, viewportY: 0, length: 0, cursorY: 0, getLine: () => undefined },
    onBufferChange: noop,
  };
  return new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === "buffer") return buffer;
        if (key === "modes") return {};
        if (key === "cols") return 80;
        if (key === "rows") return 24;
        if (key === "element" || key === "then") return undefined;
        return noop;
      },
    },
  );
}

function loadToolkit(): Toolkit {
  return new Function(`${SOURCE}\nreturn CS;`)() as Toolkit;
}

// A terminal watched to the given frame: the note line's text afterwards.
function noteAfter(CS: Toolkit, frame: Record<string, unknown>): string {
  const element = document.createElement("div");
  document.body.appendChild(element);
  CS.watchTerminal("h1", element);
  const watch = posted.filter((m) => m.op === "watch").pop()!;
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { cs: "live", v: 1, wid: watch.wid, ...frame },
      source: shell as Window,
    }),
  );
  return element.querySelector(".cs-term-note")!.textContent ?? "";
}

const PAUSED = { op: "paused", reason: "mac_offline" };
const FAILED = { op: "ended", reason: "failed" };
const BUSY = { op: "ended", reason: "busy" };
const MAIN = {
  paused: "The owner's Mac is offline. The terminal goes on when it is back.",
  failed: "The owner's Mac could not keep this terminal open; trying again shortly.",
  busy: "The owner's Mac is watching too many terminals right now; trying again shortly.",
};

beforeEach(() => {
  vi.useFakeTimers();
  posted = [];
  shell = {};
  Object.defineProperty(window, "parent", { value: shell, configurable: true });
  vi.spyOn(window, "postMessage").mockImplementation(((msg: Record<string, unknown>) => {
    posted.push(msg);
  }) as typeof window.postMessage);
  win.Terminal = FakeTerminal;
  // One core per page: each case starts from a fresh one unless it says otherwise.
  delete win.__csKitCore;
});
afterEach(() => {
  setOwnerMachine(null);
  document.body.replaceChildren();
  delete win.Terminal;
  delete win.__csKitCore;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CS.ownerMachine", () => {
  it("is the Mac with no meta and the host's noun with one", () => {
    const CS = loadToolkit();
    expect(CS.ownerMachine()).toBe("Mac");
    setOwnerMachine("computer");
    expect(CS.ownerMachine()).toBe("computer");
  });

  it("names the computer in the terminal's offline, failed and busy notes", () => {
    setOwnerMachine("computer");
    const CS = loadToolkit();
    expect(noteAfter(CS, PAUSED)).toBe(
      "The owner's computer is offline. The terminal goes on when it is back.",
    );
    expect(noteAfter(CS, FAILED)).toBe(
      "The owner's computer could not keep this terminal open; trying again shortly.",
    );
    expect(noteAfter(CS, BUSY)).toBe(
      "The owner's computer is watching too many terminals right now; trying again shortly.",
    );
  });

  it("keeps today's notes with no meta", () => {
    const CS = loadToolkit();
    expect(noteAfter(CS, PAUSED)).toBe(MAIN.paused);
    expect(noteAfter(CS, FAILED)).toBe(MAIN.failed);
    expect(noteAfter(CS, BUSY)).toBe(MAIN.busy);
  });

  it("says Mac, without throwing, on an older adopted core that has no reader", () => {
    loadToolkit();
    delete (win.__csKitCore as Record<string, unknown>).ownerMachine;
    setOwnerMachine("computer");
    const CS = loadToolkit();
    expect(() => CS.ownerMachine()).not.toThrow();
    expect(CS.ownerMachine()).toBe("Mac");
    expect(noteAfter(CS, PAUSED)).toBe(MAIN.paused);
    expect(noteAfter(CS, FAILED)).toBe(MAIN.failed);
    expect(noteAfter(CS, BUSY)).toBe(MAIN.busy);
  });
});
