// SPDX-License-Identifier: MIT
/**
 * The Foreman's thread as its page reads it, for the chat overlay on the Foreman's terminal tab:
 * the page keeps its newest senders (the Foreman sessions you have talked to) in the shared
 * `ui:foreman` state, and its thread is their mail with you merged, oldest first. The overlay
 * reads that state through the live hub, never a copy of the page's logic.
 */
import { useEffect, useMemo, useState } from "react";

import { liveHub } from "@/features/dashboard/lib/live-hub";
import { loadSessionInbox, type ConversationMessage } from "@/features/inbox/api";
import { between } from "@/features/inbox/lib/agent-chat";
import { msgKey, normalizeMessage } from "@/features/inbox/model";
import { CODESENSE_DOCS_SLUG, CODESENSE_DOCS_TEAM } from "@/shared/lib/codesense-docs";
import type { InboxTeam } from "@/tauri/commands";

/** The Foreman page's team (its tab opens in the docs team): its UI state and pins live there. */
export const FOREMAN_TEAM: InboxTeam = { org: CODESENSE_DOCS_SLUG, team: CODESENSE_DOCS_TEAM };
const UI_TOPIC = "ui:foreman";
const UI_VIEW = `team:${FOREMAN_TEAM.org}/${FOREMAN_TEAM.team}`;
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
  const [senders, setSenders] = useState<readonly string[]>(NONE);
  useEffect(() => {
    if (!enabled) return;
    return liveHub.watch(UI_TOPIC, UI_VIEW, (snapshot) =>
      setSenders(foremanSenders(snapshot.snapshot[0]).slice(0, FOREMAN_HISTORY)),
    );
  }, [enabled]);
  return enabled ? senders : NONE;
}

/**
 * The thread the overlay shows for the live Foreman `handle` (null: not the Foreman): `live`, its
 * own conversation, merged with each earlier sender's mail with you, oldest first. Earlier
 * sessions have ended, so each is read once per sender set.
 */
export function useForemanThread(
  handle: string | null,
  live: ConversationMessage[],
): ConversationMessage[] {
  const senders = useForemanSenders(handle !== null);
  const earlier = useMemo(() => senders.filter((s) => s !== handle), [senders, handle]);
  const key = earlier.join("\n");
  const [read, setRead] = useState<{ key: string; mail: ConversationMessage[] }>();
  useEffect(() => {
    if (!key) return;
    let stale = false;
    void Promise.all(
      key.split("\n").map((sender) =>
        loadSessionInbox(sender).then(
          ({ dto }) => dto.messages.map(normalizeMessage).filter((m) => between(m, sender)),
          // An earlier session whose read fails leaves its mail out; the live thread still shows.
          () => [],
        ),
      ),
    ).then((lists) => {
      if (!stale) setRead({ key, mail: lists.flat() });
    });
    return () => {
      stale = true;
    };
  }, [key]);
  const mail = key && read?.key === key ? read.mail : NO_MAIL;
  return useMemo(() => {
    if (handle === null || mail.length === 0) return live;
    const byKey = new Map<string, ConversationMessage>();
    for (const m of [...mail, ...live]) byKey.set(msgKey(m), m);
    return [...byKey.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
  }, [handle, live, mail]);
}
