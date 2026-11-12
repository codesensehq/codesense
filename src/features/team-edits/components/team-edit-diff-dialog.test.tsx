// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ readFile: vi.fn(), review: vi.fn() }));
vi.mock("@/tauri/commands", () => ({
  readFile: h.readFile,
  sourceRemoteFileRead: vi.fn(),
}));
vi.mock("@/shared/components/code-editor/CodeDiffReview", () => ({
  CodeDiffReview: (props: { before: string; after: string }) => {
    h.review(props);
    return (
      <div data-testid="code-diff">
        {props.before}→{props.after}
      </div>
    );
  },
}));
vi.mock("@/features/git-sync/components/redline-prose", () => ({
  RedlineProse: ({ before, after }: { before: string | null; after: string | null }) => (
    <div data-testid="redline">
      {before}→{after}
    </div>
  ),
}));
vi.mock("@/features/git-sync/components/rendered-markdown", () => ({
  RenderedMarkdown: ({ text }: { text: string }) => <div data-testid="rendered-md">{text}</div>,
}));
vi.mock("@/features/dashboard/components/html-viewer", () => ({
  HtmlViewer: () => <div data-testid="html-viewer" />,
}));

import type { TeamFileEdit, TeamFileEditsWorkspace } from "@/tauri/commands";
import { useViewerStore } from "@/shared/stores/viewer-store";
import { TeamEditDiffDialog } from "./team-edit-diff-dialog";

const workspace = {
  target: { kind: "local", codeRepoPath: "/wt/ws" },
  name: "Workspace A",
} as unknown as TeamFileEditsWorkspace;

function edit(path: string, kind: TeamFileEdit["kind"] = "changed"): TeamFileEdit {
  return { path, kind, teamPath: `/team/${path}` } as TeamFileEdit;
}

function readsAs(team: string, mine: string) {
  h.readFile.mockImplementation((p: string) =>
    Promise.resolve(p.startsWith("/team/") ? team : mine),
  );
}

describe("TeamEditDiffDialog through the shared file diff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const { defaultFileDiffMode: _mode, ...settings } = useViewerStore.getState().settings;
    void _mode;
    useViewerStore.setState({ settings });
  });

  it("a changed markdown file is the shared redline, team's copy before the workspace's", async () => {
    readsAs("team text", "my text");
    render(<TeamEditDiffDialog workspace={workspace} file={edit("doc.md")} onClose={() => {}} />);
    expect(await screen.findByTestId("redline")).toHaveTextContent("team text→my text");
    expect(screen.getByTestId("team-edit-diff-sides")).toHaveTextContent("Team's version");
  });

  it("the mode switch in the dialog writes the shared default", async () => {
    readsAs("a", "b");
    render(<TeamEditDiffDialog workspace={workspace} file={edit("doc.md")} onClose={() => {}} />);
    await screen.findByTestId("redline");
    fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
    expect(useViewerStore.getState().settings.defaultFileDiffMode?.markdown).toBe("side-by-side");
  });

  it("a changed HTML file is its source diff, with no rendered viewer", async () => {
    readsAs("<p>a</p>", "<p>b</p>");
    render(
      <TeamEditDiffDialog workspace={workspace} file={edit("page.html")} onClose={() => {}} />,
    );
    expect(await screen.findByTestId("code-diff")).toHaveTextContent("<p>a</p>→<p>b</p>");
    expect(screen.queryByTestId("html-viewer")).toBeNull();
  });

  it("a changed .ts file is a split code diff in the shared code mode, never a redline", async () => {
    useViewerStore.getState().setFileDiffMode("code", "ignoreWhitespace");
    readsAs("x", "y");
    render(<TeamEditDiffDialog workspace={workspace} file={edit("a.ts")} onClose={() => {}} />);
    await waitFor(() => expect(h.review).toHaveBeenCalled());
    expect(h.review.mock.calls.at(-1)?.[0]).toMatchObject({
      mode: "split",
      diffMode: "ignoreWhitespace",
    });
    expect(screen.queryByTestId("redline")).toBeNull();
  });

  it("keeps its reading state while either side loads", () => {
    h.readFile.mockReturnValue(new Promise(() => {}));
    render(<TeamEditDiffDialog workspace={workspace} file={edit("a.ts")} onClose={() => {}} />);
    expect(screen.getByText("Reading both versions…")).toBeInTheDocument();
  });

  it("a binary side shows the binary note instead of a diff", async () => {
    readsAs("bin\u0000ary", "text");
    render(<TeamEditDiffDialog workspace={workspace} file={edit("a.ts")} onClose={() => {}} />);
    expect(await screen.findAllByText("Not a text file: no line-by-line view.")).not.toHaveLength(
      0,
    );
    expect(h.review).not.toHaveBeenCalled();
  });
});
