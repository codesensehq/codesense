// SPDX-License-Identifier: MIT
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import type { AgentIdentityChoice } from "@/shared/lib/agent-identity-choice";
import { useViewerStore, type ViewerState } from "@/shared/stores/viewer-store";

const NO_CHOICES: Readonly<Record<string, AgentIdentityChoice>> = Object.freeze({});

/**
 * The looks people chose for agents, by session handle: one team's, or (with no team) every
 * team's together, for a surface that does not know which team a session is in.
 */
export function useAgentIdentityChoices(
  teamKey?: string,
): Readonly<Record<string, AgentIdentityChoice>> {
  const all = useViewerStore((s) => s.agentIdentity);
  return useMemo(() => identityChoicesOf(all, teamKey), [all, teamKey]);
}

/** {@link useAgentIdentityChoices}' map, from the store's looks by team. */
export function identityChoicesOf(
  all: ViewerState["agentIdentity"] | undefined,
  teamKey?: string,
): Readonly<Record<string, AgentIdentityChoice>> {
  if (!all) return NO_CHOICES;
  if (teamKey !== undefined) return all[teamKey] ?? NO_CHOICES;
  const teams = Object.values(all);
  return teams.length === 0 ? NO_CHOICES : Object.assign({}, ...teams);
}

/**
 * The look people chose for one agent, read as {@link useAgentIdentityChoices} would for its
 * handle, and compared shallowly: another agent's or another team's look does not redraw it.
 */
export function useAgentIdentityChoice(
  teamKey: string | undefined,
  handle: string | undefined,
): AgentIdentityChoice | undefined {
  return useViewerStore(
    useShallow((s) => {
      if (handle === undefined || !s.agentIdentity) return undefined;
      if (teamKey !== undefined) return s.agentIdentity[teamKey]?.[handle];
      // Every team's looks together: the last team holding the handle wins, as the merge does.
      let chosen: AgentIdentityChoice | undefined;
      for (const team of Object.values(s.agentIdentity)) chosen = team[handle] ?? chosen;
      return chosen;
    }),
  );
}
