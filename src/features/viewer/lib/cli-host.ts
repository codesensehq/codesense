// SPDX-License-Identifier: MIT
/**
 * The one CLI's host element, drawn once by the global CLI in the shell's workbench. Every "is
 * focus in the CLI" check and every scan for the CLI's terminals is scoped to it, so a terminal
 * drawn elsewhere (the Agents pane's quick view, a run's output) is never taken for a tile's.
 */
export const CLI_HOST_SELECTOR = "[data-xterm-host]";

/**
 * The terminal section of the workbench: the Agents pane and the CLI, side by side. Focus in the
 * Agents pane (a row, or a popup drawn in it) is in a part that unmounts when the CLI hides, so
 * it counts as CLI focus where a hide must hand focus on.
 */
export const TERMINAL_SECTION_SELECTOR = "[data-terminal-section]";

/** Where to look for the CLI's terminals: its host, or null before it has mounted. */
export function cliHostRoot(): ParentNode | null {
  return document.querySelector(CLI_HOST_SELECTOR);
}
