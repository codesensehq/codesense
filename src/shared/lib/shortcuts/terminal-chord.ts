// SPDX-License-Identifier: MIT
/**
 * The chord an action answers to while a terminal has focus.
 *
 * Off macOS, Ctrl+<letter>, Ctrl+\ and Ctrl+Space are shell input, so an app binding on one of
 * them moves to its Ctrl+Shift form in a terminal ("add Shift in a terminal"). Ctrl+[ and Ctrl+]
 * are not lifted: a binding on either has no key in a terminal. Where that chord is
 * another action's own binding the lifted action wins it and the other has no key in a terminal; the
 * terminal's copy and paste chords, Ctrl+Shift+C and Ctrl+Shift+V, win over any binding. On macOS the
 * chord is the binding itself: a terminal-claimed action matches Cmd only (`macCmdOnly`).
 */
import {
  formatKeystroke,
  hasCmd,
  isMac,
  parseKeystroke,
  type KeystrokeParts,
  type ModifierState,
} from "./keystroke";

/** Ctrl+Shift+C and Ctrl+Shift+V: terminal copy and paste off macOS. */
const TERMINAL_CLIPBOARD_CHORDS: ReadonlySet<string> = new Set([
  "CmdOrCtrl+Shift+C",
  "CmdOrCtrl+Shift+V",
]);

/** Keys that are control characters for a shell under Ctrl without Shift: letters, `\`, Space. */
function isControlKey(key: string): boolean {
  return /^[A-Z]$/.test(key) || key === "\\" || key === "Space";
}

/** Ctrl+[ is Escape and Ctrl+] a shell key: not lifted, and no action takes them from a terminal. */
function isBracketKey(key: string): boolean {
  return key === "[" || key === "]";
}

function tryParse(keystroke: string): KeystrokeParts | null {
  try {
    return parseKeystroke(keystroke);
  } catch {
    return null;
  }
}

/** `parts` with Shift added when it is a bare Ctrl control key; the same object otherwise. */
function lifted(parts: KeystrokeParts): KeystrokeParts {
  const bareControlKey = parts.cmdOrCtrl && !parts.shift && !parts.alt && isControlKey(parts.key);
  return bareControlKey ? { ...parts, shift: true } : parts;
}

/**
 * The chord `keystroke` answers to from a focused terminal, or `""` when it has none there.
 * `bindings` is every action's effective keystroke, so a chord another action lifts onto is seen.
 */
export function terminalChord(keystroke: string, bindings: Iterable<string>): string {
  if (!keystroke || isMac()) return keystroke;
  const parts = tryParse(keystroke);
  if (!parts) return keystroke;
  if (parts.cmdOrCtrl && !parts.shift && !parts.alt && isBracketKey(parts.key)) return "";
  const lift = lifted(parts);
  // A chord that is not lifted stays as written.
  const chord = lift === parts ? keystroke : formatKeystroke(lift);
  if (TERMINAL_CLIPBOARD_CHORDS.has(formatKeystroke(lift))) return "";
  // An own Ctrl+Shift binding loses its chord to the action lifted onto it.
  const ownShifted = parts.cmdOrCtrl && parts.shift && !parts.alt && isControlKey(parts.key);
  if (ownShifted) {
    for (const other of bindings) {
      if (other === keystroke) continue;
      const otherParts = tryParse(other);
      if (!otherParts) continue;
      const otherLift = lifted(otherParts);
      if (otherLift !== otherParts && formatKeystroke(otherLift) === formatKeystroke(parts))
        return "";
    }
  }
  return chord;
}

/**
 * Ctrl+[ and Ctrl+] with nothing else held: Escape and a shell key. The app never claims them from
 * a terminal, whatever a binding says.
 */
export function isTerminalBracketKey(e: ModifierState & { key: string }): boolean {
  return !!e.ctrlKey && !hasCmd(e) && !e.altKey && !e.shiftKey && (e.key === "[" || e.key === "]");
}

/**
 * The terminal clipboard action a keydown asks for off macOS: Ctrl+Shift+C copies, Ctrl+Shift+V
 * pastes, with nothing else held. The physical key counts too, so a layout whose C and V keys
 * produce other letters (Cyrillic, Greek) keeps the chords.
 */
export function terminalClipboardAction(
  e: ModifierState & { key: string; code?: string },
): "copy" | "paste" | null {
  if (!e.ctrlKey || !e.shiftKey || e.altKey || hasCmd(e)) return null;
  const key = e.key.toLowerCase();
  if (e.code === "KeyC" || key === "c") return "copy";
  if (e.code === "KeyV" || key === "v") return "paste";
  return null;
}
