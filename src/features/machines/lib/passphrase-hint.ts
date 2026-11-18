// SPDX-License-Identifier: MIT
import { isMac } from "@/shared/lib/shortcuts/keystroke";

/** Who asks for a key's passphrase: macOS's own dialog, or elsewhere a system dialog the app
 *  finds (zenity, kdialog or an askpass program). The passphrase never enters the panel. */
export const passphraseDialogHint = (): string =>
  isMac() ? "macOS asks for it in its own dialog." : "A system dialog asks for it.";
