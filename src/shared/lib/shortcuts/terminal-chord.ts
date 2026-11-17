// SPDX-License-Identifier: MIT
/**
 * The chord an action answers to while a terminal has focus.
 *
 * Off macOS, Ctrl+<letter>, Ctrl+\ and Ctrl+Space are shell input, so an app binding on one of
 * them moves to its Ctrl+Shift form in a terminal ("add Shift in a terminal"). Ctrl+[ and Ctrl+]
 * are not lifted: a binding on either has no key in a terminal. Where the lifted chord is
 * another built-in action's own binding the lifted action wins it and the other has no key in a
 * terminal; a dashboard command never takes a built-in's chord. The terminal's copy and paste
 * chords, Ctrl+Shift+C and Ctrl+Shift+V, win over any binding. On macOS the chord is the binding
 * itself: a terminal-claimed action matches Cmd only (`macCmdOnly`).
 */
import {
  formatKeystroke,
  hasCmd,
  isMac,
  isNonLatinLetterOn,
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

/** The other bindings `terminalChord` weighs a chord against. */
export interface ChordNeighbours {
  /** Every built-in action's effective keystroke. */
  builtIns: Iterable<string>;
  /** Every dashboard command's effective keystroke. */
  commands?: Iterable<string>;
}

/** The chords the bindings hold in a terminal: as written, and lifted. */
function heldChords(bindings: Iterable<string>): Set<string> {
  const held = new Set<string>();
  for (const binding of bindings) {
    const parts = tryParse(binding);
    if (!parts) continue;
    held.add(formatKeystroke(parts));
    held.add(formatKeystroke(lifted(parts)));
  }
  return held;
}

/** The chords the bindings (other than `except`) are lifted onto. */
function liftedOnto(bindings: Iterable<string>, except: string): Set<string> {
  const onto = new Set<string>();
  for (const binding of bindings) {
    if (binding === except) continue;
    const parts = tryParse(binding);
    if (!parts) continue;
    const lift = lifted(parts);
    if (lift !== parts) onto.add(formatKeystroke(lift));
  }
  return onto;
}

/**
 * The chord `keystroke` answers to from a focused terminal, or `""` when it has none there.
 * Built-in actions win collisions: a built-in's own Ctrl+Shift binding is displaced by another
 * built-in lifted onto it, but a dashboard command (`command`) never takes a built-in's chord, so
 * the built-in keeps it and the command has no key there. Between commands the lifted one wins.
 */
export function terminalChord(
  keystroke: string,
  { builtIns, commands = [] }: ChordNeighbours,
  command = false,
): string {
  if (!keystroke || isMac()) return keystroke;
  const parts = tryParse(keystroke);
  if (!parts) return keystroke;
  if (parts.cmdOrCtrl && !parts.shift && !parts.alt && isBracketKey(parts.key)) return "";
  const lift = lifted(parts);
  // A chord that is not lifted stays as written.
  const chord = lift === parts ? keystroke : formatKeystroke(lift);
  const held = formatKeystroke(lift);
  if (TERMINAL_CLIPBOARD_CHORDS.has(held)) return "";
  if (command && heldChords(builtIns).has(held)) return "";
  // An own Ctrl+Shift binding loses its chord to the action lifted onto it.
  const ownShifted = parts.cmdOrCtrl && parts.shift && !parts.alt && isControlKey(parts.key);
  if (ownShifted) {
    const taken = liftedOnto(builtIns, keystroke);
    if (command) for (const chordTaken of liftedOnto(commands, keystroke)) taken.add(chordTaken);
    if (taken.has(formatKeystroke(parts))) return "";
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
 * pastes, with nothing else held. The physical key counts only where the layout has no Latin
 * letters (Cyrillic, Greek), so Dvorak's `j` on the C key stays a `j`.
 */
export function terminalClipboardAction(
  e: ModifierState & { key: string; code?: string },
): "copy" | "paste" | null {
  if (!e.ctrlKey || !e.shiftKey || e.altKey || hasCmd(e)) return null;
  const key = e.key.toLowerCase();
  if (key === "c" || isNonLatinLetterOn(e, "KeyC")) return "copy";
  if (key === "v" || isNonLatinLetterOn(e, "KeyV")) return "paste";
  return null;
}
