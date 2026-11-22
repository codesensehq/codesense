// SPDX-License-Identifier: MIT
/**
 * How the app names the machine it runs on: "This Mac" on macOS and "This
 * computer" elsewhere. Pure and read at call time, so a test can stub the
 * platform. Locality is never decided by these words: test a machine id or kind.
 */
import { isMac } from "@/shared/lib/shortcuts/keystroke";

/** The local machine as a label or the start of a sentence: "This Mac" / "This computer". */
export function localMachineLabel(): string {
  return isMac() ? "This Mac" : "This computer";
}

/** The local machine mid-sentence: "this Mac" / "this computer". */
export function localMachinePhrase(): string {
  return isMac() ? "this Mac" : "this computer";
}

/** The kind of machine, as in "each teammate's Mac": "Mac" / "computer". */
export function localMachineNoun(): string {
  return isMac() ? "Mac" : "computer";
}

/**
 * What "each ___ keeps its own count" ranges over: "Mac and machine" on macOS, where
 * the Mac is this install and a machine is a remote one, and "machine" elsewhere,
 * where "computer and machine" would say the same thing twice.
 */
export function localMachineAndRemoteNoun(): string {
  return isMac() ? "Mac and machine" : "machine";
}

/**
 * Whether a framed page names keys and this machine as on macOS: the `mac` flag its slot context
 * carries for `codesense.formatKeys`, `formatModifierClick` and the local machine words, which
 * equal this module's and the keystroke helpers. Presentation only.
 */
export function pageNamesKeysAsMac(): boolean {
  return isMac();
}

/**
 * Where the terminal server's item lives, mid-sentence: "menu bar" on macOS, "tray" elsewhere.
 */
export function trayPlaceName(): string {
  return isMac() ? "menu bar" : "tray";
}

/**
 * How to bring the window back after a close sent CodeSense to the background, as the start of a
 * sentence: the Dock icon on macOS, the tray item's menu elsewhere (where it is the only way back).
 */
export function backgroundRestoreHint(): string {
  return isMac() ? "Click the dock icon to reopen it" : "Open it again from the tray icon's menu";
}

/**
 * The Quit on window close setting's explanation. Without a Dock, closing to the background
 * needs the tray icon to come back from, so elsewhere it works only while that icon shows.
 */
export function quitOnCloseFooter(): string {
  return isMac()
    ? "Off keeps codesense running in the background on close (dock icon reopens it) so routines keep firing. On makes closing the window quit."
    : "Off keeps codesense running in the background on close while the terminal server's tray icon shows (its menu reopens it) so routines keep firing; with no tray icon, closing the window quits. On makes closing the window quit.";
}
