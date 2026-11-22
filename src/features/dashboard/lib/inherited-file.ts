// SPDX-License-Identifier: MIT
import { baseName, ingestFile } from "@/features/dashboard/lib/structural-ops";
import { dirname, join, relative, trimTrailingSeparators } from "@/shared/lib/path";

// ---------------------------------------------------------------------------
// SW-XS-20 — a file a team inherits from a parent team lives at its real path in
// the parent's content (`{org_root}/{parent}/content/…`). These helpers map it
// between the parent's content and the active team's, by its path relative to
// the content root: a menu move keeps the file in its parent, and "Copy into
// ‹team›" puts a copy at the same place in the active team's content, which then
// wins for that team and its agents.
// ---------------------------------------------------------------------------

/** `team`'s content root in the same org as the active team's content root
 *  (`{org_root}/{active}/content` → `{org_root}/{team}/content`). */
export function teamContentRoot(activeContentRoot: string, team: string): string | null {
  const active = trimTrailingSeparators(activeContentRoot);
  const orgRoot = dirname(dirname(active));
  return orgRoot && orgRoot !== active ? join(orgRoot, team, "content") : null;
}

/** `filePath`'s path relative to `team`'s content root, or `null` when it is
 *  not in that team's content. */
export function pathInTeamContent(
  filePath: string,
  team: string,
  activeContentRoot: string,
): string | null {
  const root = teamContentRoot(activeContentRoot, team);
  return root ? relative(root, filePath) || null : null;
}

/** Where a copy of `filePath` (inherited from `team`) goes in the active team:
 *  the same relative path under `activeContentRoot`. */
export function teamCopyPath(
  filePath: string,
  team: string,
  activeContentRoot: string,
): string | null {
  const rel = pathInTeamContent(filePath, team, activeContentRoot);
  return rel ? join(activeContentRoot, rel) : null;
}

/** For a menu move of a file inherited from `team`: the folder in the PARENT's
 *  content matching `toDirRel` (a folder path relative to the active team's
 *  content root, `""` for the root), so the file stays in its team. */
export function parentMoveDir(
  filePath: string,
  team: string,
  toDirRel: string,
  activeContentRoot: string,
): string | null {
  const root = teamContentRoot(activeContentRoot, team);
  if (!root || !relative(root, filePath)) return null;
  return toDirRel ? join(root, toDirRel) : root;
}

export type CopyIntoTeamResult =
  | { ok: true; path: string }
  | { ok: false; exists: boolean; error: string };

/**
 * Copy `filePath` (inherited from `team`) to the same path in the active team's
 * content (`activeContentRoot`), creating folders as needed. Refuses when the
 * active team already has that path — never overwrites.
 */
export async function copyIntoTeam(
  filePath: string,
  team: string,
  activeContentRoot: string,
  activeTeam: string,
  ingest: typeof ingestFile = ingestFile,
): Promise<CopyIntoTeamResult> {
  const dest = teamCopyPath(filePath, team, activeContentRoot);
  if (!dest) return { ok: false, exists: false, error: `Couldn't find where ${team}'s file goes.` };
  const r = await ingest(filePath, dirname(dest), baseName(dest));
  if (r.ok) return { ok: true, path: r.path ?? dest };
  if (r.collision) {
    return {
      ok: false,
      exists: true,
      error: `${activeTeam} already has ${pathInTeamContent(filePath, team, activeContentRoot)}. Open that file instead.`,
    };
  }
  return { ok: false, exists: false, error: `Couldn't copy into ${activeTeam}: ${r.error}` };
}
