// SPDX-License-Identifier: MIT
import { itemFilePath, type FlatNavItem } from "@/features/dashboard/lib/flatten-nav-tree";
import { isAbsolute, join, relative, root, trimTrailingSeparators } from "@/shared/lib/path";
import type { NavContextMenuState } from "./types";

export function dashboardNavTarget(
  row: Record<string, unknown>,
  contentRoot: string,
  items: FlatNavItem[],
): Omit<NavContextMenuState, "x" | "y"> | null {
  if (
    !["story", "epic", "file"].includes(String(row.kind)) ||
    typeof row.path !== "string" ||
    !row.path ||
    row.path
      .slice(root(row.path).length)
      .split(/[\\/]/)
      .some((p) => p === ".." || p === "." || !p)
  )
    return null;
  const base = trimTrailingSeparators(contentRoot);
  const path = isAbsolute(row.path) ? row.path : join(base, row.path);
  for (const item of items) {
    if (
      row.kind === "epic" &&
      item.type === "folder-header" &&
      (item.node.absoluteDirPath === path || item.node.mainDoc?.filePath === path)
    )
      return {
        path: item.node.absoluteDirPath,
        epicDirPath: item.node.dirPath,
        epicFilePath: item.node.mainDoc?.filePath,
        isEpic: item.node.mainDoc !== null,
      };
    if (itemFilePath(item) === path && (row.kind === "file" || item.type === "story"))
      return { path };
  }
  return row.kind === "file" && relative(base, path) ? { path } : null;
}
