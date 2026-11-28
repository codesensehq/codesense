// SPDX-License-Identifier: MIT
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import sampleDay from "../../../../tests/fixtures/sample-day-1402.json";
import { useWorktreeRosterStore } from "@/features/viewer/stores/worktree-roster-store";
import { useAgentStateStore } from "@/shared/stores/agent-state-store";
import { useOrgStore } from "@/shared/stores/org-store";
import { useViewerStore } from "@/shared/stores/viewer-store";

import type { LeadBranch, LeadDiff as LeadDiffData } from "../lib/types";
import { LeadDiff } from "./lead-diff";

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
const reads = vi.hoisted(() => ({ getLeadDiff: vi.fn(), getFileRedline: vi.fn() }));
vi.mock("../lib/publish-set-source", () => ({ getLeadDiff: reads.getLeadDiff }));
vi.mock("../lib/file-redline-source", () => ({ getFileRedline: reads.getFileRedline }));
const panes = vi.hoisted(() => ({ renders: 0 }));
vi.mock("@/features/viewer/components/source-diff-overlay", () => ({
  SourceDiffPane: ({
    filePath,
    after,
    status,
  }: {
    filePath: string;
    after: string | null;
    status: string;
  }) => {
    panes.renders++;
    return (
      <div data-testid="file-diff" data-status={status}>
        {`${filePath}: ${after ?? "…"}`}
      </div>
    );
  },
}));

// The 14:02 lead: its own worktree and two stories' branches, 2 + 12 + 6 = 20 files.
const { leadChanges, expect: expected } = sampleDay;
const counts = Object.fromEntries(leadChanges.branches.map((b) => [b.worktree, b.files]));
const OWN = "ctx/sprint-3";
const [FIRST, SECOND] = ["ctx/431", "ctx/418"];
// The app's git watch reports a branch head or ref move with the org root as its path.
const ORG_ROOT = "/orgs/acme";

function branch(name: string, own = false, extra: Partial<LeadBranch> = {}): LeadBranch {
  const n = counts[name]!;
  const files = Array.from({ length: n }, (_, i) => ({
    path: i === 0 && !own ? "README.md" : `${name}/file-${i}.md`,
    status: "modified" as const,
    added: 3,
    removed: 1,
    branches: i === 0 && !own ? 2 : 1,
  }));
  return {
    worktree: `cw_${name}`,
    branch: name,
    story: name,
    own,
    deleted: false,
    error: null,
    files,
    ...extra,
  };
}

const DIFF: LeadDiffData = {
  workItem: sampleDay.workItems[0]!.id,
  lead: "sprint-lead",
  branches: [branch(FIRST), branch(SECOND), branch(OWN, true)],
};

