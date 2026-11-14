// SPDX-License-Identifier: MIT
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useLaunchStories } from "./use-launch-stories";

const content = vi.hoisted(() => ({ value: { kind: "no-teams" } as Record<string, unknown> }));
vi.mock("@/shared/hooks/use-team-content-context", () => ({
  useTeamContentContext: () => content.value,
}));

describe("useLaunchStories", () => {
  it("settles to an empty list with no error when the org has no teams", () => {
    content.value = { kind: "no-teams" };
    const { result } = renderHook(() => useLaunchStories("acme:_none"));
    expect(result.current).toEqual({ stories: [], loading: false });
  });
  it("reports an unavailable context with its error", () => {
    content.value = { kind: "unavailable", error: "gone" };
    const { result } = renderHook(() => useLaunchStories("acme:alpha"));
    expect(result.current).toEqual({ stories: [], loading: false, error: "gone" });
  });
  it("keeps loading while the context loads", () => {
    content.value = { kind: "loading" };
    const { result } = renderHook(() => useLaunchStories("acme:alpha"));
    expect(result.current).toEqual({ stories: [], loading: true });
  });
});
