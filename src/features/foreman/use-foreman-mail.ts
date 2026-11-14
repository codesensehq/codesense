// SPDX-License-Identifier: MIT
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";

import { CODESENSE_DOCS_SLUG, CODESENSE_DOCS_TEAM } from "@/shared/lib/codesense-docs";
import { logger } from "@/shared/lib/logger";
import { useOrgStore } from "@/shared/stores/org-store";
import { ROLE_READ_DEBOUNCE_MS } from "@/features/viewer/hooks/use-role-holdings";
import { agentReadRoles, type InboxTeam, type RoleQueue } from "@/tauri/commands";
import { AGENT_STATE_CHANGED_EVENT } from "@/tauri/events";

import { FOREMAN_ROLE } from "./open-foreman";

/** Registrations lapse silently, so the queue is re-read on this beat as well as on changes. */
const POLL_MS = 20_000;

/** Mail waits for the Foreman and nobody holds its role to read it. */
export function foremanMailWaiting(queue: RoleQueue | undefined): boolean {
  if (!queue || queue.role !== FOREMAN_ROLE) return false;
  return (queue.counts.pending ?? 0) > 0 && !queue.registrations.some((r) => r.live);
}

/**
 * Whether Foreman mail waits with no Foreman live, in the active team or the docs team (the
 * page's own home), re-read while `enabled`. Read only.
 */
export function useForemanMailWaiting(enabled: boolean): boolean {
  const activeOrg = useOrgStore((s) => s.activeOrgSlug);
  const activeTeam = useOrgStore((s) => s.activeTeamName);
  const teamsId = useMemo(() => {
    const teams: InboxTeam[] = [{ org: CODESENSE_DOCS_SLUG, team: CODESENSE_DOCS_TEAM }];
    if (activeOrg && activeTeam && activeOrg !== CODESENSE_DOCS_SLUG) {
      teams.push({ org: activeOrg, team: activeTeam });
    }
    return JSON.stringify(teams);
  }, [activeOrg, activeTeam]);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const teams = JSON.parse(teamsId) as InboxTeam[];
    let cancelled = false;
    let latest = 0;
    const read = async () => {
      const mine = ++latest;
      const answers = await Promise.all(
        teams.map((team) =>
          agentReadRoles(team, FOREMAN_ROLE, 1).then(
            ({ roles }) => foremanMailWaiting(roles.find((r) => r.role === FOREMAN_ROLE)),
            (err) => {
              logger.info("agents", `Foreman mail read failed: ${String(err)}`);
              return false;
            },
          ),
        ),
      );
      if (!cancelled && mine === latest) setWaiting(answers.some(Boolean));
    };
    void read();
    // A burst of state changes is one re-read.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      clearTimeout(pending);
      pending = setTimeout(() => void read(), ROLE_READ_DEBOUNCE_MS);
    };
    const timer = setInterval(later, POLL_MS);
    const unlisten = listen(AGENT_STATE_CHANGED_EVENT, later);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearTimeout(pending);
      void unlisten.then((u) => u()).catch(() => {});
    };
  }, [enabled, teamsId]);

  return enabled && waiting;
}
