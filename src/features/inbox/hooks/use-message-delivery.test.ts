// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const hub = vi.hoisted(() => ({
  watch: vi.fn(),
  callback: null as null | ((snapshot: { snapshot: unknown[] }) => void),
  stop: vi.fn(),
}));
vi.mock("@/features/dashboard/lib/live-hub", () => ({
  liveHub: {
    watch: (topic: string, key: string, cb: (s: { snapshot: unknown[] }) => void) => {
      hub.watch(topic, key);
      hub.callback = cb;
      return hub.stop;
    },
  },
}));

import { useMessageDelivery } from "./use-message-delivery";

describe("useMessageDelivery", () => {
  it("watches the team's messageDelivery view and keys its rows by message id", () => {
    const { result, unmount } = renderHook(() =>
      useMessageDelivery({ org: "acme", team: "widgets" }),
    );
    expect(hub.watch).toHaveBeenCalledWith("messageDelivery", "team:acme/widgets");
    expect(result.current.get(7)).toBeUndefined();
    act(() =>
      hub.callback!({
        snapshot: [
          { id: "delivery:acme/widgets/7", messageId: 7, state: "queued", deliveredAtMs: null },
          { id: "delivery:acme/widgets/8", messageId: 8, state: "delivered", deliveredAtMs: 5 },
        ],
      }),
    );
    expect(result.current.get(7)).toEqual({ state: "queued", deliveredAtMs: null });
    expect(result.current.get(8)?.state).toBe("delivered");
    unmount();
    expect(hub.stop).toHaveBeenCalled();
  });

  it("watches nothing without a team", () => {
    hub.watch.mockClear();
    const { result } = renderHook(() => useMessageDelivery(null));
    expect(hub.watch).not.toHaveBeenCalled();
    expect(result.current.size).toBe(0);
  });
});
