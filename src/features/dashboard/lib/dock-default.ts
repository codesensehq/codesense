// SPDX-License-Identifier: MIT
/**
 * With no saved dock choice the dock shows the built-in HTML `agent-list`, not the
 * classic native list. One switch for the whole app (the dock, the slot reader and Settings all
 * resolve a missing choice through it). A saved choice always wins: `"native"` keeps the classic
 * list and a saved ref keeps that pane. The classic list stays the fallback when a pane fails.
 */
export const DOCK_DEFAULT_HTML_AGENT_LIST = true;
