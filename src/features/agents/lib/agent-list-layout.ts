// SPDX-License-Identifier: MIT
/**
 * Pure arrangements of the resolved agent tree: workspace cards, management trees, or status.
 * The viewer store persists the person's global arrangement preference.
 */

import type { AgentTreeNode } from "@/features/viewer/lib/agent-list-view";
import { NO_WORKSPACE_ID } from "@/shared/lib/workspace-key";

/** The no-workspace bucket: an agent whose tab and story name no workspace. */
export { NO_WORKSPACE_ID };

/** Every node of the tree, depth-first, launched ones included. */
export function flattenNodes(nodes: readonly AgentTreeNode[]): AgentTreeNode[] {
  const out: AgentTreeNode[] = [];
  const walk = (list: readonly AgentTreeNode[]) => {
    for (const n of list) {
      out.push(n);
      if (n.children.length > 0) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