// Counts the diff's own commits (renders), whatever its parent does.
let commits = 0;
function Probe({ shown }: { shown: boolean }) {
  return (
    <Profiler id="lead-diff" onRender={() => commits++}>
      <LeadDiff workItem={DIFF.workItem} lead="Sprint 3 lead" shown={shown} />
    </Profiler>
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

function moveHead(repoPath = ORG_ROOT) {
  act(() => {
    for (const h of moved.handlers) h({ payload: { repoPath, kinds: ["refs"] } });
  });
}

beforeEach(() => {
  commits = 0;
  panes.renders = 0;
  moved.handlers = [];
  reads.getLeadDiff.mockReset().mockResolvedValue(DIFF);
  reads.getFileRedline
    .mockReset()
    .mockImplementation(
      async (
        _root: string,
        path: string,
        _old: unknown,
        _pr: unknown,
        _sha: unknown,
        worktree: string,
      ) => ({
        status: "modified",
        binary: false,
        before: "base",
        after: `${path} on ${worktree}`,
      }),
    );
  useWorktreeRosterStore.setState({
    rows: DIFF.branches.map((b) => ({
      kind: "context",
      id: b.worktree,
      path: `/wt/${b.story}`,
      branch: b.branch,
      name: b.story,
      orgSlug: "acme",
    })) as never,
  });
  useOrgStore.setState({
    orgs: [
      { slug: "acme", org_root: ORG_ROOT },
      { slug: "other", org_root: "/orgs/other" },
    ] as never,
  });
});

describe("LeadDiff", () => {
  it("reads the 14:02 lead as 3 worktrees and 20 files, read-only, stories first", async () => {
    render(<Probe shown />);
    await settle();
    const total = leadChanges.branches.reduce((n, b) => n + b.files, 0);
    expect(total).toBe(expected.leadChangedFiles);
    expect(
      screen.getByText("Diff for Sprint 3 lead · 3 worktrees, 20 files · read-only"),
    ).toBeTruthy();
    const groups = screen
      .getAllByTestId("lead-diff-branch")
      .map((g) => g.firstElementChild?.textContent);
    expect(groups).toEqual([
      `${FIRST}, 12 files`,
      `${SECOND}, 6 files`,
      `${OWN} (the lead's own), 2 files`,
    ]);
    expect(screen.getAllByText("2 stories")).toHaveLength(2);
    expect(screen.getAllByText("+3").length).toBe(20);
    expect(screen.queryByRole("button", { name: /merge/i })).toBeNull();
  });

  it("opens a file on its branch, and a shared file offers the other branch's version", async () => {
    render(<Probe shown />);
    await settle();
    fireEvent.click(screen.getAllByText("README.md")[0]!);
    await settle();
    expect(screen.getByTestId("file-diff").textContent).toBe(`README.md: README.md on cw_${FIRST}`);
    expect(screen.getByText(`${SECOND} also changes this file.`, { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show its version" }));
    await settle();
    expect(screen.getByTestId("file-diff").textContent).toBe(
      `README.md: README.md on cw_${SECOND}`,
    );
    expect(screen.getByText(`${FIRST} also changes this file.`, { exact: false })).toBeTruthy();
  });

  it("reads a lead with no changes as no changes yet, and names a deleted branch", async () => {
    reads.getLeadDiff.mockResolvedValue({ ...DIFF, branches: [] });
    const view = render(<Probe shown />);
    await settle();
    expect(screen.getByText("Diff, no changes yet")).toBeTruthy();
    view.unmount();
    reads.getLeadDiff.mockResolvedValue({
      ...DIFF,
      branches: [branch(FIRST), branch(SECOND, false, { deleted: true, files: [] })],
    });
    render(<Probe shown />);
    await settle();
    expect(screen.getByText(`${SECOND} was deleted`)).toBeTruthy();
  });

  it("names a branch that could not be read and still lists the others", async () => {
    reads.getLeadDiff.mockResolvedValue({
      ...DIFF,
      branches: [branch(FIRST), branch(SECOND, false, { error: "no merge base", files: [] })],
    });
    render(<Probe shown />);
    await settle();
    expect(screen.getByText(`${SECOND} couldn't be read`)).toBeTruthy();
    expect(screen.getAllByText("README.md")).toHaveLength(1);
  });

  it("reads an open file again on a head move, re-points it to the new diff, and closes it when gone", async () => {
    let n = 0;
    reads.getFileRedline.mockImplementation(async () => ({
      status: "modified",
      binary: false,
      before: "base",
      after: `read ${++n}`,
    }));
    render(<Probe shown />);
    await settle();
    fireEvent.click(screen.getAllByText("README.md")[0]!);
    await settle();
    expect(screen.getByTestId("file-diff").textContent).toBe("README.md: read 1");
    // The new read lists the file with a new status: the pane follows it and reads again.
    const first = branch(FIRST);
    first.files[0] = { ...first.files[0]!, status: "added" };
    reads.getLeadDiff.mockResolvedValue({ ...DIFF, branches: [first, branch(SECOND)] });
    moveHead();
    await settle();
    expect(screen.getByTestId("file-diff").textContent).toBe("README.md: read 2");
    expect(screen.getByTestId("file-diff").dataset.status).toBe("added");
    // The next read no longer lists it: the file closes.
    reads.getLeadDiff.mockResolvedValue({ ...DIFF, branches: [branch(SECOND)] });
    moveHead();
    await settle();
    expect(screen.queryByTestId("file-diff")).toBeNull();
  });

  it("makes no lead_diff call while hidden, and recomputes once per head move", async () => {
    const view = render(<Probe shown={false} />);
    await settle();
    expect(reads.getLeadDiff).toHaveBeenCalledTimes(0);
    view.rerender(<Probe shown />);
    await settle();
    expect(reads.getLeadDiff).toHaveBeenCalledTimes(1);
    // The app never reports a worktree's own path or another org's root.
    moveHead(`/wt/${FIRST}`);
    moveHead("/orgs/other");
    await settle();
    expect(reads.getLeadDiff).toHaveBeenCalledTimes(1);
    moveHead();
    await settle();
    expect(reads.getLeadDiff).toHaveBeenCalledTimes(2);
    view.rerender(<Probe shown={false} />);
    moveHead();
    await settle();
    expect(reads.getLeadDiff).toHaveBeenCalledTimes(2);
    view.rerender(<Probe shown />);
    await settle();
    expect(reads.getLeadDiff).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("lead-diff").dataset.stale).toBeUndefined();
  });

  it("neither recomputes nor re-renders when another team's agent or worktree changes", async () => {
    render(<Probe shown />);
    await settle();
    const before = { calls: reads.getLeadDiff.mock.calls.length, commits };
    const lists = screen.getAllByTestId("lead-diff-branch");
    act(() => {
      useAgentStateStore.setState({ ["other-team-agent" as never]: 1 } as never);
      useViewerStore.setState({ activeTeamKey: "acme:steward" } as never);
      useWorktreeRosterStore.setState({
        rows: [
          ...(useWorktreeRosterStore.getState().rows ?? []),
          {
            kind: "context",
            id: "cw_other",
            path: "/wt/other",
            branch: "ctx/other",
            name: "other",
          } as never,
        ],
      });
    });
    moveHead("/orgs/other");
    await settle();
    expect(reads.getLeadDiff.mock.calls.length).toBe(before.calls);
    expect(screen.getAllByTestId("lead-diff-branch")[0]).toBe(lists[0]);
    expect(commits).toBe(before.commits);
  });
});
