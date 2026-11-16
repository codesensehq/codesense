// SPDX-License-Identifier: MIT
import type { ConversationMessage } from "../api";
import type { InboxView } from "../components/inbox-view-context";
import { pinTitleOf } from "../lib/person-pins";
import { HUMAN, isRoleKey, labelOf } from "../model";
import { useAgentPins } from "./use-agent-pins";
import { useInboxSessions } from "./use-inbox-sessions";
import { usePersonPins, type PersonPins } from "./use-person-pins";

/**
 * The person's pins of an Inbox conversation: only where the conversation maps to one agent
 * thread, a session launched from a saved agent (its agent and story), and only in the
 * person's own Inbox. A role, a session from no saved agent, or a party with no session has
 * no Pin (no dead controls). The Inbox has no Pinned block, so Show pins goes to the agent,
 * whose chat shows its pins.
 */
export function useThreadPins(
  key: string,
  messages: readonly ConversationMessage[],
  view: InboxView,
): PersonPins | null {
  const sessions = useInboxSessions();
  const human = view.me === HUMAN && !view.self;
  const session = human && !isRoleKey(key) ? sessions?.find((s) => s.handle === key) : undefined;
  const agentId = session?.agent ?? null;
  // The thread lives in the store of the team the session was launched in.
  const team = agentId
    ? (session?.team ?? messages.at(-1)?.team ?? view.fallbackTeam ?? null)
    : null;
  const storyId = session?.story ?? null;
  const { pins, apply } = useAgentPins(team, agentId, storyId);
  return usePersonPins({
    team,
    agentId,
    storyId,
    pins,
    apply,
    sender: (m) => labelOf(view.dir, m.from),
    labelOf: (from) => labelOf(view.dir, from),
    // A pin is named as the agent's chat names it: its short name, else its message's title,
    // from what the pins read says the message is (another seat's mail too).
    titleOf: (p) =>
      p.preview?.shortName || pinTitleOf(p.message, labelOf(view.dir, p.message.from)),
    ownOf: (p) => (p.message.contentType === "html" ? "name" : "quote"),
    onShowPins: () => view.goTo(key),
  });
}
