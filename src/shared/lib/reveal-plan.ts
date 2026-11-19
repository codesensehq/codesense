// SPDX-License-Identifier: MIT
/**
 * What revealing an opened file does to the nav, as a pure function of paths, so
 * the store's reveal can be tested on POSIX, drive-letter and UNC paths without
 * the store. The store keeps reading its slices and writing the result.
 */
import { dirname, isWithin, join, samePath } from "./path";

export interface RevealInput {
  /** The team's content root. */
  treeRoot: string;
  /** The opened file as the nav lists it. */
  navigationPath: string;
  /** The team's drill folder; the root when not drilled. */
  currentDrill: string;
  /** The pipeline scope, a `/`-delimited path under the root; `""` when unscoped. */
  currentScope: string;
  /** Whether the file is a story file (`isPipelineFileName` of its name). */
  isPipelineFile: boolean;
}

export interface RevealPlan {
  /** Folders between the file and the root, nearest first, in `navigationPath`'s spelling. */
  ancestors: string[];
  /** The drill to keep: the current one when it holds the file, else the root. */
  effectiveDrill: string;
  /** Clear the pipeline scope. */
  resetScope: boolean;
  /** The file is under the root. */
  insideViewerRoot: boolean;
}

/** `path` is inside `dir` and is not `dir` itself. */
function isStrictlyWithin(dir: string, path: string): boolean {
  return isWithin(dir, path) && !samePath(dir, path);
}

/**
 * The reveal for an opened file:
 * - Expand every folder between the file and the root, so its row is visible.
 * - Keep the drill when it holds the file; otherwise reset it to the root, and clear a
 *   set pipeline scope with it, so isDrilledIn and the scoped tree stay in sync (else
 *   the root's entries leak into the scoped nav).
 * - A non-story file (a README, say) outside the scope clears the scope; inside it, the
 *   scope stays. A story file never touches the scope.
 */
export function planReveal({
  treeRoot,
  navigationPath,
  currentDrill,
  currentScope,
  isPipelineFile,
}: RevealInput): RevealPlan {
  const effectiveDrill = isStrictlyWithin(currentDrill, navigationPath) ? currentDrill : treeRoot;
  let resetScope = effectiveDrill !== currentDrill && currentScope !== "";

  // Sliced with `dirname`, never re-joined, so each ancestor matches the nav's own row paths.
  const ancestors: string[] = [];
  let parent = dirname(navigationPath);
  while (isStrictlyWithin(treeRoot, parent)) {
    ancestors.push(parent);
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }

  const insideViewerRoot = isStrictlyWithin(treeRoot, navigationPath);
  if (insideViewerRoot && !isPipelineFile && currentScope !== "") {
    if (!isWithin(join(treeRoot, currentScope), navigationPath)) resetScope = true;
  }

  return { ancestors, effectiveDrill, resetScope, insideViewerRoot };
}
