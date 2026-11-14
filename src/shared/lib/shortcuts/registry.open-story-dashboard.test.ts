// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

// View → Dashboard is never silent: with no team active it says there is no story in focus.

const getActiveWorkspaceContextMock = vi.fn();
vi.mock("@/shared/hooks/use-active-workspace-context", () => ({
  getActiveWorkspaceContext: () => getActiveWorkspaceContextMock(),
}));

const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { info: toastInfo } }));

import { NO_STORY_IN_FOCUS } from "@/features/dashboard/lib/open-story-dashboard";
import { NO_TEAM_SENTINEL } from "@/shared/lib/team-key";
import { SHORTCUT_ACTIONS } from "./registry";

const run = () => {
  const action = SHORTCUT_ACTIONS.find((a) => a.id === "viewer.open-story-dashboard");
  if (!action) throw new Error("viewer.open-story-dashboard not registered");
  action.run();
};

describe("viewer.open-story-dashboard", () => {
  beforeEach(() => toastInfo.mockClear());

  it("says there is no story in focus when no team is active", async () => {
    getActiveWorkspaceContextMock.mockReturnValue({ teamKey: NO_TEAM_SENTINEL, workspace: null });
    run();
    await vi.waitFor(() => expect(toastInfo).toHaveBeenCalledWith(NO_STORY_IN_FOCUS));
  });
});
