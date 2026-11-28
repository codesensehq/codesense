// SPDX-License-Identifier: MIT
import { useMemo } from "react";

import type { AgentLook } from "@/features/viewer/components/agent-identity-menus";
import { useTabTeamOf } from "@/features/viewer/hooks/use-face-tags";
import { useAgentIdentityChoice } from "@/features/viewer/hooks/use-listed-agents";
import { isAgentSession } from "@/features/viewer/lib/hand-agents";
import { useAgentListProjectionStore } from "@/features/viewer/lib/agent-list-projection";
import { useAvatarPacks } from "@/shared/hooks/use-avatar-packs";
import { NO_TEAM_SENTINEL } from "@/shared/lib/team-key";
import { useViewerStore } from "@/shared/stores/viewer-store";

/**
 * The Role and Face a person can give the agent running in a terminal tab, kept with the
 * team whose workspace holds the tab — the same choice its agents-list row reads and sets, drawn
 * from that team's packs. `undefined` for a plain shell, or a tab no team holds. It reads only
 * this tab's agent, so another agent, team or look does not redraw its caller.
 */
export function useTabAgentLook(sessionId: string | undefined): AgentLook | undefined {
  const handle = useAgentListProjectionStore((s) =>
    sessionId
      ? s.sessions?.find((r) => isAgentSession(r) && r.sessionId === sessionId)?.handle
      : undefined,
  );
  const teamKey = useTabTeamOf(sessionId);
  const choice = useAgentIdentityChoice(
    teamKey ?? undefined,
    teamKey === null ? undefined : handle,
  );
  // With no team to read, no team's packs: nothing here is drawn then.
  const avatars = useAvatarPacks(teamKey ?? NO_TEAM_SENTINEL);
  const setAgentIdentity = useViewerStore((s) => s.setAgentIdentity);
  return useMemo(() => {
    if (!sessionId || teamKey === null || handle === undefined) return undefined;
    return {
      choice,
      avatars,
      onChoose: (patch) => setAgentIdentity(teamKey, handle, patch),
    };
  }, [sessionId, teamKey, handle, choice, avatars, setAgentIdentity]);
}
