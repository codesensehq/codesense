// SPDX-License-Identifier: MIT
import type { HubSnapshot } from "@/features/dashboard/lib/live-hub";
import { SAMPLE_DAY } from "../sample-day";
import type { SampleDay } from "../sample-day";
import type { HandlerRegistry } from "../mock-router";

/** One row of the `needsYou` topic, as the host publishes it. */
type NeedsYouRow = {
  id: string;
  kind: "question" | "permission" | "merge" | "capped" | "failed";
  session: string;
  org: string | null;
  team: string | null;
  workItem: string | null;
  question?: string;
  messageId?: number;
};

// The merge-card rule as `live_hub/needs_you.rs` `card_kind` and the Foreman story view's
// `kindOf` apply it; all three read `tests/fixtures/merge-card-cases.json`.
const PR_LINK =
  /https:\/\/github\.com\/[^/\s)]+\/[^/\s)]+\/pull\/(\d+)|(?:^|[^\w./-])[\w.-]+\/[\w.-]+#(\d+)/;
const MERGE_VERB =
  /`merge`|\breply\s+[*"“`]*merge\b|\bmerge[`*"”]*\s+(?:or|\/)\s+[`*"“]*send back/i;
const SEND_BACK = /\bsend back\b/i;

/** Whether a card offers a PR to merge or send back, else asks a question. */
export function cardKind(card: { summary?: string | null; text: string }): "merge" | "question" {
  const words = `${card.summary ?? ""}\n${card.text}`;
  return PR_LINK.test(words) && MERGE_VERB.test(words) && SEND_BACK.test(words)
    ? "merge"
    : "question";
}

/** A question card's text: its summary, else its first non-blank line, on one line. */
function questionText(card: { summary?: string | null; text: string }): string {
  const raw = card.summary?.trim() || card.text.split("\n").find((line) => line.trim()) || "";
  const line = raw
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Counted in code points, as Rust counts chars, so an emoji is one and never split.
  const chars = Array.from(line);
  return chars.length > 200 ? `${chars.slice(0, 199).join("")}…` : line;
}

const AGENT_KINDS: Record<string, NeedsYouRow["kind"]> = {
  question: "question",
  permission: "permission",
  failed: "failed",
  crashed: "failed",
};

/** The day's needs-you set as topic rows, derived from its agents and Inbox as the host derives
 *  it: a card is placed by the team whose Inbox holds it, an agent's item by its own team. An
 *  ended agent stays only while it is marked failed or crashed, and asks nothing else. */
function needsYouRows(day: SampleDay = SAMPLE_DAY): NeedsYouRow[] {
  const agents = new Map(day.agents.map((agent) => [agent.session, agent]));
  const rows: NeedsYouRow[] = [];
  for (const card of day.inbox) {
    if (card.to !== "human" || card.kind !== "needs-you" || card.read) continue;
    const kind = cardKind(card);
    rows.push({
      id: `inbox:${card.org}/${card.team}/${card.messageId}`,
      kind,
      session: card.from,
      org: card.org,
      team: card.team,
      workItem: agents.get(card.from)?.workItem ?? null,
      ...(kind === "question" ? { question: questionText(card) } : {}),
      messageId: card.messageId,
    });
  }
  for (const agent of day.agents) {
    const ended = agent.state === "ended";
    const place = { session: agent.session, org: agent.org, team: agent.team };
    const kind = AGENT_KINDS[agent.signals.needsYouKind ?? ""];
    if (ended && kind !== "failed") continue;
    if (kind)
      rows.push({
        id: `agent:${agent.session}:${kind}`,
        kind,
        ...place,
        workItem: agent.workItem,
        ...(kind === "question" && agent.signals.question
          ? { question: agent.signals.question }
          : {}),
      });
    if (agent.capped && !ended)
      rows.push({
        id: `agent:${agent.session}:capped`,
        kind: "capped",
        ...place,
        workItem: agent.workItem,
      });
  }
  return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Whether a view key admits a row: `all` admits every row, `team:<org>/<team>` its own. */
function admits(viewKey: string, row: NeedsYouRow): boolean {
  if (viewKey === "all") return true;
  return row.org !== null && row.team !== null && viewKey === `team:${row.org}/${row.team}`;
}

/** The mock backend's `needsYou` topic, served from the 14:02 sample day or another `day`. */
export function needsYouHandlers(
  fallback: HandlerRegistry,
  day: SampleDay = SAMPLE_DAY,
): HandlerRegistry {
  return {
    live_hub_subscribe: (args) => {
      if (args.topic !== "needsYou") return fallback.live_hub_subscribe(args);
      const viewKey = String(args.viewKey);
      const snapshot: HubSnapshot = {
        topic: "needsYou",
        viewKey,
        rev: 1,
        snapshot: needsYouRows(day).filter((row) => admits(viewKey, row)),
      };
      return snapshot;
    },
  };
}
