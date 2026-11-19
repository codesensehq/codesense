// SPDX-License-Identifier: MIT
import { isWithin } from "@/shared/lib/path";
/** A coarse refresh, exact file event, or directory event containing this file. */
export function fileChangeAffects(
  changedPaths: Set<string> | null | undefined,
  filePath: string | null,
): boolean {
  if (!changedPaths) return true;
  if (!filePath) return false;
  for (const changed of changedPaths) {
    if (isWithin(changed, filePath)) return true;
  }
  return false;
}
