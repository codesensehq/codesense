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
