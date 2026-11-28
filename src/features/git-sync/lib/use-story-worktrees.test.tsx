// SPDX-License-Identifier: MIT
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import sampleDay from "../../../../tests/fixtures/sample-day-1402.json";
import { describeMachineStatus } from "@/features/machines/lib/machine-status";
import { useMachinesStore } from "@/features/machines/stores/machines-store";
import { useWorktreeRosterStore } from "@/features/viewer/stores/worktree-roster-store";
import { useAgentStateStore } from "@/shared/stores/agent-state-store";
import { useViewerStore } from "@/shared/stores/viewer-store";
import type { MachineSummary, WorktreeRow } from "@/tauri/commands";

import {
  describeWorktreeRow,
  useStoryWorktrees,
  worktreeActions,
  type StoryWorktreeRow,
  type StoryWorktrees,
} from "./use-story-worktrees";

const moved = vi.hoisted(() => ({
  handlers: [] as ((e: { payload: { repoPath: string; kinds: string[] } }) => void)[],
}));
vi.mock("@/shared/windows/listen-scoped", () => ({
  listenScoped: (_event: string, _scope: string, handler: (typeof moved.handlers)[number]) => {
    moved.handlers.push(handler);
    return Promise.resolve(() => {
      moved.handlers = moved.handlers.filter((h) => h !== handler);
    });
  },
}));
const reads = vi.hoisted(() => ({
  getPublishSet: vi.fn(),
  sourceChangeset: vi.fn(),
}));
vi.mock("./publish-set-source", () => ({ getPublishSet: reads.getPublishSet }));
vi.mock("./source-redline-source", () => ({ sourceChangeset: reads.sourceChangeset }));

// The 14:02 fixture's story 431: its context worktree, its source worktree, and its
// workspace on a machine.
const CONTEXT = sampleDay.strip.find((s) => s.name === "431")!.worktree!;
const STORY = "431";
const CTX_PATH = "/ctx/wt/431";
const SRC_PATH = "/src/wt/431";
const MACHINE_PATH = "/home/dev/wt/431";

function contextRow(over: Partial<Record<string, unknown>> = {}): WorktreeRow {
  return {
    kind: "context",
    workspaceKey: "ctx",
    path: CTX_PATH,
    branch: CONTEXT,
    dirty: false,
    repoPath: "/ctx",
    liveCliSession: false,
    id: "cw_431",
    name: STORY,
    orgSlug: "acme",
    team: "delivery",
    launchCwd: CTX_PATH,
    baseSha: "abc",
    createdAt: 1,
    lastUsedAt: 1,
    agents: [],
    ...over,
  } as WorktreeRow;
}

function sourceRow(): WorktreeRow {
  return {
    kind: "story",
    workspaceKey: STORY,
    path: SRC_PATH,
    branch: "feat/431-simplify",
    dirty: false,
    repoPath: "/src",
    liveCliSession: false,
    storyId: STORY,
    sourceRepo: "acme/app",
    orgSlug: "acme",
    team: "delivery",
  } as unknown as WorktreeRow;
}

function machine(state: "connected" | "disconnected"): MachineSummary {
  return {
    machineId: "m-1",
    kind: "ssh",
    label: "Build box",
    scope: null,
    declaration: null,
    binding: null,
    canPublish: true,
    status: state === "connected" ? { state, workspaces: 1 } : { state },
    attention: 0,
    capabilities: { agentCallbacks: true },
  } as MachineSummary;
}

function setScene({ online = true } = {}) {
  useWorktreeRosterStore.setState({
    rows: [
      sourceRow(),
      contextRow(),
      contextRow({ id: "cw_other", name: "418", branch: "ctx/418", team: "steward" }),
    ],
  });
  useViewerStore.setState({
    workspaces: {
      "acme:delivery": [
        {
          id: STORY,
          kind: "story",
          storyId: STORY,
          cwd: "",
          location: {
            kind: "machine",
            machineId: "m-1",
            requestId: "r",
            branch: "feat/431-simplify",
            handle: "h-1",
            cwd: MACHINE_PATH,
          },
        },
      ],
    } as never,
  });
  useMachinesStore.setState({
    byTeam: { "acme:delivery": [machine(online ? "connected" : "disconnected")] },
  });
}

