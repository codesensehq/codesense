// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it } from "vitest";

import {
  builtinAgentListRef,
  useDashboardProfileStore,
} from "@/features/dashboard/lib/dashboard-profile";
import { useOrgStore } from "@/shared/stores/org-store";
import type { DashboardProfile, DashboardRef } from "@/tauri/commands";
import { dashboardSelected, selectedRefs } from "./reveal-slot";
import { singleSlotChoice } from "./single-slot-dashboard";

const ref: DashboardRef = { scope: "team", org: "acme", team: "a", id: "people" };
const builtin = builtinAgentListRef("acme");
const profile = (slots: DashboardProfile["slots"]): DashboardProfile =>
  ({
    id: "default",
    name: "Default",
    posture: "",
    slots,
    cliLayout: "default",
    chrome: {},
  }) as never;

beforeEach(() => {
  useOrgStore.setState({ activeOrgSlug: "acme", activeTeamName: "a" });
  useDashboardProfileStore.setState({ org: "acme", profile: profile({}), warm: {} });
});

describe("the dock's default dashboard", () => {
  it("is the built-in HTML agent list when no choice is saved", () => {
    expect(selectedRefs("dock", "acme")).toEqual([builtin]);
    expect(singleSlotChoice("dock")).toEqual(builtin);
    expect(dashboardSelected(builtin, false, "dock")).toBe(true);
  });

  it("is the built-in HTML agent list for a saved classic choice", () => {
    useDashboardProfileStore.setState({ profile: profile({ dock: "native" }) });
    expect(selectedRefs("dock", "acme")).toEqual([builtin]);
    expect(singleSlotChoice("dock")).toEqual(builtin);
    expect(dashboardSelected(builtin, false, "dock")).toBe(true);
  });

  it("gives way to a saved dashboard", () => {
    useDashboardProfileStore.setState({ profile: profile({ dock: ref }) });
    expect(selectedRefs("dock", "acme")).toEqual([ref]);
    expect(dashboardSelected(builtin, false, "dock")).toBe(false);
  });

  it("never uses another organization's saved choice", () => {
    useDashboardProfileStore.setState({ profile: profile({ dock: ref }) });
    expect(selectedRefs("dock", "other")).toEqual([builtinAgentListRef("other")]);
  });
});
