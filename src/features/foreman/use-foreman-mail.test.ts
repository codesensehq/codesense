// SPDX-License-Identifier: MIT
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readRoles } = vi.hoisted(() => ({ readRoles: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@/tauri/commands", () => ({ agentReadRoles: readRoles }));

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
});
