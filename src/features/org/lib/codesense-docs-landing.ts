// SPDX-License-Identifier: MIT
import { toast } from "sonner";

import { buildTeamKey } from "@/shared/lib/team-key";
import { useOrgStore } from "@/shared/stores/org-store";
import { useViewerStore } from "@/shared/stores/viewer-store";

import {
  CODESENSE_DOCS_README,
  CODESENSE_DOCS_SETUP,
  CODESENSE_DOCS_SLUG,
  CODESENSE_DOCS_TEAM,
} from "@/shared/lib/codesense-docs";

/**
 * Runs `decide` once the org and viewer stores have restored the persisted session, so the
 * launch decision (reopen the last context repo vs. first launch) never races the restore,
 * however long it takes: picking the docs before the last-opened repo is known would
 * overwrite it. Returns a cancel. (Both stores always settle: a failed restore still marks
 * itself loaded, and App's boot watchdog forces a stuck viewer restore.)
 */
export function afterPersistedSelectionRestored(decide: () => void): () => void {
  const loaded = () => useOrgStore.getState().stateLoaded && useViewerStore.getState().stateLoaded;
  if (loaded()) {
    decide();
    return () => {};
  }
  let done = false;
  const check = () => {
    if (done || !loaded()) return;
    done = true;
    stop();
    decide();
  };
  const unsubscribeOrg = useOrgStore.subscribe(check);
  const unsubscribeViewer = useViewerStore.subscribe(check);
  const stop = () => {
    unsubscribeOrg();
    unsubscribeViewer();
  };
  return () => {
    done = true;
    stop();
  };
}

/**
 * A page of the docs repo as a tab of its "Getting started" team. Says why when it can't: the
 * docs repo is not connected, or its team can't be selected.
 */
function openDocsPage(
  relPath: string,
  options: { keepLayout?: boolean; hash?: string },
): "opened" | "no-docs" | "no-team" {
  const docs = useOrgStore.getState().orgs.find((org) => org.slug === CODESENSE_DOCS_SLUG);
  if (!docs) return "no-docs";
  const org = useOrgStore.getState();
  if (org.activeOrgSlug !== CODESENSE_DOCS_SLUG || org.activeTeamName !== CODESENSE_DOCS_TEAM) {
    org.setActiveTeamIn(CODESENSE_DOCS_SLUG, CODESENSE_DOCS_TEAM);
  }
  const { activeOrgSlug, activeTeamName } = useOrgStore.getState();
  if (activeOrgSlug !== CODESENSE_DOCS_SLUG || activeTeamName !== CODESENSE_DOCS_TEAM)
    return "no-team";
  const teamKey = buildTeamKey(CODESENSE_DOCS_SLUG, CODESENSE_DOCS_TEAM);
  const path = `${docs.org_root.replace(/[/\\]+$/, "")}/${relPath}`;
  useViewerStore.getState().openFile(teamKey, "", path, {
    ...(options.keepLayout ? { keepLayout: true } : {}),
    ...(options.hash ? { hash: options.hash } : {}),
  });
  return "opened";
}

/**
 * The docs README, as a landing (not the user's open: full-screen CLI stays on). A launch
 * that lands in the docs for a profile with a context repo of its own but no saved selection
 * opens this, so it never lands on an empty docs team.
 */
export function openCodesenseDocsReadme(): boolean {
  return openDocsPage(CODESENSE_DOCS_README, { keepLayout: true }) === "opened";
}

/**
 * The CodeSense setup page, opened as a tab in the docs team. First launch lands here
 * (not a user's open, so full-screen CLI stays on); the identity menu row and the palette
 * item reopen it. The page owns the agent: an open tab is simply focused (its live agent
 * is reused), and a tab with none launches `/codesense-setup`, which reads the setup
 * ledger and carries on at the first step not done. `resume` adds the `#resume` route,
 * so a fresh launch says `resume` instead of treating the open as a first one.
 * False when the page can't open; a reopen (not a landing) says why in a toast.
 */
export function openCodesenseSetup(options: { resume?: boolean; landing?: boolean } = {}): boolean {
  const result = openDocsPage(CODESENSE_DOCS_SETUP, {
    keepLayout: options.landing,
    hash: options.resume ? "#resume" : undefined,
  });
  if (result !== "opened" && !options.landing) {
    toast.info(
      result === "no-docs" ? "CodeSense docs aren't connected yet" : "Couldn't open the setup page",
    );
  }
  return result === "opened";
}
