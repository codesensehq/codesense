// SPDX-License-Identifier: MIT
import type { DerivedPipelineTree } from "../pipeline-graph/types";
import { isAbsolute, samePath, split } from "@/shared/lib/path";

/**
 * SW-DX-8 — resolve a `$scope` sub-epic NAME (or dirPath / absolute path) to its
 * subtree node, so the inline island can turn an authored `scope:` name into the
 * `absoluteDirPath` that bounds the connectivity fan. Pre-order DFS, first
 * (shallowest) match wins; `null` when unknown (drives the empty-scope state, no
 * throw). Reuses the `find-enclosing-epic.ts` walk idiom (`subEpics` recursion +
 * a separator-guarded suffix match) — NOT a hand-rolled second tree walk.
 */
export function findSubtreeByScope(
  tree: DerivedPipelineTree,
  scope: string,
): DerivedPipelineTree | null {
  const want = scope.trim();
  if (want === "") return null;

  // A relative scope also matches as a segment-wise suffix (so `.../seamless-workspaces`
  // doesn't match `spaces`); a rooted one only as the whole path.
  const tail = isAbsolute(want) ? [] : split(want);
  const matches = (n: DerivedPipelineTree): boolean =>
    n.dirName === want ||
    n.dirPath === want ||
    samePath(n.absoluteDirPath, want) ||
    endsWithSegments(n.absoluteDirPath, tail);

  const walk = (n: DerivedPipelineTree): DerivedPipelineTree | null => {
    if (matches(n)) return n;
    for (const sub of n.subEpics) {
      const found = walk(sub);
      if (found) return found;
    }
    return null;
  };

  return walk(tree);
}

/** True when `path`'s last segments are `tail` (non-empty), across separators. */
function endsWithSegments(path: string, tail: readonly string[]): boolean {
  if (tail.length === 0) return false;
  const have = split(path);
  return (
    tail.length <= have.length &&
    tail.every((seg, i) => seg === have[have.length - tail.length + i])
  );
}
