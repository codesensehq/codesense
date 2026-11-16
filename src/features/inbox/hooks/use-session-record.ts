// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { safeUnlisten } from "@/shared/lib/tauri-listeners";
import { sessionRecord } from "@/tauri/commands";

/** What the chat's record line reads of an agent's session record (`sessionRecord`). */
export interface SessionRecordFacts {
  /** The session and the earlier sessions of its handoff chain, whose usage it counts. */
  sessionIds: string[];
  model: string | null;
  /** The priced cost; null when no part of it has a rate. */
  costUsd: number | null;
  /** Why `costUsd` is only part of the cost (a model with no rate), else null. */
  costPartial: string | null;
  /** How many files the session's commits changed (the record always lists them, maybe none). */
  files: number;
  /** Why `files` is only part of them (commits that could not all be read), else null. */
  filesPartial: string | null;
  story: string | null;
}

/** The events a session record moves with, each naming its session (as the live hub reads them). */
const RECORD_EVENTS = ["mcp:agent-progress", "mcp:agent-done", "pty-exit", "session-usage-changed"];

const sessionIdsOf = (payload: unknown): string[] => {
  const p = (payload ?? {}) as { sessionId?: unknown; session_id?: unknown; sessionIds?: unknown };
  const ids = Array.isArray(p.sessionIds) ? p.sessionIds : [p.sessionId ?? p.session_id];
  return ids.filter((id): id is string => typeof id === "string" && id !== "");
};

function factsOf(raw: unknown): SessionRecordFacts | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  // `{field: reason}` for each figure the record has only in part, or not at all.
  const unavailable = (
    r.unavailable && typeof r.unavailable === "object" ? r.unavailable : {}
  ) as Record<string, unknown>;
  const unpriced = strings(r.unpricedModels);
  return {
    sessionIds: strings(r.sessionIds),
    model: text(r.model),
    costUsd: typeof r.costUsd === "number" && Number.isFinite(r.costUsd) ? r.costUsd : null,
    costPartial:
      text(unavailable.cost) ?? (unpriced.length ? `no rate for ${unpriced.join(", ")}` : null),
    files: Array.isArray(r.files) ? r.files.length : 0,
    filesPartial: text(unavailable.files),
    story: text(r.story),
  };
}

/**
 * The session record of the agent launched under `handle`, read now and again whenever its
 * progress, end or stored usage moves (the host debounces usage to about 2 s). A read that
 * fails leaves the last record: the line shows what it knew, never a guess.
 */
export function useSessionRecord(
  handle: string | null,
  sessionId: string | null,
): SessionRecordFacts | null {
  const [state, setState] = useState<{ handle: string; facts: SessionRecordFacts | null }>();
  const known = useRef<string[]>([]);
  // One read at a time: an event while one runs asks for one more read after it, not another
  // read beside it. A read for an older handle gives way to the newer one's.
  const flight = useRef<{ handle: string; again: boolean } | null>(null);

  const reload = useCallback(async () => {
    if (!handle) return;
    if (flight.current?.handle === handle) {
      flight.current.again = true;
      return;
    }
    const mine = { handle, again: false };
    flight.current = mine;
    const done = (facts: SessionRecordFacts | null) => {
      known.current = facts?.sessionIds ?? [];
      setState({ handle, facts });
    };
    try {
      do {
        mine.again = false;
        let read: { facts: SessionRecordFacts | null } | null = null;
        try {
          read = { facts: factsOf(await sessionRecord({ handle })) };
        } catch {
          // Keep what the line showed.
        }
        if (flight.current !== mine) return;
        if (read) done(read.facts);
      } while (mine.again);
    } finally {
      if (flight.current === mine) flight.current = null;
    }
  }, [handle]);

  useEffect(() => {
    if (!handle) return;
    void reload();
    const offs = RECORD_EVENTS.map((event) =>
      listen(event, ({ payload }) => {
        const ids = sessionIdsOf(payload);
        if (ids.some((id) => id === sessionId || known.current.includes(id))) void reload();
        // No event bus (a plain browser, a test): the read still happens once.
      }).catch(() => () => {}),
    );
    return () => offs.forEach((off) => void off.then(safeUnlisten).catch(() => {}));
  }, [handle, sessionId, reload]);

  return state && state.handle === handle ? state.facts : null;
}

/** A cost as the record line says it: "$1.26", or "<$0.01" for a fraction of a cent. */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** A model id as people say it: "claude-opus-5-5" is "Opus 5.5"; any other id as it is. */
export function modelLabel(id: string): string {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)(?:-|$)/.exec(id);
  if (!m) return id;
  const [, family, major, minor] = m;
  return `${family![0]!.toUpperCase()}${family!.slice(1)} ${major}.${minor}`;
}
