// SPDX-License-Identifier: MIT
/**
 * Whether a chat that has just come to cover its tab may move keyboard focus into its composer.
 * It may when the focus is already in its own pane (the terminal it now hides, or the pane's
 * caption), and when nothing holds it and the pane is its workspace's active tab. It never
 * takes the focus from an element elsewhere: another cell's terminal, a text field, a dialog.
 */
export function mayCoverTakeFocus(root: Element, held: Element | null): boolean {
  const pane = root.closest("[data-focus-pane]");
  if (held && held !== document.body) return !!pane && pane.contains(held);
  return !!pane && pane.hasAttribute("data-pane-active");
}
