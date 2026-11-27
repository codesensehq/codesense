// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

const listen = vi.hoisted(() => vi.fn());
const host = vi.hoisted(() => ({ main: true }));

vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@/shared/lib/current-window", () => ({ isMainWindow: () => host.main }));

import { listenScoped, type ListenerScope } from "./listen-scoped";

const SCOPES: ListenerScope[] = ["main-only", "every-window", "owning-window"];

beforeEach(() => {
  listen.mockReset();
  listen.mockImplementation(() => Promise.resolve(() => {}));
  host.main = true;
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
