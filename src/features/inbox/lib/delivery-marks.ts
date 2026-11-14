// SPDX-License-Identifier: MIT
import type { ConversationMessage } from "../api";
import { HUMAN, msgKey } from "../model";
import { createMarkLatch, isBusy, type ChatLeadRow } from "./chat-core";

export type DeliveryMark = "queued" | "delivered";

/** The lead's sessions() row, as much of it as the marks rule reads. */
export type LeadSession = {
  state?: string;
  unread?: number | null;
  mailNotice?: string | null;
  notifiedAt?: string | null;
};
const rowOf = (lead: LeadSession | null): ChatLeadRow | null =>
  lead && {
    state: lead.state,
    unread: lead.unread ?? undefined,
    mailNotice: lead.mailNotice,
    notifiedAt: lead.notifiedAt,
  };

/**
 * The Queued/Delivered marks for what the person sends in one chat, by the kit's rule
 * (chat-core). Whether the lead was busy is read once, the first time a sent message shows
 * (it shows as it lands); what the chat opened on is history and carries no mark. One tracker
 * lives as long as the chat.
 */
export function createDeliveryTracker() {
  const latch = createMarkLatch();
  const busyAtSend = new Map<string, boolean>();
  const seen = new Set<string>();
  let opened = false;
  let newestLeadAt = 0;
  return {
    /** Read the thread as it stands: note each new message of the person's and the lead's newest. */
    observe(thread: readonly ConversationMessage[], handle: string, lead: LeadSession | null) {
      newestLeadAt = 0;
      for (const m of thread) {
        const key = msgKey(m);
        if (m.from === handle) newestLeadAt = Math.max(newestLeadAt, m.createdAtMs);
        if (seen.has(key)) continue;
        seen.add(key);
        if (opened && m.from === HUMAN) busyAtSend.set(key, isBusy(rowOf(lead)));
      }
      opened = true;
    },
    /** Queued or Delivered for a message the person sent while this chat was open, else null. */
    markOf(m: ConversationMessage, lead: LeadSession | null): DeliveryMark | null {
      const key = msgKey(m);
      const busy = busyAtSend.get(key);
      if (busy === undefined) return null;
      return latch(key, {
        sentAt: m.createdAtMs,
        busyAtSend: busy,
        lead: rowOf(lead),
        newestLeadAt,
      });
    },
  };
}
