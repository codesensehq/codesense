// SPDX-License-Identifier: MIT
import type { HubSnapshot } from "@/features/dashboard/lib/live-hub";
import { SAMPLE_DAY } from "../sample-day";
import type { SampleDay } from "../sample-day";
import type { HandlerRegistry } from "../mock-router";

/** One row of the `needsYou` topic, as the host publishes it. */
export type NeedsYouRow = {
  id: string;
  kind: "question" | "permission" | "merge" | "capped" | "failed";
  session: string;
  org: string | null;
  team: string | null;
  workItem: string | null;
  question?: string;
  messageId?: number;
};

/** The day's needs-you set as topic rows: each item placed by its session's team and work
 *  item, as the host places it. */
export function needsYouRows(day: SampleDay = SAMPLE_DAY): NeedsYouRow[] {
  const agents = new Map(day.agents.map((agent) => [agent.session, agent]));
  return day.expect.needsYou.map((item) => {
    const agent = agents.get(item.session);
    const card = item.id.startsWith("inbox:") ? Number(item.id.slice("inbox:".length)) : null;
    return {
      ...item,
      org: agent?.org ?? null,
      team: agent?.team ?? null,
      workItem: agent?.workItem ?? null,
      ...(card === null ? {} : { messageId: card }),
    };
  });
}

/** Whether a view key admits a row: `all` admits every row, `team:<org>/<team>` its own. */
export function admits(viewKey: string, row: NeedsYouRow): boolean {
  if (viewKey === "all") return true;
  return row.org !== null && row.team !== null && viewKey === `team:${row.org}/${row.team}`;
}

/** The mock backend's `needsYou` topic, served from the 14:02 sample day. */
export function needsYouHandlers(fallback: HandlerRegistry): HandlerRegistry {
  return {
    live_hub_subscribe: (args) => {
      if (args.topic !== "needsYou") return fallback.live_hub_subscribe(args);
      const viewKey = String(args.viewKey);
      const snapshot: HubSnapshot = {
        topic: "needsYou",
        viewKey,
        rev: 1,
        snapshot: needsYouRows().filter((row) => admits(viewKey, row)),
      };
      return snapshot;
    },
  };
}
