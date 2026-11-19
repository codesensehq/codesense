// SPDX-License-Identifier: MIT
/**
 * The worktree-watch key for a workspace's repo root. The source diff watches
 * the root its tab resolved to, which can sit above the folder the editor
 * watches under the bare workspace id, so the two take separate keys (and
 * separate `worktreeChangedPath` entries) rather than crossing on one.
 */
export function rootWatchKey(wsId: string): string {
  return `${wsId}|root`;
}
