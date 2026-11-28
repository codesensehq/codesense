// SPDX-License-Identifier: MIT
import { useCallback, useMemo } from "react";

import { describeMachineStatus } from "@/features/machines/lib/machine-status";
import { useMachine } from "@/features/machines/stores/machines-store";
import { useRemoteWatchNonce } from "@/features/viewer/lib/use-remote-worktree-watch";
import { useWorktreeRosterStore } from "@/features/viewer/stores/worktree-roster-store";
import { isRemoteWorkspace } from "@/shared/lib/workspace-location";
import { rootWatchKey } from "@/shared/lib/worktree-watch-key";
import { useOrgStore } from "@/shared/stores/org-store";
import { type Workspace, useViewerStore } from "@/shared/stores/viewer-store";
import type { WorktreeRow } from "@/tauri/commands";

import { getPublishSet } from "./publish-set-source";
import { useHeadMoves, useShownRead } from "./shown-read";
import { sourceChangeset } from "./source-redline-source";

/** One worktree a story uses. Its file count is against main; `count` is absent until
 *  read and while its machine is offline. */
export interface StoryWorktreeRow {
  key: string;
  kind: "context" | "source";
  branch: string | null;
  /** The directory on this Mac, or on the machine for a machine's row. */
  path: string;
  /** The machine a row lives on; null on this Mac. */
  machine: { id: string; label: string } | null;
  /** The machine's state word while it is not connected ("Offline"), else null. */
  offline: string | null;
  count: number | undefined;
}

export interface StoryWorktrees {
  rows: StoryWorktreeRow[];
  /** A head moved while the list was hidden: it recounts when shown again. */
  stale: boolean;
}

/** Whether a context worktree's name or branch names `storyId`: `<id>`, `<id>-ctx` or
 *  `ctx/<id>`, in any case. A context worktree's record names its story. */
function namesStory(row: { name: string; branch: string | null }, storyId: string): boolean {
  const id = storyId.toLowerCase();
  const bare = (s: string) => (s.split("/").pop() ?? "").toLowerCase().replace(/-ctx$/, "");
  return bare(row.name) === id || (row.branch !== null && bare(row.branch) === id);
}

interface LocalRow {
  key: string;
  kind: "context" | "source";
  id: string;
  branch: string | null;
  path: string;
  orgSlug: string;
}

/** The story's local rows as one string, so another worktree's change never re-renders. */
function localRowsKey(rows: WorktreeRow[] | null, storyId: string): string {
  const own: LocalRow[] = [];
  for (const r of rows ?? []) {
    if (r.kind === "context" && namesStory(r, storyId))
      own.push({
        key: `context:${r.id}`,
        kind: "context",
        id: r.id,
        branch: r.branch,
        path: r.path,
        orgSlug: r.orgSlug,
      });
  }
  for (const r of rows ?? []) {
    if (r.kind === "story" && r.storyId === storyId)
      own.push({
        key: `source:${r.path}`,
        kind: "source",
        id: r.path,
        branch: r.branch,
        path: r.path,
        orgSlug: r.orgSlug,
      });
  }
  return JSON.stringify(own);
}

interface MachineWorkspace {
  wsId: string;
  machineId: string;
  handle: string | null;
  cwd: string;
  branch: string | null;
  localWsId: string | null;
}

/** The story's workspace, in any team: its machine location, or its local id. */
function storyWorkspaceKey(
  workspaces: Record<string, readonly Workspace[]>,
  storyId: string,
): string {
  let remote: MachineWorkspace | null = null;
  let localWsId: string | null = null;
  for (const list of Object.values(workspaces)) {
    for (const ws of list) {
      if (ws.kind !== "story" || (ws.storyId ?? ws.id) !== storyId) continue;
      if (isRemoteWorkspace(ws)) {
        remote ??= {
          wsId: ws.id,
          machineId: ws.location.machineId,
          handle: ws.location.handle ?? null,
          cwd: ws.location.cwd ?? "",
          branch: ws.location.branch ?? null,
          localWsId: null,
        };
      } else localWsId ??= ws.id;
    }
  }
  return JSON.stringify({ remote, localWsId });
}

function setCount(set: { general: { count: number }; buckets: { count: number }[] }): number {
  return set.general.count + set.buckets.reduce((n, b) => n + b.count, 0);
}

/**
 * Every worktree a story uses, in order: its context worktree, its source worktree on
 * this Mac, then its source worktree on a machine. It never reads the active team or
 * the team chip. Counts are read only while `shown`; a head move recounts while shown
 * and marks the list stale while hidden.
 */
