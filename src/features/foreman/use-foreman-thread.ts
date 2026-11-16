// SPDX-License-Identifier: MIT
/**
 * The Foreman's thread as its page reads it, for the chat overlay on the Foreman's terminal tab:
 * the page keeps its newest senders (the Foreman sessions you have talked to) in the shared
 * `ui:foreman` state, and its thread is their mail with you merged, oldest first. The overlay
 * reads that state through the live hub, never a copy of the page's logic.
 */
import { useEffect, useMemo, useState } from "react";

import { liveHub } from "@/features/dashboard/lib/live-hub";
import { useDashboardPolicy, type DashboardPolicy } from "@/features/dashboard/lib/verb-policy";
import { loadSessionInbox, type ConversationMessage } from "@/features/inbox/api";
import { useInboxRead } from "@/features/inbox/hooks/use-inbox-read";
import { between } from "@/features/inbox/lib/agent-chat";
import { msgKey, normalizeMessage } from "@/features/inbox/model";
import { CODESENSE_DOCS_SLUG, CODESENSE_DOCS_TEAM } from "@/shared/lib/codesense-docs";
import type { InboxTeam } from "@/tauri/commands";

/** The Foreman page's team (its tab opens in the docs team): its UI state and pins live there. */
export const FOREMAN_TEAM: InboxTeam = { org: CODESENSE_DOCS_SLUG, team: CODESENSE_DOCS_TEAM };
const UI_TOPIC = "ui:foreman";

/**
 * The view key the host files the page's `ui:foreman` state under, as it keys the page's frame:
 * its team under the Team-safe preset (the page is team content), else "all" (Open, the default).
 */
export const foremanUiView = (preset: DashboardPolicy["preset"]) =>
  preset === "team-safe" ? `team:${FOREMAN_TEAM.org}/${FOREMAN_TEAM.team}` : "all";
/** How many of the newest senders the page's thread reads (its `foreman.history`). */
export const FOREMAN_HISTORY = 5;

const NONE: readonly string[] = [];
const NO_MAIL: ConversationMessage[] = [];

/** The page's sender set in a `ui:foreman` snapshot, newest first. */
export function foremanSenders(state: unknown): string[] {
  const senders = (state as { senders?: unknown } | null | undefined)?.senders;
  return Array.isArray(senders)
    ? senders.filter((s): s is string => typeof s === "string" && s !== "")
    : [];
}

/** The page's newest senders, watched while `enabled`. */
export function useForemanSenders(enabled: boolean): readonly string[] {
  const preset = useDashboardPolicy()?.preset;
  const view = enabled && preset ? foremanUiView(preset) : null;
  const [senders, setSenders] = useState<{ view: string; list: readonly string[] }>();
  useEffect(() => {
    if (!view) return;
    return liveHub.watch(UI_TOPIC, view, (snapshot) =>
      setSenders({ view, list: foremanSenders(snapshot.snapshot[0]).slice(0, FOREMAN_HISTORY) }),
    );
  }, [view]);
  return view && senders?.view === view ? senders.list : NONE;
}

/** Each earlier sender's mail with you; `key` is their handles, one per line. */
async function loadEarlierSenders(key: string) {
  const lists = await Promise.all(
    key.split("\n").map((sender) =>
      loadSessionInbox(sender).then(
        ({ dto }) => dto.messages.map(normalizeMessage).filter((m) => between(m, sender)),
        // An earlier session whose read fails leaves its mail out; the live thread still shows.
        () => [],
      ),
    ),
  );
  return { dto: lists.flat(), source: "live" as const };
}

/**
 * The thread the overlay shows for the live Foreman `handle` (null: not the Foreman): `live`, its
 * own conversation, merged with each earlier sender's mail with you, oldest first. The earlier
 * senders are read again on each inbox change: one may still be running.
 */
export function useForemanThread(
  handle: string | null,
  live: ConversationMessage[],
): ConversationMessage[] {
  const senders = useForemanSenders(handle !== null);
  const earlier = useMemo(() => senders.filter((s) => s !== handle), [senders, handle]);
  const key = earlier.join("\n");
  // Read again on each inbox change, as the live thread is: an earlier Foreman may still be running.
  const { data } = useInboxRead(key || null, loadEarlierSenders);
  const mail = key && data ? data : NO_MAIL;
  return useMemo(() => {
    if (handle === null || mail.length === 0) return live;
    const byKey = new Map<string, ConversationMessage>();
    for (const m of [...mail, ...live]) byKey.set(msgKey(m), m);
    return [...byKey.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
  }, [handle, live, mail]);
}
