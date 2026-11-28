// SPDX-License-Identifier: MIT
/**
 * The two-window e2e driver's door (`tests/windows/`), registered in `main` only by
 * `App.tsx`'s `webdriver` block: `seed(options?)` gives a fresh home the probe org and team and
 * returns the probe dashboard's path; `open({id, probe?})` opens `pane-<id>` (on the probe
 * route when `probe` is given) and returns its label. A spec then switches to that window.
 *
 * Both call the webdriver build's `e2e_*` commands (`src-tauri/src/windows/e2e.rs`) with
 * `invoke` here rather than through `src/tauri/commands.ts`, which ships, so their names stay
 * out of the release bundle with this file (`scripts/verify-webdriver-absence.ts`).
 */
import { invoke } from "@tauri-apps/api/core";

interface WindowsE2eSeed {
  /** The probe dashboard's absolute path, in the seeded team's content. */
  probeHtml: string;
}

/** What a spec asks the seed for beyond the probe org and team (`SeedOptions` in `e2e.rs`).
 *  None yet: a spec that needs more seeded adds an optional field on both sides. */
type WindowsE2eSeedOptions = Record<string, never>;

interface WindowsE2eOpen {
  /** The window is labelled `pane-<id>`; letters, digits, `-` and `_` only. */
  id: string;
  /** A file to open on the probe route. */
  probe?: string;
}

export function registerWindowsE2eControl() {
  window.__CODESENSE_WINDOWS_E2E__ = {
    seed: (options = {}) => invoke<WindowsE2eSeed>("e2e_seed", { options }),
    open: ({ id, probe }) => invoke<string>("e2e_open_window", { id, probe: probe ?? null }),
  };
}

declare global {
  interface Window {
    __CODESENSE_WINDOWS_E2E__?: {
      seed: (options?: WindowsE2eSeedOptions) => Promise<WindowsE2eSeed>;
      open: (options: WindowsE2eOpen) => Promise<string>;
    };
  }
}
