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
import { publishSetCount } from "./types";

/** One worktree a story uses. Its file count is against main; `count` is absent until
 *  read, while `state` says why none can be read, and when its read failed (`error`). */
export interface StoryWorktreeRow {
  key: string;
  kind: "context" | "source";
  branch: string | null;
  /** The directory on this Mac, or on the machine for a machine's row. */
  path: string;
  /** The machine a row lives on; null on this Mac. */
  machine: { id: string; label: string } | null;
  /** Why a machine's row has no count: the machine's state word while it is not
   *  connected ("Offline"), or "Preparing…" while its workspace has no handle yet. */
  state: string | null;
  count: number | undefined;
  /** This row's count read failed; the other rows keep theirs. */
  error: string | null;
}

export interface StoryWorktrees {
  rows: StoryWorktreeRow[];
  /** A head moved while the list was hidden: it recounts when shown again. */
  stale: boolean;
  /** The first failed row's error, or null when every read succeeded. */
  error: string | null;
}

/** A machine row's state word while its workspace has no handle to read through. */
const PREPARING = "Preparing…";
const COULD_NOT_COUNT = "Couldn't count";

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

interface Counts {
  counts: Record<string, number>;
  errors: Record<string, string>;
}

/**
 * Every worktree a story uses, in order: its context worktree, its source worktree on
 * this Mac, then its source worktree on a machine. It never reads the active team or
 * the team chip. Counts are read only while `shown`, each on its own, so one failed read
 * leaves the other rows' counts. A branch head or ref move under the story's org root
 * (the only path the app's git watch reports) recounts while shown and marks the list
 * stale while hidden. Source and machine rows also recount on their worktree's change
 * nonce, which ticks only while a watch on that worktree is held; the host acquires it
 * while the list is shown.
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
  let state: string | null = null;
  if (remote && !online) state = machine ? describeMachineStatus(machine, 0).word : "Offline";
  else if (remote && !remote.handle) state = PREPARING;

  const moves = useHeadMoves(orgRoot);
  const localNonce = useViewerStore((s) =>
    localWsId ? (s.worktreeChangedPath[rootWatchKey(localWsId)]?.nonce ?? 0) : 0,
  );
  const remoteNonce = useRemoteWatchNonce(
    remote && online ? remote.machineId : null,
    remote && online ? remote.handle : null,
  );
  const readKey = JSON.stringify([localKey, wsKey, online, moves, localNonce, remoteNonce]);

  const read = useCallback(async (): Promise<Counts> => {
    const out: Counts = { counts: {}, errors: {} };
    const settle = (key: string, n: Promise<number>) =>
      n.then(
        (v) => {
          out.counts[key] = v;
        },
        (e: unknown) => {
          out.errors[key] = e instanceof Error ? e.message : String(e);
        },
      );
    const reads = local.map((row) =>
      settle(
        row.key,
        row.kind === "context"
          ? // The worktree id picks the checkout; the repo path only has to be non-empty.
            getPublishSet(orgRoot || row.path, undefined, undefined, null, row.id).then(
              publishSetCount,
            )
          : sourceChangeset({ kind: "local", cwd: row.path }).then((files) => files.length),
      ),
    );
    if (remote?.handle && online)
      reads.push(
        settle(
          `machine:${remote.wsId}`,
          sourceChangeset({
            kind: "remote",
            machineId: remote.machineId,
            handle: remote.handle,
          }).then((files) => files.length),
        ),
      );
    await Promise.all(reads);
    return out;
  }, [local, orgRoot, remote, online]);
  const { value, stale, error: readError } = useShownRead(shown, readKey, read);

  const rows = useMemo(() => {
    const out: StoryWorktreeRow[] = local.map((r) => ({
      key: r.key,
      kind: r.kind,
      branch: r.branch,
      path: r.path,
      machine: null,
      state: null,
      count: value?.counts[r.key],
      error: value?.errors[r.key] ?? null,
    }));
    if (remote) {
      const key = `machine:${remote.wsId}`;
      out.push({
        key,
        kind: "source",
        branch: remote.branch,
        path: remote.cwd,
        machine: { id: remote.machineId, label: machine?.label || remote.machineId },
        state,
        count: state ? undefined : value?.counts[key],
        error: state ? null : (value?.errors[key] ?? null),
      });
    }
    return out;
  }, [local, remote, value, machine?.label, state]);
  const error = readError ?? rows.find((r) => r.error)?.error ?? null;
  return { rows, stale, error };
}

/** How a row reads in a list: "‹branch›" with "(context)" or "(source)", or a
 *  machine's "‹machine›, ‹branch›" with "remote"; its count, the machine's state, or
 *  "Couldn't count" when its read failed. */
export function describeWorktreeRow(row: StoryWorktreeRow): {
  label: string;
  tag: string;
  detail: string | null;
} {
  const branch = row.branch ?? "(no branch)";
  let files: string | null = null;
  if (row.error) files = COULD_NOT_COUNT;
  else if (row.count !== undefined) files = `${row.count} ${row.count === 1 ? "file" : "files"}`;
  if (row.machine)
    return {
      label: `${row.machine.label}, ${branch}`,
      tag: "remote",
      detail: row.state ?? files,
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
