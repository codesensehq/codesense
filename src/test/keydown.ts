// SPDX-License-Identifier: MIT
import { keydownEvent } from "@/shared/lib/shortcuts/keystroke";

/** A cancelable keydown whose AltGraph state is given, as a browser reports it ({@link keydownEvent}). */
export function keydown(
  init: KeyboardEventInit & { key: string },
  { altGraph = false }: { altGraph?: boolean } = {},
): KeyboardEvent {
  return keydownEvent({ bubbles: true, cancelable: true, ...init, modifierAltGraph: altGraph });
}
