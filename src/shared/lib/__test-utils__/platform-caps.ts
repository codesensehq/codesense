// SPDX-License-Identifier: MIT
import { CAPABILITY_KEYS, type CapabilityKey } from "@/shared/lib/capabilities";
import { resetPlatformCapsForTest, useConfigStore } from "@/shared/stores/config-store";

/** The capabilities as the startup read would leave them: every one on except `off`, each
 *  off one with its reason. */
export function setPlatformCaps(off: Partial<Record<CapabilityKey, string>> = {}): void {
  useConfigStore.setState({
    platformCaps: Object.fromEntries(
      CAPABILITY_KEYS.map((key) => [
        key,
        { key, on: off[key] === undefined, reason: off[key] ?? null },
      ]),
    ),
  });
}

/** Forget the capabilities (and the startup read): call it from an `afterEach`. */
export const resetPlatformCaps = resetPlatformCapsForTest;
