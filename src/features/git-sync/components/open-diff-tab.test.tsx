// SPDX-License-Identifier: MIT
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  review: vi.fn(),
  workspace: vi.fn(),
  team: vi.fn(),
  management: vi.fn(),
  images: vi.fn(),
}));
vi.mock("@/shared/lib/open-file-in-team", () => ({ openFileInTeam: mocks.team }));
vi.mock("@/shared/lib/open-management-tab", () => ({ openManagementTab: mocks.management }));
vi.mock("../lib/source-redline-source", () => ({
  readOpenDiff: mocks.read,
  readOpenDiffImages: mocks.images,
}));
vi.mock("@/shared/components/code-editor/CodeDiffReview", () => ({
  CodeDiffReview: (props: unknown) => {
    mocks.review(props);
    return <div>Read-only diff</div>;
  },
}));
vi.mock("./redline-prose", () => ({
  RedlineProse: ({ before, after }: { before: string | null; after: string | null }) => (
    <div data-testid="redline">
      {before}→{after}
    </div>
  ),
}));
vi.mock("@/features/dashboard/components/html-viewer", () => ({
  HtmlViewer: () => <div data-testid="html-viewer" />,
}));
vi.mock("@/features/dashboard/components/html-bridge", () => ({
  HTML_BRIDGE_ALLOWLIST: { openWorkspace: mocks.workspace },
}));
import { LARGE_DIFF_CHARS } from "@/shared/lib/render-file-diff";
import { stubResizeObserver } from "@/test/resize-observer-stub";
import { useViewerStore } from "@/shared/stores/viewer-store";
import { OpenDiffTab } from "./open-diff-tab";
const params = {
  repo: "acme/app",
  rev: "abcdef1",
  path: "a.ts",
  storyId: "SV-X",
  range: { start: 2, end: 3 },
};
const path = "virtual://source-diff/" + encodeURIComponent(JSON.stringify(params));
const opened = {
  status: "opened",
  redline: { before: "old", after: "new", binary: false },
  files: [{ path: "a.ts" }],
  resolvedRev: "abcdef1",
};
beforeEach(() => {
  vi.clearAllMocks();
  const { defaultFileDiffMode: _mode, ...settings } = useViewerStore.getState().settings;
  void _mode;
  useViewerStore.setState({ settings });
});
function tabFor(file: string, range?: { start: number; end: number }) {
  const { range: _range, ...rest } = params;
  void _range;
  return (
    "virtual://source-diff/" + encodeURIComponent(JSON.stringify({ ...rest, path: file, range }))
  );
}
it("revalidates on mount and Refresh, discards superseded replies and passes the after range", async () => {
  const replies: ((v: unknown) => void)[] = [];
  mocks.read.mockImplementation(() => new Promise((resolve) => replies.push(resolve)));
  render(<OpenDiffTab filePath={path} />);
  await act(async () => {});
  expect(mocks.read).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText("Refresh"));
  await act(async () => {});
  expect(mocks.read).toHaveBeenCalledTimes(2);
  await act(async () => replies[0]({ ...opened, redline: { before: "stale", after: "stale" } }));
  expect(mocks.review).not.toHaveBeenCalled();
  expect(mocks.read).toHaveBeenCalledTimes(2);
  await act(async () => replies[1](opened));
  expect(mocks.review.mock.calls.at(-1)?.[0]).toMatchObject({
    before: "old",
    after: "new",
    afterRange: params.range,
    collapseUnchanged: false,
  });
  fireEvent.click(screen.getByText("Open in workspace"));
  await waitFor(() => expect(mocks.workspace).toHaveBeenCalledWith({ storyId: "SV-X" }));
});
it("shows a selectable fetch command and keeps a removed worktree honest on a fresh tab read", async () => {
  mocks.read
    .mockResolvedValueOnce({
      status: "commitNotLocal",
      reason: "This commit isn't on this Mac yet",
      fetchCommand: "git fetch origin abcdef1",
    })
    .mockResolvedValueOnce({ status: "worktreeRemoved", reason: "The worktree was removed" });
  const first = render(<OpenDiffTab filePath={path} />);
  expect(await screen.findByDisplayValue("git fetch origin abcdef1")).toHaveAttribute("readonly");
  first.unmount();
  render(<OpenDiffTab filePath={path} />);
  expect(await screen.findByText("The worktree was removed")).toBeVisible();
  expect(mocks.read).toHaveBeenCalledTimes(2);
  expect(mocks.review).not.toHaveBeenCalled();
});
it("a malformed tab address is refused without a read", async () => {
  render(<OpenDiffTab filePath={"virtual://source-diff/" + encodeURIComponent("{not json")} />);
  expect(screen.getByRole("status").textContent).toContain("This diff address is not valid");
  render(
    <OpenDiffTab
      filePath={"virtual://source-diff/" + encodeURIComponent(JSON.stringify({ repo: "acme/app" }))}
    />,
  );
  expect(screen.getAllByRole("status").at(-1)?.textContent).toContain(
    "This diff address is not valid",
  );
  expect(mocks.read).not.toHaveBeenCalled();
});
it("switching file keeps the tab's team context", async () => {
  const team = { org: "acme", team: "dev" };
  mocks.read.mockResolvedValue({ ...opened, files: [{ path: "a.ts" }, { path: "b.ts" }] });
  render(
    <OpenDiffTab
      filePath={"virtual://source-diff/" + encodeURIComponent(JSON.stringify({ ...params, team }))}
    />,
  );
  await waitFor(() => expect(screen.getByLabelText("File")).toBeTruthy());
  expect(mocks.read.mock.calls[0][0]).not.toHaveProperty("team");
  fireEvent.change(screen.getByLabelText("File"), { target: { value: "b.ts" } });
  expect(mocks.management).not.toHaveBeenCalled();
  const [target, options] = mocks.team.mock.calls[0];
  expect(target).toMatchObject(team);
  expect(
    JSON.parse(decodeURIComponent(target.path.slice("virtual://source-diff/".length))),
  ).toEqual({ repo: "acme/app", rev: "abcdef1", path: "b.ts", storyId: "SV-X", team });
  expect(options).toMatchObject({ newTab: true });
});
it("a changed markdown file is the shared redline, with Source a switch away", async () => {
  mocks.read.mockResolvedValue({ ...opened, files: [{ path: "doc.md" }] });
  render(<OpenDiffTab filePath={tabFor("doc.md")} />);
  expect(await screen.findByTestId("redline")).toHaveTextContent("old→new");
  expect(mocks.review).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  expect(mocks.review).toHaveBeenCalled();
  expect(useViewerStore.getState().settings.defaultFileDiffMode?.markdown).toBe("source");
});
function atWidth(width: number) {
  const ro = stubResizeObserver(width);
  onTestFinished(() => ro.restore());
}
const htmlRead = {
  ...opened,
  redline: { before: "<p>old</p>", after: "<p>new</p>", binary: false, status: "modified" },
  files: [{ path: "page.html" }],
};
const frameDocs = () =>
  Array.from(document.querySelectorAll("iframe")).map((f) => [
    f.title,
    f.getAttribute("srcdoc")?.endsWith(f.title === "Before" ? "<p>old</p>" : "<p>new</p>"),
  ]);
