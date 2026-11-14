// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/lib/context-navigation", () => ({ beginContextNavigation: vi.fn() }));

import {
  CODESENSE_DOCS_README,
  CODESENSE_DOCS_SLUG,
  CODESENSE_DOCS_TEAM,
} from "@/shared/lib/codesense-docs";
import { buildTeamKey } from "@/shared/lib/team-key";
import { useOrgStore } from "@/shared/stores/org-store";
import { useViewerStore } from "@/shared/stores/viewer-store";
import type { Org } from "@/shared/types/domain";

import { openForeman, openStartLanding, resetStartLanding } from "./open-foreman";

const DOCS_ROOT = "/home/u/CodeSense/docs";
const DOCS_TEAM_KEY = buildTeamKey(CODESENSE_DOCS_SLUG, CODESENSE_DOCS_TEAM);
const FOREMAN = `${DOCS_ROOT}/getting-started/content/foreman/index.html`;
const README = `${DOCS_ROOT}/${CODESENSE_DOCS_README}`;

const org = (slug: string, root: string, team: string): Org =>
  ({ slug, display_name: slug, org_root: root, teams: [{ name: team }] }) as unknown as Org;
const docsOrg = org(CODESENSE_DOCS_SLUG, DOCS_ROOT, CODESENSE_DOCS_TEAM);
const acme = org("local/acme", "/home/u/acme", "core");

function connect(orgs: Org[], active: string | null, team: string | null) {
  useOrgStore.setState({ orgs, activeOrgSlug: active, activeTeamName: team });
}
function setting(on: boolean | undefined) {
  useViewerStore.setState({
    settings: { ...useViewerStore.getState().settings, openForemanOnStart: on },
  });
}
const paths = (teamKey: string) =>
  (useViewerStore.getState().openTabs[teamKey] ?? []).map((t) => t.path);

beforeEach(() => {
  resetStartLanding();
  useViewerStore.setState({ openTabs: {}, activeTab: {}, openedTeams: [] });
  setting(undefined);
});

describe("start-up routing", () => {
  it("zero user repos, setting on: opens the Foreman page, not the README", () => {
    connect([docsOrg], null, null);
    openStartLanding(README);
    expect(paths(DOCS_TEAM_KEY)).toEqual([FOREMAN]);
    expect(useViewerStore.getState().activeTab[DOCS_TEAM_KEY]).toBe(FOREMAN);
  });

  it("zero user repos, setting off: the README, as before", () => {
    setting(false);
    connect([docsOrg], null, null);
    openStartLanding(README);
    expect(paths(DOCS_TEAM_KEY)).toEqual([README]);
  });

  it("one user repo with restored tabs, setting on: the Foreman opens focused, the tabs stay", () => {
    connect([docsOrg, acme], "local/acme", "core");
    const acmeKey = buildTeamKey("local/acme", "core");
    useViewerStore.setState({
      openTabs: {
        [DOCS_TEAM_KEY]: [{ path: `${DOCS_ROOT}/restored.md`, name: "restored.md" }],
      },
    });
    openStartLanding(README);
    expect(paths(DOCS_TEAM_KEY)).toEqual([`${DOCS_ROOT}/restored.md`, FOREMAN]);
    expect(useViewerStore.getState().activeTab[DOCS_TEAM_KEY]).toBe(FOREMAN);
    expect(paths(acmeKey)).toEqual([]);
  });

  it("one user repo, setting off: nothing opens", () => {
    setting(false);
    connect([docsOrg, acme], "local/acme", "core");
    openStartLanding(README);
    expect(Object.values(useViewerStore.getState().openTabs).flat()).toEqual([]);
  });

  it("opens no setup tab on start, with the setting on or off", () => {
    for (const on of [true, false]) {
      resetStartLanding();
      setting(on);
      useViewerStore.setState({ openTabs: {}, activeTab: {} });
      connect([docsOrg], null, null);
      openStartLanding(README);
      const all = Object.values(useViewerStore.getState().openTabs).flat();
      expect(all.some((t) => t.path.includes("guide/index.html"))).toBe(false);
    }
  });

  it("lands once per start: a later org refresh does not reopen a closed tab", () => {
    connect([docsOrg], null, null);
    openStartLanding(README);
    useViewerStore.setState({ openTabs: {}, activeTab: {} });
    openStartLanding(README);
    expect(paths(DOCS_TEAM_KEY)).toEqual([]);
  });

  it("does nothing until the docs repo is connected", () => {
    connect([acme], "local/acme", "core");
    openStartLanding(README);
    expect(Object.values(useViewerStore.getState().openTabs).flat()).toEqual([]);
  });
});

describe("one Foreman tab", () => {
  it("start, then the menu and the palette entries, focus the one tab", () => {
    connect([docsOrg, acme], "local/acme", "core");
    openStartLanding(README);
    useViewerStore.setState((s) => ({
      activeTab: { ...s.activeTab, [DOCS_TEAM_KEY]: `${DOCS_ROOT}/other.md` },
    }));
    openForeman();
    openForeman();
    expect(paths(DOCS_TEAM_KEY).filter((p) => p === FOREMAN)).toHaveLength(1);
    expect(useViewerStore.getState().activeTab[DOCS_TEAM_KEY]).toBe(FOREMAN);
    expect(useOrgStore.getState().activeOrgSlug).toBe(CODESENSE_DOCS_SLUG);
  });
});
