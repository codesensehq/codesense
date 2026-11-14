// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ readFile: vi.fn(), remoteRead: vi.fn(), review: vi.fn() }));
vi.mock("@/tauri/commands", () => ({
  readFile: h.readFile,
  sourceRemoteFileRead: h.remoteRead,
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
import { SIDE_FRAME_CSP } from "@/shared/lib/side-frame";
import { useViewerStore } from "@/shared/stores/viewer-store";
import { stubResizeObserver } from "@/test/resize-observer-stub";
import { TeamEditDiffDialog } from "./team-edit-diff-dialog";

const workspace = {
  target: { kind: "local", codeRepoPath: "/wt/ws" },
  name: "Workspace A",
} as unknown as TeamFileEditsWorkspace;

function edit(path: string, kind: TeamFileEdit["kind"] = "changed"): TeamFileEdit {
  return { path, kind, teamPath: `/team/${path}` } as TeamFileEdit;
}

const remoteWorkspace = {
  target: { kind: "remote", machineId: "m1", workspaceHandle: "ws-1" },
  name: "Workspace B",
} as unknown as TeamFileEditsWorkspace;

function atWidth(width: number) {
  const ro = stubResizeObserver(width);
  onTestFinished(() => ro.restore());
}

const frames = () => Array.from(document.querySelectorAll("iframe"));

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

  it("labels match the layout: one legend over the redline, the panes' own labels side by side", async () => {
    readsAs("a", "b");
    render(<TeamEditDiffDialog workspace={workspace} file={edit("doc.md")} onClose={() => {}} />);
    await screen.findByTestId("redline");
    // The redline is one column, so the sides read as one line, not two columns.
    expect(screen.getByTestId("team-edit-diff-sides")).toHaveTextContent(
      "Team's version → Workspace A’s version",
    );
    fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
    expect(screen.queryByTestId("team-edit-diff-sides")).toBeNull();
    expect(await screen.findAllByTestId("rendered-md")).not.toHaveLength(0);
    expect(screen.getAllByText("Team's version").length).toBeGreaterThan(0);
  });

  it("a changed HTML file renders both versions live side by side at 900 px", async () => {
    atWidth(900);
    readsAs("<p>a</p>", "<p>b</p>");
    render(
      <TeamEditDiffDialog workspace={workspace} file={edit("page.html")} onClose={() => {}} />,
    );
    expect(await screen.findByTestId("team-edit-diff-side-by-side")).toBeInTheDocument();
    expect(frames().map((f) => f.title)).toEqual(["Team's version", "Workspace A’s version"]);
    expect(frames().map((f) => f.getAttribute("srcdoc")?.slice(-8))).toEqual([
      "<p>a</p>",
      "<p>b</p>",
    ]);
    // The panes label themselves, so the dialog's own column legend steps aside.
    expect(screen.queryByTestId("team-edit-diff-sides")).toBeNull();
    expect(screen.getByTestId("team-edit-diff-rendered-alone")).toBeInTheDocument();
    expect(screen.queryByTestId("html-viewer")).toBeNull();
  });

  it("a changed HTML file shows one version at a time below 900 px", async () => {
    atWidth(899);
    readsAs("<p>a</p>", "<p>b</p>");
    render(
      <TeamEditDiffDialog workspace={workspace} file={edit("page.html")} onClose={() => {}} />,
    );
    expect(await screen.findByTestId("team-edit-diff-one-at-a-time")).toBeInTheDocument();
    expect(frames().map((f) => f.title)).toEqual(["Workspace A’s version"]);
    fireEvent.click(screen.getByRole("button", { name: "Team's version" }));
    expect(frames().map((f) => f.title)).toEqual(["Team's version"]);
  });

  it("a changed HTML file's Source mode is the text diff under the column legend", async () => {
    atWidth(1000);
    readsAs("<p>a</p>", "<p>b</p>");
    render(
      <TeamEditDiffDialog workspace={workspace} file={edit("page.html")} onClose={() => {}} />,
    );
    await screen.findByTestId("team-edit-diff-side-by-side");
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(await screen.findByTestId("code-diff")).toHaveTextContent("<p>a</p>→<p>b</p>");
    expect(screen.getByTestId("team-edit-diff-sides")).toHaveTextContent("Team's version");
    expect(frames()).toEqual([]);
  });

  it("a machine workspace's HTML side holds only its own content, in a frame that can't reach out", async () => {
    atWidth(1000);
    const hostile =
      `<script>fetch("http://127.0.0.1:4100/api/state")</script>` +
      `<img src="file:///etc/hosts"><link rel="stylesheet" href="../x.css">`;
    h.readFile.mockResolvedValue("<p>team</p>");
    h.remoteRead.mockResolvedValue({ base64: btoa(hostile), truncated: false });
    render(
      <TeamEditDiffDialog
        workspace={remoteWorkspace}
        file={edit("page.html")}
        onClose={() => {}}
      />,
    );
    await screen.findByTestId("team-edit-diff-side-by-side");
    expect(h.remoteRead).toHaveBeenCalledTimes(1);
    expect(h.remoteRead).toHaveBeenCalledWith("m1", "ws-1", "page.html");
    expect(h.readFile).toHaveBeenCalledTimes(1);
    expect(h.readFile).toHaveBeenCalledWith("/team/page.html");
    const remote = frames().find((f) => f.title === "Workspace B’s version")!;
    expect(remote.getAttribute("srcdoc")).toBe(
      `<meta http-equiv="Content-Security-Policy" content="${SIDE_FRAME_CSP}">${hostile}`,
    );
    expect(remote.getAttribute("sandbox")).toBe("allow-scripts");
    expect(remote.hasAttribute("src")).toBe(false);
    // The team's side never sees the machine's content, nor the machine's the team's.
    const team = frames().find((f) => f.title === "Team's version")!;
    expect(team.getAttribute("srcdoc")).not.toContain("127.0.0.1");
    expect(remote.getAttribute("srcdoc")).not.toContain("<p>team</p>");
  });

  it("an image added on a machine renders from the bytes it read", async () => {
    atWidth(1000);
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:remote-side");
    onTestFinished(() => createObjectURL.mockRestore());
    h.readFile.mockRejectedValue(new Error("No such file or directory"));
    h.remoteRead.mockResolvedValue({ base64: btoa("\x89PNG"), truncated: false });
    render(
      <TeamEditDiffDialog
        workspace={remoteWorkspace}
        file={edit("art/logo.png", "new")}
        onClose={() => {}}
      />,
    );
    const img = await screen.findByAltText("Workspace B’s version");
    expect(img).toHaveAttribute("src", "blob:remote-side");
    expect(screen.getByTestId("team-edit-diff-one-side")).toHaveTextContent(
      "Workspace B’s version",
    );
  });

  it("an image changed on both sides stays the binary note: the team's copy has no bytes here", async () => {
    atWidth(1000);
    h.readFile.mockResolvedValue("\u0089PNG\u0000");
    h.remoteRead.mockResolvedValue({ base64: btoa("\x89PNG"), truncated: false });
    render(
      <TeamEditDiffDialog
        workspace={remoteWorkspace}
        file={edit("art/logo.png")}
        onClose={() => {}}
      />,
    );
    expect(await screen.findAllByText("Not a text file: no line-by-line view.")).not.toHaveLength(
      0,
    );
    expect(screen.queryByRole("img")).toBeNull();
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

  it("a side that can't be read shows the error, not the whole file as inserted", async () => {
    h.readFile.mockImplementation((p: string) =>
      p.startsWith("/team/")
        ? Promise.reject(new Error("permission denied"))
        : Promise.resolve("mine"),
    );
    render(<TeamEditDiffDialog workspace={workspace} file={edit("a.ts")} onClose={() => {}} />);
    expect(await screen.findByTestId("team-edit-diff-code-error")).toHaveTextContent(
      "permission denied",
    );
    expect(h.review).not.toHaveBeenCalled();
  });
});
