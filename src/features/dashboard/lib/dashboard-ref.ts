// SPDX-License-Identifier: MIT
import type { DashboardRef } from "@/tauri/commands";

export function dashboardRefKey(ref: DashboardRef): string {
  const team = ref.scope === "team" ? `:${ref.team}` : "";
  return `dashboard:${ref.scope}:${ref.org}${team}/${ref.id}`;
}

/** The ref a `dashboardRefKey` names; null for any other text. An org may hold `/`, an id never. */
export function dashboardRefOfKey(key: string): DashboardRef | null {
  const match = /^dashboard:(built-in|team|private):(.+)\/([^/]+)$/.exec(key);
  if (!match) return null;
  const [, scope, owner, id] = match as unknown as [string, DashboardRef["scope"], string, string];
  if (scope !== "team") return owner ? { scope, org: owner, id } : null;
  const at = owner.lastIndexOf(":");
  if (at <= 0 || at === owner.length - 1) return null;
  return { scope, org: owner.slice(0, at), team: owner.slice(at + 1), id };
}
