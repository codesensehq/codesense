// SPDX-License-Identifier: MIT
import satelliteKeys from "../../../src-tauri/src/windows/app_state_patch_keys.json";
import { isMainWindow } from "@/shared/lib/current-window";
import { logger } from "@/shared/lib/logger";
import { patchAppStateKeys, saveAppState } from "@/tauri/commands";

/** All app-state read/modify/write callers share this queue so disjoint keys survive. */
let writeTail: Promise<void> = Promise.resolve();
export function serializeAppStateWrite(write: () => Promise<void>): Promise<void> {
  const next = writeTail.then(write);
  // Callers retain/report failures; one failed write must not poison later attempts.
  writeTail = next.catch(() => undefined);
  return next;
}

/** The top-level keys a satellite may patch; Rust reads the same file. */
export const SATELLITE_APP_STATE_KEYS: readonly string[] = satelliteKeys;

/**
 * The one app-state write: a key patch (objects merge by field, `null` removes a field, arrays
 * replace). `main` saves it; a satellite sends it to `patch_app_state_keys`, or drops it when it
 * names a key outside `SATELLITE_APP_STATE_KEYS`. Callers run it inside `serializeAppStateWrite`.
 */
export async function patchAppState(patch: Record<string, unknown>): Promise<void> {
  if (isMainWindow()) return saveAppState(JSON.stringify(patch), true);
  const outside = Object.keys(patch).filter((key) => !SATELLITE_APP_STATE_KEYS.includes(key));
  if (outside.length) {
    logger.debug("app-state", `satellite skips its write of ${outside.join(", ")}`);
    return;
  }
  return patchAppStateKeys(JSON.stringify(patch));
}
