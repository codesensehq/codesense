// SPDX-License-Identifier: MIT
/**
 * A cancelable keydown whose AltGraph state is given, as a browser reports it. happy-dom answers
 * `getModifierState("AltGraph")` with the Alt key's state, which would make every Ctrl+Alt chord
 * look like AltGr.
 */
export function keydown(
  init: KeyboardEventInit & { key: string },
  { altGraph = false }: { altGraph?: boolean } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "getModifierState", {
    value: (name: string) => name === "AltGraph" && altGraph,
  });
  return event;
}
