// SPDX-License-Identifier: MIT
import { contentPrefix } from "@/features/git-sync/lib/scope-publish-set";
import type { PrivateNavSource } from "@/tauri/commands";
import type { ContentSource } from "./team-content-context";
import type { NavSource } from "./nav-lens";
import { trimTrailingSeparators } from "@/shared/lib/path";

export function resolveNavSource(
  source: NavSource,
  clone: ContentSource | undefined,
  privateSource: PrivateNavSource | null,
  cloneRoot?: string | null,
) {
  if (source.kind === "private") {
    return {
      content: privateSource
        ? {
            repoPath: privateSource.contentPath,
            repoName: "Private",
            contextRepoPath: privateSource.repoRoot,
            teamContentPath: privateSource.contentPath,
            mainDoc: "",
          }
        : undefined,
      orgRoot: privateSource?.repoRoot ?? null,
      prefix: privateSource?.prefix ?? null,
    };
  }
  const rootPath = cloneRoot ?? clone?.contextRepoPath;
  const root = rootPath ? trimTrailingSeparators(rootPath) : null;
  return {
    content: clone,
    orgRoot: root,
    prefix: contentPrefix(root, clone?.teamContentPath),
  };
}