it("a changed HTML file renders Before and After live side by side at 900 px", async () => {
  atWidth(900);
  mocks.read.mockResolvedValue(htmlRead);
  render(<OpenDiffTab filePath={tabFor("page.html")} />);
  expect(await screen.findByTestId("open-diff-side-by-side")).toBeVisible();
  expect(frameDocs()).toEqual([
    ["Before", true],
    ["After", true],
  ]);
  expect(screen.getByTestId("open-diff-rendered-alone")).toBeVisible();
  expect(mocks.review).not.toHaveBeenCalled();
  expect(screen.queryByTestId("html-viewer")).toBeNull();
});
it("a changed HTML file shows one side at a time below 900 px, Source a switch away", async () => {
  atWidth(899);
  mocks.read.mockResolvedValue(htmlRead);
  render(<OpenDiffTab filePath={tabFor("page.html")} />);
  expect(await screen.findByTestId("open-diff-one-at-a-time")).toBeVisible();
  expect(frameDocs()).toEqual([["After", true]]);
  fireEvent.click(screen.getByRole("button", { name: "Before" }));
  expect(frameDocs()).toEqual([["Before", true]]);
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  expect(mocks.review).toHaveBeenCalled();
  expect(document.querySelector("iframe")).toBeNull();
});
it("a line range into an HTML file opens it as source, highlighted", async () => {
  mocks.read.mockResolvedValue(htmlRead);
  render(<OpenDiffTab filePath={tabFor("page.html", { start: 1, end: 1 })} />);
  await waitFor(() => expect(mocks.review).toHaveBeenCalled());
  expect(mocks.review.mock.calls.at(-1)?.[0]).toMatchObject({ afterRange: { start: 1, end: 1 } });
  expect(document.querySelector("iframe")).toBeNull();
});
it("a changed .ts file is a code diff in the shared code mode, never a redline", async () => {
  useViewerStore.getState().setFileDiffMode("code", "structural");
  mocks.read.mockResolvedValue(opened);
  render(<OpenDiffTab filePath={path} />);
  await waitFor(() => expect(mocks.review).toHaveBeenCalled());
  expect(mocks.review.mock.calls.at(-1)?.[0]).toMatchObject({ diffMode: "structural" });
  expect(screen.queryByTestId("redline")).toBeNull();
});
it("a very large diff waits behind the large-diff gate", async () => {
  mocks.read.mockResolvedValue({
    ...opened,
    redline: { before: "x".repeat(LARGE_DIFF_CHARS), after: "y", binary: false },
  });
  render(<OpenDiffTab filePath={path} />);
  expect(await screen.findByTestId("open-diff-large-gate")).toBeVisible();
  expect(mocks.review).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("open-diff-show-anyway"));
  expect(mocks.review.mock.calls.at(-1)?.[0]).toMatchObject({ diffMode: "line" });
});
it("a binary file keeps its note", async () => {
  mocks.read.mockResolvedValue({ ...opened, redline: { before: "", after: "", binary: true } });
  render(<OpenDiffTab filePath={path} />);
  expect(await screen.findByText("Binary file — a text diff is unavailable.")).toBeVisible();
  expect(mocks.review).not.toHaveBeenCalled();
  expect(mocks.images).not.toHaveBeenCalled();
});
function openPng(images: unknown, width = 900) {
  atWidth(width);
  const blob = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = vi.fn(() => "blob:side");
  URL.revokeObjectURL = vi.fn();
  onTestFinished(() => {
    URL.createObjectURL = blob.create;
    URL.revokeObjectURL = blob.revoke;
  });
  mocks.read.mockResolvedValue({
    ...opened,
    files: [{ path: "art/logo.png" }],
    redline: { before: "", after: "", binary: true, status: "modified" },
  });
  mocks.images.mockResolvedValue(images);
  render(<OpenDiffTab filePath={tabFor("art/logo.png")} />);
}
const pngImages = () => Array.from(document.querySelectorAll("img")).map((img) => img.alt);
it("a changed PNG reads its sides at the same revision and renders Before and After at 900 px", async () => {
  openPng({
    status: "opened",
    resolvedRev: "abcdef1",
    images: { before: "QQ==", after: "Qg==", tooLarge: false },
  });
  expect(await screen.findByTestId("open-diff-side-by-side")).toBeVisible();
  expect(pngImages()).toEqual(["Before", "After"]);
  expect(mocks.images).toHaveBeenCalledWith(
    expect.objectContaining({ repo: "acme/app", rev: "abcdef1", path: "art/logo.png" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  expect(await screen.findByTestId("open-diff-image-source")).toHaveTextContent(
    "An image has no text diff. Side by side compares it.",
  );
  expect(pngImages()).toEqual([]);
});
it("a changed PNG shows one side at a time below 900 px", async () => {
  openPng(
    {
      status: "opened",
      resolvedRev: "abcdef1",
      images: { before: "QQ==", after: "Qg==", tooLarge: false },
    },
    899,
  );
  expect(await screen.findByTestId("open-diff-one-at-a-time")).toBeVisible();
  expect(pngImages()).toEqual(["After"]);
});
it("a PNG past the size cap, or one the read refuses, says why, with Side by side disabled", async () => {
  for (const [images, reason] of [
    [
      {
        status: "opened",
        resolvedRev: "abcdef1",
        images: { before: null, after: null, tooLarge: true },
      },
      "Over the 8 MB limit for drawing here",
    ],
    [{ status: "refused", reason: "no" }, "Couldn’t read the image"],
  ] as const) {
    openPng(images);
    await waitFor(() => expect(mocks.images).toHaveBeenCalled());
    expect(await screen.findByTestId("open-diff-image-source")).toHaveTextContent(
      `An image has no text diff. ${reason}.`,
    );
    expect(screen.getByRole("button", { name: "Side by side" })).toHaveAttribute("title", reason);
    expect(pngImages()).toEqual([]);
    cleanup();
    mocks.images.mockClear();
  }
});

it("a PNG whose bytes are still being read says so, not Binary file", async () => {
  openPng(new Promise(() => {}));
  // Said by the image's one status node (and shown in its skeleton).
  expect(await screen.findByTestId(/-image-status$/)).toHaveTextContent("Reading the image…");
  expect(screen.queryByText("Binary file — a text diff is unavailable.")).toBeNull();
});
it("a line range into a markdown file opens it as source, highlighted, without changing the default", async () => {
  mocks.read.mockResolvedValue({ ...opened, files: [{ path: "doc.md" }] });
  render(<OpenDiffTab filePath={tabFor("doc.md", { start: 2, end: 3 })} />);
  await waitFor(() => expect(mocks.review).toHaveBeenCalled());
  expect(mocks.review.mock.calls.at(-1)?.[0]).toMatchObject({
    afterRange: { start: 2, end: 3 },
    collapseUnchanged: false,
  });
  expect(screen.queryByTestId("redline")).toBeNull();
  expect(useViewerStore.getState().settings.defaultFileDiffMode).toBeUndefined();
  // The reader can still go to the redline.
  fireEvent.click(screen.getByRole("button", { name: "Redline" }));
  expect(await screen.findByTestId("redline")).toBeInTheDocument();
});
