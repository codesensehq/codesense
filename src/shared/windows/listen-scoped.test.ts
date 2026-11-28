// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

const listen = vi.hoisted(() => vi.fn());
const host = vi.hoisted(() => ({ main: true, label: "main" }));

vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@/shared/lib/current-window", () => ({
  isMainWindow: () => host.main,
  currentWindowLabel: () => host.label,
}));

import { listenScoped, type ListenerScope } from "./listen-scoped";

const SCOPES: ListenerScope[] = ["main-only", "every-window", "owning-window"];

beforeEach(() => {
  listen.mockReset();
  listen.mockImplementation(() => Promise.resolve(() => {}));
  host.main = true;
  host.label = "main";
});

/** The function `listenScoped` handed to `listen` on its last call. */
const registered = () => listen.mock.calls.at(-1)?.[1] as (event: { payload: unknown }) => void;

describe("listenScoped in main", () => {
  it.each(SCOPES)(
    "hands %s's handler to listen as it is, and returns listen's promise",
    (scope) => {
      const handler = vi.fn();
      const owns = vi.fn(() => false);
      const pending = Promise.resolve(() => {});
      listen.mockReturnValueOnce(pending);

      expect(listenScoped("x", scope, handler, owns)).toBe(pending);

      expect(listen).toHaveBeenCalledWith("x", handler);
      expect(registered()).toBe(handler);
      registered()({ payload: 1 });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(owns).not.toHaveBeenCalled();
    },
  );
});

describe("listenScoped in a satellite", () => {
  beforeEach(() => {
    host.main = false;
  });

  it("does not register a main-only listener", async () => {
    const unlisten = await listenScoped("x", "main-only", vi.fn());
    expect(listen).not.toHaveBeenCalled();
    expect(() => unlisten()).not.toThrow();
  });

  it("registers an every-window listener as it is, without asking owns", () => {
    const handler = vi.fn();
    const owns = vi.fn(() => false);
    listenScoped("x", "every-window", handler, owns);
    expect(registered()).toBe(handler);
    registered()({ payload: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(owns).not.toHaveBeenCalled();
  });

  it("calls an owning-window handler only for what owns accepts, one owns call per event", () => {
    const handler = vi.fn();
    const owns = vi.fn((payload: number) => payload === 2);
    listenScoped<number>("x", "owning-window", handler, owns);

    registered()({ payload: 1 });
    registered()({ payload: 2 });

    expect(owns.mock.calls).toEqual([[1], [2]]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ payload: 2 });
  });

  it("owns nothing with no owns", () => {
    const handler = vi.fn();
    listenScoped("x", "owning-window", handler);
    registered()({ payload: 1 });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("listenScoped for this window", () => {
  type Target = { kind: string; label?: string };
  type Listener = { event: string; handler: (event: { payload: unknown }) => void; target: Target };

  /** Tauri's delivery rule: an `Any` listener hears every emit; one with a window target hears
   *  a broadcast and an emit to its own label. */
  function bus() {
    const listeners: Listener[] = [];
    listen.mockImplementation((event, handler, options?: { target?: Target }) => {
      listeners.push({ event, handler, target: options?.target ?? { kind: "Any" } });
      return Promise.resolve(() => {});
    });
    const deliver = (event: string, payload: unknown, label?: string) => {
      for (const l of listeners) {
        const hears = label === undefined || l.target.kind === "Any" || l.target.label === label;
        if (l.event === event && hears) l.handler({ payload });
      }
    };
    return {
      emit: (event: string, payload: unknown) => deliver(event, payload),
      emitTo: (label: string, event: string, payload: unknown) => deliver(event, payload, label),
    };
  }

  function inWindow(label: string) {
    host.label = label;
    host.main = label === "main";
  }

  it("registers on this window's own webview", () => {
    inWindow("pane-2");
    const handler = vi.fn();
    listenScoped("x", "this-window", handler, () => true);
    expect(listen).toHaveBeenCalledWith("x", expect.any(Function), {
      target: { kind: "WebviewWindow", label: "pane-2" },
    });
  });

  it("hands main's handler to listen as it is", () => {
    const handler = vi.fn();
    listenScoped("x", "this-window", handler);
    expect(registered()).toBe(handler);
  });

  it("a second window's listener doesn't get another window's stream", () => {
    const { emitTo } = bus();
    const inMain = vi.fn();
    const inSatellite = vi.fn();
    inWindow("main");
    listenScoped("pty-output-stream-7", "this-window", inMain);
    inWindow("pane-2");
    listenScoped("pty-output-stream-7", "this-window", inSatellite, () => true);

    emitTo("pane-2", "pty-output-stream-7", { seq: 1 });
    emitTo("main", "pty-output-stream-7", { seq: 2 });

    expect(inSatellite.mock.calls).toEqual([[{ payload: { seq: 1 } }]]);
    expect(inMain.mock.calls).toEqual([[{ payload: { seq: 2 } }]]);
  });

  it("an owning-window listener, on every target, would hear another window's stream", () => {
    const { emitTo } = bus();
    const inMain = vi.fn();
    listenScoped("pty-output-stream-7", "owning-window", inMain);
    emitTo("pane-2", "pty-output-stream-7", { seq: 1 });
    expect(inMain).toHaveBeenCalledTimes(1);
  });

  it("still hears a broadcast, as a stream with no window is sent", () => {
    const { emit } = bus();
    const handler = vi.fn();
    listenScoped("pty-output-stream-7", "this-window", handler);
    emit("pty-output-stream-7", { seq: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("in a satellite calls the handler only for what owns accepts", () => {
    inWindow("pane-2");
    const handler = vi.fn();
    listenScoped<number>("x", "this-window", handler, (payload) => payload === 2);
    registered()({ payload: 1 });
    registered()({ payload: 2 });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
