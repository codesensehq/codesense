// SPDX-License-Identifier: MIT
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readRoles, sessions } = vi.hoisted(() => ({
  readRoles: vi.fn(),
  sessions: { rows: [] as unknown[] | null },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@/tauri/commands", () => ({ agentReadRoles: readRoles }));
vi.mock("@/features/inbox/hooks/use-inbox-sessions", () => ({
  useInboxSessions: () => sessions.rows,
}));

import { CODESENSE_DOCS_SLUG, CODESENSE_DOCS_TEAM } from "@/shared/lib/codesense-docs";
import { useOrgStore } from "@/shared/stores/org-store";
import type { RoleQueue } from "@/tauri/commands";

import { foremanMailWaiting, useForemanMailWaiting } from "./use-foreman-mail";

const queue = (pending: number, live: boolean): RoleQueue =>
  ({
    role: "codesense-foreman",
    roleName: null,
    registrations: live ? [{ instanceId: "s1", live: true }] : [],
    counts: { pending, claimed: 0, accepted: 0, acknowledged: 0 },
    deliveries: [],
  }) as unknown as RoleQueue;

describe("foremanMailWaiting", () => {
  it("is true only with pending mail and no live holder", () => {
    expect(foremanMailWaiting(queue(1, false))).toBe(true);
    expect(foremanMailWaiting(queue(1, true))).toBe(false);
    expect(foremanMailWaiting(queue(0, false))).toBe(false);
    expect(foremanMailWaiting(undefined)).toBe(false);
  });
});

describe("useForemanMailWaiting", () => {
  beforeEach(() => {
    readRoles.mockReset();
    sessions.rows = [];
    useOrgStore.setState({
      activeOrgSlug: CODESENSE_DOCS_SLUG,
      activeTeamName: CODESENSE_DOCS_TEAM,
    });
  });

  it("shows the dot when the Foreman's queue holds mail and nobody is live", async () => {
    readRoles.mockResolvedValue({ roles: [queue(2, false)] });
    const { result } = renderHook(() => useForemanMailWaiting(true));
    await waitFor(() => expect(result.current).toBe(true));
    expect(readRoles).toHaveBeenCalledWith(
      { org: CODESENSE_DOCS_SLUG, team: CODESENSE_DOCS_TEAM },
      undefined,
      1,
    );
  });

  it("shows no dot while a Foreman is live, and reads nothing while disabled", async () => {
    readRoles.mockResolvedValue({ roles: [queue(2, true)] });
    const live = renderHook(() => useForemanMailWaiting(true));
    await waitFor(() => expect(readRoles).toHaveBeenCalled());
    expect(live.result.current).toBe(false);
    readRoles.mockClear();
    const off = renderHook(() => useForemanMailWaiting(false));
    expect(off.result.current).toBe(false);
    expect(readRoles).not.toHaveBeenCalled();
  });

  it("also reads the active team's queue", async () => {
    useOrgStore.setState({ activeOrgSlug: "local/acme", activeTeamName: "core" });
    readRoles.mockImplementation(async (team: { org: string }) => ({
      roles: [team.org === "local/acme" ? queue(1, false) : queue(0, false)],
    }));
    const { result } = renderHook(() => useForemanMailWaiting(true));
    await waitFor(() => expect(result.current).toBe(true));
  });

  // Review da9676: with no Foreman live, the newest row by start time names the team, as the
  // page's home.js reads it, whatever order the roster lists them in.
  it("with every Foreman row exited, reads the newest row's team", async () => {
    const row = (org: string, team: string, startedAtMs: number) => ({
      handle: `_worker/${org}/${team}/foreman`,
      agent: "codesense/docs/getting-started/foreman-claude",
      state: "exited",
      team: { org, team },
      startedAtMs,
    });
    sessions.rows = [row(CODESENSE_DOCS_SLUG, CODESENSE_DOCS_TEAM, 1), row("local/acme", "web", 5)];
    readRoles.mockResolvedValue({ roles: [queue(1, false)] });
    renderHook(() => useForemanMailWaiting(true));
    await waitFor(() =>
      expect(readRoles).toHaveBeenCalledWith({ org: "local/acme", team: "web" }, undefined, 1),
    );
    expect(readRoles).not.toHaveBeenCalledWith(
      { org: CODESENSE_DOCS_SLUG, team: CODESENSE_DOCS_TEAM },
      undefined,
      1,
    );
  });

  // A re-homed Foreman holds its role in a user team, so the hand-back waits there, not in the docs team.
  it("reads the queue of the team the Foreman runs in, not the docs team", async () => {
    sessions.rows = [
      {
        handle: "_worker/local/acme/web/foreman",
        agent: "codesense/docs/getting-started/foreman-claude",
        state: "exited",
        team: { org: "local/acme", team: "web" },
      },
      { handle: "other", agent: "guide-claude", state: "running", team: { org: "x", team: "y" } },
    ];
    readRoles.mockImplementation(async (team: { org: string; team: string }) => ({
      roles: [team.org === "local/acme" && team.team === "web" ? queue(1, false) : queue(3, false)],
    }));
    const { result } = renderHook(() => useForemanMailWaiting(true));
    await waitFor(() => expect(result.current).toBe(true));
    expect(readRoles).toHaveBeenCalledWith({ org: "local/acme", team: "web" }, undefined, 1);
    expect(readRoles).not.toHaveBeenCalledWith(
      { org: CODESENSE_DOCS_SLUG, team: CODESENSE_DOCS_TEAM },
      undefined,
      1,
    );
  });
});
