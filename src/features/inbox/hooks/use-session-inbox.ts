// SPDX-License-Identifier: MIT
import { SESSION_STATE_CHANGED_EVENT } from "@/features/viewer/lib/session-events";

import { loadSessionInbox, loadThreadInbox, threadReadKey, type SessionInboxDto } from "../api";

import { useInboxRead, type InboxRead } from "./use-inbox-read";

const IDENTITY_EVENTS = [SESSION_STATE_CHANGED_EVENT] as const;

/** Everything `handle` sent, received, or holds via its roles — live, across its own and every synced team. */
export function useSessionInbox(handle: string | null): InboxRead<SessionInboxDto> {
  return useInboxRead(handle, loadSessionInbox, IDENTITY_EVENTS);
}

/** An agent session's conversation: its saved agent + story thread's when it was launched on
 *  one (a successor opens on its predecessor's mail, whether or not the roster still lists it),
 *  else its own. `session` is the seat: the thread's other running seats are left out. */
export function useAgentInbox(
  session: string | null,
  thread: { agentId: string; storyId: string | null } | null,
): InboxRead<SessionInboxDto> {
  const key = session && thread ? threadReadKey(thread.agentId, thread.storyId, session) : null;
  const byThread = useInboxRead(key, loadThreadInbox, IDENTITY_EVENTS);
  const bySession = useInboxRead(key ? null : session, loadSessionInbox, IDENTITY_EVENTS);
  return key ? byThread : bySession;
}
