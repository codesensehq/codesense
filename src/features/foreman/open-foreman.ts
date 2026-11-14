// SPDX-License-Identifier: MIT
/**
 * The Foreman tab: the bundled Foreman page, opened as one centre tab in the CodeSense docs
 * team. App start, the identity menu and the palette all come through here, so there is
 * never more than one (a tab opens by its path, and an open one is focused).
 */
import { openCodesenseDocsLanding } from "@/features/org/lib/codesense-docs-landing";
import {
  CODESENSE_DOCS_FOREMAN_PAGE,
  CODESENSE_DOCS_SLUG,
  CODESENSE_DOCS_TEAM,
  pickStartLanding,
} from "@/shared/lib/codesense-docs";
import { logger } from "@/shared/lib/logger";
import { openFileInTeam } from "@/shared/lib/open-file-in-team";
import { useOrgStore } from "@/shared/stores/org-store";
import { useViewerStore } from "@/shared/stores/viewer-store";

/** The role the Foreman reads its mail from. */
export const FOREMAN_ROLE = "codesense-foreman";

function foremanPagePath(): string | null {
  const docs = useOrgStore.getState().orgs.find((o) => o.slug === CODESENSE_DOCS_SLUG);
  return docs ? `${docs.org_root.replace(/\/+$/, "")}/${CODESENSE_DOCS_FOREMAN_PAGE}` : null;
}

/** Open the Foreman tab, or focus it when it is open. A no-op until the docs repo is connected. */
export function openForeman(): void {
  const path = foremanPagePath();
  if (!path) return;
  try {
    openFileInTeam({ org: CODESENSE_DOCS_SLUG, team: CODESENSE_DOCS_TEAM, path }, { newTab: true });
  } catch (e) {
    logger.warn("viewer", `open the Foreman failed: ${String(e)}`);
  }
}

let startLandingDone = false;

/** Test seam: forget that this app start has already landed. */
export function resetStartLanding(): void {
  startLandingDone = false;
}

/**
 * Open what a start lands on (see `pickStartLanding`), once per app start: a later org
 * refresh (a repo attached) must not pull the user back to it.
 */
export function openStartLanding(readmePath: string): void {
  // Both landings open in the docs team: wait for a discovery that has loaded it.
  if (startLandingDone) return;
  const foremanPath = foremanPagePath();
  if (!foremanPath) return;
  startLandingDone = true;
  const landing = pickStartLanding({
    orgs: useOrgStore.getState().orgs,
    openForemanOnStart: useViewerStore.getState().settings.openForemanOnStart,
  });
  if (landing === "foreman") openCodesenseDocsLanding(foremanPath);
  else if (landing === "readme") openCodesenseDocsLanding(readmePath);
}
