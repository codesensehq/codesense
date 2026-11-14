// SPDX-License-Identifier: MIT
import { useMemo, useState } from "react";

import { useCurrentUser } from "@/shared/lib/get-current-user";
import type { InboxTeam } from "@/tauri/commands";

import type { InboxSource, SessionInboxDto } from "../api";
import { fixtureSessions } from "../fixtures";
import { agentTeam, between, teamOfKey } from "../lib/agent-chat";
import { buildDirectory, normalizeMessage, roleSummaries, sameTeam } from "../model";
import { useInboxSessions } from "./use-inbox-sessions";

/**
 * An agent's conversation with you, read from its session inbox: the one model its quick chat
 * and its tab's overlay share. The read spans every synced team, and a handle names a session
 * within its team, so the conversation shows only the agent's own team's mail (its other teams'
 * mail is other conversations). That team is settled by the first read and kept while `chatKey`
 * names the same chat: mail arriving in another team never moves the conversation, or a send,
 * there mid-chat.
 */
export function useAgentConversation({
  data,
  source,
  handle,
  teamKey,
  chatKey,
}: {
  /** The read for this agent; null until it has loaded. */
  data: SessionInboxDto | null;
  source: InboxSource | null;
  handle: string;
  /** The team a first message goes to when no earlier message names one. */
  teamKey: string;
  /** Names the chat shown: the fixed team is kept for as long as it stays the same. */
  chatKey: string;
}) {
  const sessions = useInboxSessions();
  const user = useCurrentUser();
  const home = useMemo(() => teamOfKey(teamKey), [teamKey]);
  const messages = useMemo(() => (data?.messages ?? []).map(normalizeMessage), [data]);
  const readTeam = useMemo(() => agentTeam(messages, handle, home), [messages, handle, home]);
  const [fixed, setFixed] = useState<{ chat: string; team: InboxTeam | null } | null>(null);
  if (data && fixed?.chat !== chatKey) setFixed({ chat: chatKey, team: readTeam });
  const team = fixed?.chat === chatKey ? fixed.team : readTeam;
  // The shown team's mail: what the chat, its roles and where a send goes are read from.
  const teamMessages = useMemo(
    () => (team ? messages.filter((m) => sameTeam(m.team, team)) : messages),
    [messages, team],
  );
  const conversation = useMemo(
    () => teamMessages.filter((m) => between(m, handle)),
    [teamMessages, handle],
  );
  const dir = useMemo(() => {
    // Demo messages (dev only) name demo sessions; label them from the demo roster too.
    const rows =
      source === "fixture" ? [...(sessions ?? []), ...fixtureSessions()] : (sessions ?? []);
    return buildDirectory(rows, messages, { humanName: user?.display_name });
  }, [sessions, source, messages, user?.display_name]);
  const roles = useMemo(() => roleSummaries(dir, teamMessages), [dir, teamMessages]);
  return { messages, home, team, teamMessages, conversation, dir, roles };
}
