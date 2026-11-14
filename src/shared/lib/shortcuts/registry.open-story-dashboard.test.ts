// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

// View → Dashboard is never silent: with no team active it says there is no story in focus.

const getActiveWorkspaceContextMock = vi.fn();
vi.mock("@/shared/hooks/use-active-workspace-context", () => ({
  getActiveWorkspaceContext: () => getActiveWorkspaceContextMock(),
}));

const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { info: toastInfo } }));

import { dispatchMenuAction } from "@/app/menu-action-dispatch";
import { NO_STORY_IN_FOCUS } from "@/features/dashboard/lib/open-story-dashboard";
import { NO_TEAM_SENTINEL } from "@/shared/lib/team-key";
import { isDispatchable } from "./is-dispatchable";
import { SHORTCUT_ACTIONS } from "./registry";

const ID = "viewer.open-story-dashboard";
const action = () => {
  const found = SHORTCUT_ACTIONS.find((a) => a.id === ID);
  if (!found) throw new Error(`${ID} not registered`);
  return found;
};
const noTeam = {
  settingsPanelOpen: false,
  hasActiveWorkspace: false,
  hasTeam: false,
  rowPopupFocused: false,
};

describe("viewer.open-story-dashboard", () => {
  beforeEach(() => toastInfo.mockClear());

  it("dispatches with no team open, so the item can say why", () => {
    expect(isDispatchable(action(), noTeam)).toBe(true);
  });

  it("says there is no story in focus when the menu item fires with no team active", async () => {
    getActiveWorkspaceContextMock.mockReturnValue({ teamKey: NO_TEAM_SENTINEL, workspace: null });
    dispatchMenuAction(ID);
    await vi.waitFor(() => expect(toastInfo).toHaveBeenCalledWith(NO_STORY_IN_FOCUS));
  });
});
