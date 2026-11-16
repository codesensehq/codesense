// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";

import { liveHub } from "@/features/dashboard/lib/live-hub";
import type { InboxTeam } from "@/tauri/commands";

import type { DeliveryRow } from "../lib/delivery-marks";

const NONE: ReadonlyMap<number, DeliveryRow> = new Map();

/**
 * Where each message the person sent to a session stands, from the host's `messageDelivery`
 * topic for `team`: queued until the session's agent is told about it (or reads it), then
 * delivered. Keyed by message id. A host without the topic answers nothing, and the marks
 * follow the lead's roster row as before.
 */
export function useMessageDelivery(team: InboxTeam | null): ReadonlyMap<number, DeliveryRow> {
  const key = team ? `team:${team.org}/${team.team}` : null;
  const [rows, setRows] = useState<{ key: string; byId: ReadonlyMap<number, DeliveryRow> }>();
  useEffect(() => {
    if (!key) return;
    return liveHub.watch("messageDelivery", key, (snapshot) => {
      const byId = new Map<number, DeliveryRow>();
      for (const row of snapshot.snapshot as Array<Record<string, unknown>>) {
        const id = row.messageId;
        const state = row.state;
        if (typeof id !== "number" || (state !== "queued" && state !== "delivered")) continue;
        byId.set(id, {
          state,
          deliveredAtMs: typeof row.deliveredAtMs === "number" ? row.deliveredAtMs : null,
        });
      }
      setRows({ key, byId });
    });
  }, [key]);
  return rows && rows.key === key ? rows.byId : NONE;
}
