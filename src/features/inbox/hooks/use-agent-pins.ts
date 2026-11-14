// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { safeUnlisten } from "@/shared/lib/tauri-listeners";
import { agentPins, type AgentPin, type InboxTeam } from "@/tauri/commands";
import { AGENT_PINS_CHANGED_EVENT } from "@/tauri/events";

const NO_PINS: AgentPin[] = [];

/**
 * The pins of the thread of saved agent `agentId` on `storyId`, in `team`'s store, read now
 * and again whenever the engine says that thread's list changed. A session launched from no
 * saved agent has no thread, so no pins.
 */
export function useAgentPins(
  team: InboxTeam | null,
  agentId: string | null,
  storyId: string | null,
): { pins: AgentPin[]; error: string | null } {
  // The thread's name: a result for an older thread is never shown under a newer one.
  const key =
    team && agentId ? JSON.stringify([team.org, team.team, agentId, storyId ?? ""]) : null;
  const [state, setState] = useState<{ key: string; pins: AgentPin[]; error: string | null }>();
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!key || !team || !agentId) return;
    const mine = ++seq.current;
    const done = (pins: AgentPin[], error: string | null) => {
      if (mine === seq.current) setState({ key, pins, error });
    };
    try {
      const r = await agentPins(team, agentId, storyId, { op: "read" });
      if (r.status === "pins") done(r.pins, null);
      else done(NO_PINS, r.message);
    } catch (err) {
      done(NO_PINS, err instanceof Error ? err.message : String(err));
    }
    // `team` is named by `key`; its object identity may change on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!key) return;
    void reload();
    const sub = listen<{ org: string; team: string; agentId: string; storyId: string }>(
      AGENT_PINS_CHANGED_EVENT,
      ({ payload: p }) => {
        if (JSON.stringify([p.org, p.team, p.agentId, p.storyId]) === key) void reload();
      },
      // No event bus (a plain browser, a test): the read still happens once.
    ).catch(() => () => {});
    return () => void sub.then(safeUnlisten).catch(() => {});
  }, [key, reload]);

  const current = state && state.key === key ? state : null;
  return { pins: current?.pins ?? NO_PINS, error: current?.error ?? null };
}
