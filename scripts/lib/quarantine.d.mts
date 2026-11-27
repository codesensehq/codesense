// SPDX-License-Identifier: MIT
export type QuarantineEntry = {
  id: string;
  reason: string;
  issue: string;
  added: string;
  projects?: string[];
};
export const LEDGERS: readonly [string, string];
export function loadEntries(root?: string): QuarantineEntry[];
export function quarantineId(
  runner: "vitest" | "playwright",
  file: string,
  titles: readonly string[],
): string;
export function validate(
  entries: unknown,
  now?: number,
  repository?: string,
): asserts entries is QuarantineEntry[];
export function validEntries(
  entries: unknown,
  now?: number,
  repository?: string,
): QuarantineEntry[];
export function quarantineApplies(entry: QuarantineEntry, project: string): boolean;
export function quarantineReason(entry: QuarantineEntry): string;
