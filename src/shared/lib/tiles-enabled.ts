// SPDX-License-Identifier: MIT
/**
 * The tiles release flag. The app decides it once at startup from the local setting
 * (`viewer.settings.tiles`) and the remote kill, and this reads that boot value once, so the
 * front end and the app agree for the whole session. A failed read is off.
 *
 * Every tile-file writer and the tile host's mount await `tilesEnabled()` and are listed in
 * `tiles-flag-sites.json`; with the flag off the app is today's app and no tile code writes
 * any file.
 */
import { getTilesEnabled } from "@/tauri/commands";

let boot: Promise<boolean> | null = null;

/** Whether tiles are on this session. */
export function tilesEnabled(): Promise<boolean> {
  boot ??= getTilesEnabled().then(
    (on) => on === true,
    () => false,
  );
  return boot;
}

/** Forgets the read value, so a test can read again. */
export function resetTilesEnabledForTests(): void {
  boot = null;
}
