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
