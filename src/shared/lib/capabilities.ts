// SPDX-License-Identifier: MIT
/**
 * Which optional features this OS supports: the one front-end source. The backend resolves
 * `src-tauri/platform-caps.json` for the running platform, the app reads that answer once at
 * startup into `useConfigStore` (`loadPlatformCaps`), and `useCapability` selects from it with no
 * further IPC. Feature code never checks the OS to gate a feature; it asks here, and explains an
 * off capability with the `CapabilityOff` components (`@/shared/components/capability-off`).
 */
import { useConfigStore } from "@/shared/stores/config-store";

/** The product capabilities in `platform-caps.json`, in its order (a test keeps the two in step). */
export const CAPABILITY_KEYS = [
  "git-ai",
  "starship",
  "secret-store",
  "mcp-bridge",
  "terminal-server-sidecar",
  "remote-machines",
  "agent-cli-sockets",
  "shell-integration",
  "pdf-export",
  "background-on-close",
  "terminal-server-tray",
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** A capability on this OS; `reason` (from `platform-caps.json`) is set only when it is off. */
export interface Capability {
  on: boolean;
  reason: string | null;
}

const ON: Capability = { on: true, reason: null };

/**
 * Whether `cap` is on here and, when off, why. Before the startup read lands, or if it failed,
 * every capability reads as on: today's UI, with the backend still refusing what this OS can't do.
 */
export function useCapability(cap: CapabilityKey): Capability {
  const found = useConfigStore((s) => s.platformCaps?.[cap]);
  return found ? { on: found.on, reason: found.reason } : ON;
}

/** The running OS as people name it: "macOS", "Windows", "Linux", or "this platform". */
export function platformName(): string {
  const platform = typeof navigator === "undefined" ? "" : (navigator.platform ?? "");
  if (/Mac/i.test(platform)) return "macOS";
  if (/Win/i.test(platform)) return "Windows";
  if (/Linux/i.test(platform)) return "Linux";
  return "this platform";
}

/** The short form, for a status: "Not yet available on Windows". */
export function notYetAvailable(): string {
  return `Not yet available on ${platformName()}`;
}

/** The one sentence that explains an off capability: "Not yet available on Windows: <reason>." */
export function notYetAvailableSentence(capability: Capability): string {
  return capability.reason
    ? `${notYetAvailable()}: ${capability.reason}.`
    : `${notYetAvailable()}.`;
}
