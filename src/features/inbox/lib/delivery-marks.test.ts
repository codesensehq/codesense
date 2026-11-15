// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import type { ConversationMessage } from "../api";
import { createDeliveryTracker } from "./delivery-marks";

const LEAD = "lead#1";
const at = (n: number) => 1_000_000 + n * 1000;
const msg = (id: number, from: string, createdAtMs: number) =>
  ({
    id,
    team: { org: "acme", team: "widgets" },
    from,
    to: from === "human" ? LEAD : "human",
    createdAtMs,
  }) as ConversationMessage;
const row = (extra = {}) => ({ state: "running", unread: 1, mailNotice: "pending", ...extra });

describe("createDeliveryTracker", () => {
  it("marks nothing in the history it opened on", () => {
    const t = createDeliveryTracker();
    const history = [msg(1, "human", at(0)), msg(2, LEAD, at(1))];
    t.observe(history, LEAD, row());
    expect(t.markOf(history[0]!, row())).toBeNull();
    expect(t.markOf(history[1]!, row())).toBeNull();
  });

  it("a message sent to a busy lead is Queued, then Delivered once the lead is told, and stays so", () => {
    const t = createDeliveryTracker();
    t.observe([msg(1, LEAD, at(0))], LEAD, row());
    const sent = msg(2, "human", at(5));
    const thread = [msg(1, LEAD, at(0)), sent];
    t.observe(thread, LEAD, row());
    expect(t.markOf(sent, row())).toBe("queued");
    const told = row({ mailNotice: "told", notifiedAt: new Date(at(6)).toISOString() });
    expect(t.markOf(sent, told)).toBe("delivered");
    expect(t.markOf(sent, row()), "latched").toBe("delivered");
  });

  it("a message sent to an idle lead is Delivered at once", () => {
    const t = createDeliveryTracker();
    t.observe([], LEAD, row({ state: "idle" }));
    const sent = msg(1, "human", at(1));
    t.observe([sent], LEAD, row({ state: "idle" }));
    expect(t.markOf(sent, row({ state: "idle" }))).toBe("delivered");
  });

  it("the lead writing after the send delivers it", () => {
    const t = createDeliveryTracker();
    t.observe([], LEAD, row());
    const sent = msg(1, "human", at(1));
    t.observe([sent], LEAD, row());
    const reply = msg(2, LEAD, at(9));
    t.observe([sent, reply], LEAD, row());
    expect(t.markOf(sent, row())).toBe("delivered");
  });

  it("never marks the lead's own messages", () => {
    const t = createDeliveryTracker();
    t.observe([], LEAD, row());
    const said = msg(1, LEAD, at(1));
    t.observe([said], LEAD, row());
    expect(t.markOf(said, row())).toBeNull();
  });
});
