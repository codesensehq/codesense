// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it } from "vitest";

import { CODESENSE_DOCS_SLUG, CODESENSE_DOCS_TEAM } from "@/shared/lib/codesense-docs";
import { buildTeamKey } from "@/shared/lib/team-key";
import { useOrgStore } from "@/shared/stores/org-store";
import { useViewerStore } from "@/shared/stores/viewer-store";

import { openCodesenseSetup } from "./codesense-docs-landing";

const ROOT = "/home/.codesense/users/guest/codesense-docs";
const SETUP = `${ROOT}/getting-started/content/guide/index.html`;
const KEY = buildTeamKey(CODESENSE_DOCS_SLUG, CODESENSE_DOCS_TEAM);
const docs = {
  slug: CODESENSE_DOCS_SLUG,
  display_name: "CodeSense Docs",
  org_root: ROOT,
  teams: [{ name: CODESENSE_DOCS_TEAM, source_repos: [] }],
};

describe("openCodesenseSetup", () => {
  beforeEach(() => {
    useOrgStore.setState({
      orgs: [docs] as never,
      activeOrgSlug: null,
      activeTeamName: null,
      lastTeamByOrgSlug: {},
    });
    useViewerStore.setState({ openedTeams: [], activeTab: {}, openTabs: {}, layoutMode: null });
  });

  it("opens the setup page in the docs team and makes it the active tab", () => {
    expect(openCodesenseSetup()).toBe(true);
    expect(useOrgStore.getState().activeOrgSlug).toBe(CODESENSE_DOCS_SLUG);
    expect(useViewerStore.getState().activeTab[KEY]).toBe(SETUP);
  });

  it("reuses the tab it opened: a second open does not add another", () => {
    openCodesenseSetup();
    openCodesenseSetup({ resume: true });
    const tabs = useViewerStore.getState().openTabs[KEY] ?? [];
    expect(tabs.filter((tab) => tab.path === SETUP)).toHaveLength(1);
  });

  it("a resume carries the #resume route so a fresh launch says resume", () => {
    openCodesenseSetup({ resume: true });
    expect(useViewerStore.getState().fileHashRequests[KEY]).toEqual({
      path: SETUP,
      hash: "#resume",
    });
  });

  it("a landing keeps a full-screen CLI on; a person's open leaves it", () => {
    useViewerStore.setState({ layoutMode: "console", terminalVisible: true });
    openCodesenseSetup({ landing: true });
    expect(useViewerStore.getState().layoutMode).toBe("console");
    openCodesenseSetup();
    expect(useViewerStore.getState().layoutMode).not.toBe("console");
  });

  it("does nothing without the docs repo", () => {
    useOrgStore.setState({ orgs: [] });
    expect(openCodesenseSetup()).toBe(false);
    expect(useViewerStore.getState().activeTab[KEY]).toBeUndefined();
  });
});
