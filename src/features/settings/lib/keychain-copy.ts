// SPDX-License-Identifier: MIT
// SW-CN-UX-13 (AC-3): one source of truth for the "credentials live in the OS keychain" statement, so
// the connections surface intro and the scan-hit education read it identically rather than drifting
// across copies. (The connect form composes its own distinct privacy sentence — "…never leaves this
// machine except to reach this connection" — so it is intentionally not this exact sentence.)

/** The canonical keychain statement, reused wherever this exact sentence appears. */
export const CREDENTIALS_IN_KEYCHAIN = "Credentials are stored in your OS keychain";

/** Where the GIF search key lives, under its field in Settings → Messaging. */
export const GIF_KEY_IN_KEYCHAIN =
  "Stored in your OS keychain on this computer. CodeSense sends it only to GIPHY and shows only its last 4 characters; it never puts it in files, logs or agent tools.";
