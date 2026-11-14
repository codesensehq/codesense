// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CODESENSE_DOCS_SLUG, CODESENSE_DOCS_TEAM } from "@/shared/lib/codesense-docs";
import { buildTeamKey } from "@/shared/lib/team-key";
import { useOrgStore } from "@/shared/stores/org-store";
import { useViewerStore } from "@/shared/stores/viewer-store";

import { openCodesenseDocsLanding, openCodesenseSetup } from "./codesense-docs-landing";

const { toastInfo } = vi.hoisted(() => ({ toastInfo: vi.fn() }));
vi.mock("sonner", () => ({ toast: { info: toastInfo } }));

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
    toastInfo.mockClear();
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

  it("does nothing without the docs repo, and says so", () => {
    useOrgStore.setState({ orgs: [] });
    expect(openCodesenseSetup({ resume: true })).toBe(false);
    expect(useViewerStore.getState().activeTab[KEY]).toBeUndefined();
    expect(toastInfo).toHaveBeenCalledWith(expect.stringContaining("docs aren't connected"));
  });

  it("with the docs connected but their team not selectable, it says that, not that the docs are missing", () => {
    const real = useOrgStore.getState().setActiveTeamIn;
    useOrgStore.setState({ setActiveTeamIn: () => {} } as never);
    expect(openCodesenseSetup({ resume: true })).toBe(false);
    useOrgStore.setState({ setActiveTeamIn: real });
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastInfo).toHaveBeenCalledWith("Couldn't open the setup page");
  });

  it("a landing without the docs repo stays quiet", () => {
    useOrgStore.setState({ orgs: [] });
    expect(openCodesenseSetup({ landing: true })).toBe(false);
    expect(toastInfo).not.toHaveBeenCalled();
  });
});

describe("openCodesenseDocsLanding", () => {
  it("opens the page as a landing, in the docs team", () => {
    useOrgStore.setState({ orgs: [docs] as never, activeOrgSlug: null, activeTeamName: null });
    useViewerStore.setState({
      openedTeams: [],
      activeTab: {},
      openTabs: {},
      layoutMode: "console",
      terminalVisible: true,
    });
    openCodesenseDocsLanding(`${ROOT}/getting-started/content/README.html`);
    expect(useViewerStore.getState().activeTab[KEY]).toBe(
      `${ROOT}/getting-started/content/README.html`,
    );
    expect(useViewerStore.getState().layoutMode).toBe("console");
  });
});