let renders = 0;
let latest: StoryWorktrees = { rows: [], stale: false };
function Probe({ shown }: { shown: boolean }) {
  renders++;
  latest = useStoryWorktrees(STORY, shown);
  return null;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function moveHead(repoPath = CTX_PATH) {
  act(() => {
    for (const h of moved.handlers) h({ payload: { repoPath, kinds: ["head"] } });
  });
}

beforeEach(() => {
  renders = 0;
  moved.handlers = [];
  reads.getPublishSet.mockReset().mockResolvedValue({
    buckets: [{ workspaceRef: { id: "x", label: "x", kind: "story" }, count: 2, files: [] }],
    general: { count: 10, files: [] },
  });
  reads.sourceChangeset
    .mockReset()
    .mockImplementation(async (repo: { kind: string }) =>
      repo.kind === "remote" ? [{}, {}, {}] : [],
    );
  setScene();
});

describe("useStoryWorktrees", () => {
  it("lists the context row, the source row, then the machine's row, with their words", async () => {
    render(<Probe shown />);
    await settle();
    const rows = latest.rows.map(describeWorktreeRow);
    expect(rows).toEqual([
      { label: CONTEXT, tag: "(context)", detail: "12 files" },
      { label: "feat/431-simplify", tag: "(source)", detail: "0 files" },
      { label: "Build box, feat/431-simplify", tag: "remote", detail: "3 files" },
    ]);
    expect(latest.rows.map((r) => [r.path, r.machine?.label ?? null])).toEqual([
      [CTX_PATH, null],
      [SRC_PATH, null],
      [MACHINE_PATH, "Build box"],
    ]);
    // The machine's count comes through the source diff's read for that machine.
    expect(reads.sourceChangeset).toHaveBeenCalledWith({
      kind: "remote",
      machineId: "m-1",
      handle: "h-1",
    });
  });

  it("shows an offline machine's state and no count, and never reads that machine", async () => {
    setScene({ online: false });
    render(<Probe shown />);
    await settle();
    const row = latest.rows[2]!;
    expect(row.count).toBeUndefined();
    expect(describeWorktreeRow(row).detail).toBe(
      describeMachineStatus(machine("disconnected"), 0).word,
    );
    expect(reads.sourceChangeset).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "remote" }),
    );
  });

  it("reads nothing until shown", async () => {
    const view = render(<Probe shown={false} />);
    await settle();
    expect(reads.getPublishSet).toHaveBeenCalledTimes(0);
    expect(reads.sourceChangeset).toHaveBeenCalledTimes(0);
    expect(latest.rows.every((r) => r.count === undefined)).toBe(true);
    view.rerender(<Probe shown />);
    await settle();
    expect(reads.getPublishSet).toHaveBeenCalledTimes(1);
  });

  it("ignores the active team and another team's worktree", async () => {
    render(<Probe shown />);
    await settle();
    const before = latest.rows;
    const count = renders;
    act(() => {
      useViewerStore.setState({ activeTeamKey: "acme:steward" } as never);
    });
    act(() => {
      useWorktreeRosterStore.setState({
        rows: [
          sourceRow(),
          contextRow(),
          contextRow({ id: "cw_new", name: "500", branch: "ctx/500", team: "steward" }),
        ],
      });
    });
    expect(latest.rows).toBe(before);
    expect(renders).toBe(count);
  });

  it("recounts once on a head move while shown, and marks stale while hidden", async () => {
    const view = render(<Probe shown />);
    await settle();
    expect(reads.getPublishSet).toHaveBeenCalledTimes(1);
    moveHead();
    await settle();
    expect(reads.getPublishSet).toHaveBeenCalledTimes(2);
    view.rerender(<Probe shown={false} />);
    moveHead();
    await settle();
    expect(reads.getPublishSet).toHaveBeenCalledTimes(2);
    expect(latest.stale).toBe(true);
    view.rerender(<Probe shown />);
    await settle();
    expect(reads.getPublishSet).toHaveBeenCalledTimes(3);
    expect(latest.stale).toBe(false);
    // Showing again with nothing moved reads nothing.
    view.rerender(<Probe shown={false} />);
    view.rerender(<Probe shown />);
    await settle();
    expect(reads.getPublishSet).toHaveBeenCalledTimes(3);
  });

  it("does not re-render on a store update for another team's agent", async () => {
    render(<Probe shown />);
    await settle();
    const count = renders;
    act(() => {
      useAgentStateStore.setState({ ["other-team-agent" as never]: 1 } as never);
    });
    moveHead("/elsewhere");
    expect(renders).toBe(count);
  });
});

describe("worktreeActions", () => {
  const local: StoryWorktreeRow = {
    key: "context:cw_431",
    kind: "context",
    branch: CONTEXT,
    path: CTX_PATH,
    machine: null,
    offline: null,
    count: 12,
  };
  it("gives a local row Open in Finder and Copy path", () => {
    expect(worktreeActions(local)).toEqual([
      { id: "open-in-finder", label: "Open in Finder", path: CTX_PATH },
      { id: "copy-path", label: "Copy path", path: CTX_PATH },
    ]);
  });
  it("gives a machine's row Copy path only, on that machine, copying its path there", () => {
    const remote = {
      ...local,
      kind: "source" as const,
      machine: { id: "m-1", label: "Build box" },
      path: MACHINE_PATH,
    };
    expect(worktreeActions(remote)).toEqual([
      { id: "copy-path", label: "Copy path", hint: "On Build box", path: MACHINE_PATH },
    ]);
  });
});
