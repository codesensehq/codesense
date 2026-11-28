// SPDX-License-Identifier: MIT
import { useMemo, useRef, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";

import { agentRowLabel } from "@/features/viewer/lib/agent-row-presentation";
import { duplicateFaceTags, resolveAgentFace } from "@/features/viewer/lib/agent-list-view";
import { isAgentSession } from "@/features/viewer/lib/hand-agents";
import { useAgentListProjectionStore } from "@/features/viewer/lib/agent-list-projection";
import {
  identityChoicesOf,
  useAgentIdentityChoices,
} from "@/features/viewer/hooks/use-listed-agents";
import { useAvatarPacks } from "@/shared/hooks/use-avatar-packs";
import {
  findTabLocationBySessionId,
  selectMinimizedTerminalTabIndex,
  selectRunningTerminalTabIndex,
  useViewerStore,
  type TerminalTabIndex,
} from "@/shared/stores/viewer-store";
import type { AgentIdentityChoice } from "@/shared/lib/agent-identity-choice";
import type { AgentSessionRow } from "@/tauri/commands";

const NO_TAGS: ReadonlyMap<string, number> = new Map();

/**
 * The number each of a team's running agents wears when another of them shows the same face
 * ({@link duplicateFaceTags}), by session handle. The team's agents are those whose tab sits
 * in one of its workspaces, plus those with no tab at all (the agents list shows them with the
 * team). The agents list, the workspace pills and the tile tabs all read this, so one agent
 * carries one number everywhere. `teamKey` null (a surface that cannot place itself in a
 * team) counts every running agent.
 */
export function useFaceTags(teamKey: string | null): ReadonlyMap<string, number> {
  const sessions = useAgentListProjectionStore((s) => s.sessions);
  const choices = useAgentIdentityChoices(teamKey ?? undefined);
  const { faces } = useAvatarPacks(teamKey ?? undefined);
  const teamOf = useTabTeamBySession();
  return useMemo(
    () => faceTags(teamKey, { sessions, choices, faces, teamOf }),
    [teamKey, sessions, choices, faces, teamOf],
  );
}

/**
 * One agent's number in {@link useFaceTags}, for a surface that draws one agent (a tile's tab): read
 * from the stores at each change but returned as a number, so the caller redraws only when that
 * agent's number changes, not for every session, look or layout change. `faces` is the team's.
 */
export function useFaceTag(
  teamKey: string | null,
  handle: string | undefined,
  faces: FaceTagInput["faces"],
): number | undefined {
  const last = useRef<{ inputs: unknown[]; tags: ReadonlyMap<string, number> } | null>(null);
  const read = () => {
    if (handle === undefined) return undefined;
    const sessions = useAgentListProjectionStore.getState().sessions;
    const viewer = useViewerStore.getState();
    const running = selectRunningTerminalTabIndex(viewer);
    const minimized = selectMinimizedTerminalTabIndex(viewer);
    const inputs = [teamKey, sessions, viewer.agentIdentity, faces, running, minimized];
    if (!last.current || inputs.some((input, i) => !Object.is(input, last.current!.inputs[i]))) {
      const choices = identityChoicesOf(viewer.agentIdentity, teamKey ?? undefined);
      last.current = {
        inputs,
        tags: faceTagsFor(teamKey, { sessions, choices, faces, running, minimized }),
      };
    }
    return last.current.tags.get(handle);
  };
  return useSyncExternalStore(subscribeFaceTagStores, read);
}

function subscribeFaceTagStores(onChange: () => void): () => void {
  const stopSessions = useAgentListProjectionStore.subscribe(onChange);
  const stopViewer = useViewerStore.subscribe(onChange);
  return () => {
    stopSessions();
    stopViewer();
  };
}

/** The team of each session whose tab is open. A running tab wins over a minimized one. */
function teamBySession(
  minimized: TerminalTabIndex,
  running: TerminalTabIndex,
): Record<string, string> {
  const teamOf: Record<string, string> = {};
  for (const index of [minimized, running]) {
    for (const [team, byWorkspace] of Object.entries(index)) {
      for (const tabs of Object.values(byWorkspace)) {
        for (const tab of tabs) if (tab.sessionId) teamOf[tab.sessionId] = team;
      }
    }
  }
  return teamOf;
}

/** The inputs {@link faceTagsFor} reads, all from the stores. */
export interface FaceTagInput {
  sessions: readonly AgentSessionRow[] | null;
  choices: Readonly<Record<string, AgentIdentityChoice>>;
  faces: ReturnType<typeof useAvatarPacks>["faces"];
  running: TerminalTabIndex;
  minimized: TerminalTabIndex;
}

/**
 * The face tags of one team's running agents, from the stores. Pure, so the agents list can
 * compute every team's tags at once: a team's agents are the ones whose tab sits in that team.
 */
export function faceTagsFor(
  teamKey: string | null,
  input: FaceTagInput,
): ReadonlyMap<string, number> {
  const { running, minimized, ...rest } = input;
  const teamOf = teamBySession(minimized, running);
  return faceTags(teamKey, { ...rest, teamOf });
}

/** The team of every session whose tab is open, by session id: equal while no session moves, so
 *  a layout edit that leaves the tabs' teams alone does not redraw its readers. */
function useTabTeamBySession(): Readonly<Record<string, string>> {
  return useViewerStore(
    useShallow((s) =>
      teamBySession(selectMinimizedTerminalTabIndex(s), selectRunningTerminalTabIndex(s)),
    ),
  );
}

interface FaceTagSource {
  sessions: readonly AgentSessionRow[] | null;
  choices: Readonly<Record<string, AgentIdentityChoice>>;
  faces: ReturnType<typeof useAvatarPacks>["faces"];
  teamOf: Readonly<Record<string, string>>;
}

function faceTags(teamKey: string | null, input: FaceTagSource): ReadonlyMap<string, number> {
  const { sessions, choices, faces, teamOf } = input;
  if (!sessions) return NO_TAGS;
  const entries = sessions.flatMap((row) => {
    if (!isAgentSession(row)) return [];
    const team = row.sessionId ? teamOf[row.sessionId] : undefined;
    if (teamKey !== null && team !== undefined && team !== teamKey) return [];
    const face = resolveAgentFace(row, {
      name: agentRowLabel(row),
      choice: choices[row.handle],
      faces,
    });
    return [{ handle: row.handle, startedAtMs: row.startedAtMs, face }];
  });
  const tags = duplicateFaceTags(entries);
  return tags.size === 0 ? NO_TAGS : tags;
}

/** The team whose workspace holds a session's tab, if any. */
export function useTabTeamOf(sessionId: string | undefined): string | null {
  return useViewerStore((s) =>
    sessionId
      ? ((
          findTabLocationBySessionId(selectRunningTerminalTabIndex(s), sessionId) ??
          findTabLocationBySessionId(selectMinimizedTerminalTabIndex(s), sessionId)
        )?.teamKey ?? null)
      : null,
  );
}