export function useStoryWorktrees(storyId: string, shown: boolean): StoryWorktrees {
  const localKey = useWorktreeRosterStore((s) => localRowsKey(s.rows, storyId));
  const wsKey = useViewerStore((s) => storyWorkspaceKey(s.workspaces, storyId));
  const local = useMemo(() => JSON.parse(localKey) as LocalRow[], [localKey]);
  const { remote, localWsId } = useMemo(
    () => JSON.parse(wsKey) as { remote: MachineWorkspace | null; localWsId: string | null },
    [wsKey],
  );
  const orgSlug = local.find((r) => r.kind === "context")?.orgSlug ?? "";
  const orgRoot = useOrgStore((s) => s.orgs.find((o) => o.slug === orgSlug)?.org_root ?? "");
  const machine = useMachine(remote?.machineId ?? "");
  const online = machine?.status.state === "connected";
  // The state word reads no clock, only the remembered detail after it does.
  const offline =
    remote && !online ? (machine ? describeMachineStatus(machine, 0).word : "Offline") : null;

  const contextPaths = [orgRoot, ...local.filter((r) => r.kind === "context").map((r) => r.path)];
  const moves = useHeadMoves(contextPaths.join("\n"));
  const localNonce = useViewerStore((s) =>
    localWsId ? (s.worktreeChangedPath[rootWatchKey(localWsId)]?.nonce ?? 0) : 0,
  );
  const remoteNonce = useRemoteWatchNonce(
    remote && online ? remote.machineId : null,
    remote && online ? remote.handle : null,
  );
  const readKey = JSON.stringify([localKey, wsKey, online, moves, localNonce, remoteNonce]);

  const read = useCallback(async () => {
    const counts: Record<string, number> = {};
    const reads = local.map(async (row) => {
      // The worktree id picks the checkout; the repo path only has to be non-empty.
      const n =
        row.kind === "context"
          ? setCount(await getPublishSet(orgRoot || row.path, undefined, undefined, null, row.id))
          : (await sourceChangeset({ kind: "local", cwd: row.path })).length;
      counts[row.key] = n;
    });
    if (remote?.handle && online)
      reads.push(
        sourceChangeset({
          kind: "remote",
          machineId: remote.machineId,
          handle: remote.handle,
        }).then((files) => {
          counts[`machine:${remote.wsId}`] = files.length;
        }),
      );
    await Promise.all(reads);
    return counts;
  }, [local, orgRoot, remote, online]);
  const { value: counts, stale } = useShownRead(shown, readKey, read);

  const rows = useMemo(() => {
    const out: StoryWorktreeRow[] = local.map((r) => ({
      key: r.key,
      kind: r.kind,
      branch: r.branch,
      path: r.path,
      machine: null,
      offline: null,
      count: counts?.[r.key],
    }));
    if (remote) {
      const key = `machine:${remote.wsId}`;
      out.push({
        key,
        kind: "source",
        branch: remote.branch,
        path: remote.cwd,
        machine: { id: remote.machineId, label: machine?.label || remote.machineId },
        offline,
        count: offline ? undefined : counts?.[key],
      });
    }
    return out;
  }, [local, remote, counts, machine?.label, offline]);
  return { rows, stale };
}

/** How a row reads in a list: "‹branch›" with "(context)" or "(source)", or a
 *  machine's "‹machine›, ‹branch›" with "remote"; its count, or the machine's state. */
export function describeWorktreeRow(row: StoryWorktreeRow): {
  label: string;
  tag: string;
  detail: string | null;
} {
  const branch = row.branch ?? "(no branch)";
  const files =
    row.count === undefined ? null : `${row.count} ${row.count === 1 ? "file" : "files"}`;
  if (row.machine)
    return {
      label: `${row.machine.label}, ${branch}`,
      tag: "remote",
      detail: row.offline ?? files,
    };
  return { label: branch, tag: row.kind === "context" ? "(context)" : "(source)", detail: files };
}

export interface WorktreeAction {
  id: "open-in-finder" | "copy-path";
  label: string;
  path: string;
  /** Where the path is, for a machine's row: "On ‹machine›". */
  hint?: string;
}

/** A row's actions: Open in Finder for a row on this Mac, Copy path for every row
 *  (a machine's labelled with the machine and copying its path there). */
export function worktreeActions(row: StoryWorktreeRow): WorktreeAction[] {
  if (row.machine)
    return [
      { id: "copy-path", label: "Copy path", hint: `On ${row.machine.label}`, path: row.path },
    ];
  return [
    { id: "open-in-finder", label: "Open in Finder", path: row.path },
    { id: "copy-path", label: "Copy path", path: row.path },
  ];
}
