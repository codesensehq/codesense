// SPDX-License-Identifier: MIT
import { createElement, Profiler } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { render, screen, waitFor } from "@/test-utils";
import { fileContentCache } from "@/shared/lib/file-content-cache";
import { renderViewer } from "@/shared/lib/render-viewer";
import { useOrgStore } from "@/shared/stores/org-store";
import { readFile } from "@/tauri/commands";

import { NO_STORY_PAGE_NOTE, missingStoryPageNote } from "./story-aware-markdown";

// The viewers are stubs that show what they were given: this tests the choice, not the pages.
const html = vi.hoisted(() => vi.fn());
// When set, the page's file is gone: the stub renders what the viewer would on a 404.
const page = vi.hoisted(() => ({ missing: false }));
vi.mock("@/features/dashboard/components/html-viewer", () => ({
  HtmlViewer: (props: Record<string, unknown>) => {
    html(props);
    const missing = props.renderMissing as (() => unknown) | undefined;
    if (page.missing && missing) return missing();
    return createElement("div", { "data-stub": page.missing ? "deleted" : "html" });
  },
}));
vi.mock("@/features/dashboard/components/markdown-viewer", () => ({
  MarkdownViewer: () => createElement("div", { "data-stub": "markdown" }),
}));
vi.mock("@/tauri/commands", async (orig) => ({
  ...(await orig<typeof import("@/tauri/commands")>()),
  readFile: vi.fn(),
}));

const TEAM_KEY = "acme:web";
const ROOT = "/ctx/acme/web/content";
const STORY = `${ROOT}/stories/SV-1.md`;
const common = { hostTeamKey: TEAM_KEY, teamContentPath: ROOT, refreshKey: 0 };
const md = { changedPaths: null, pendingHash: null };

const declare = (storyPage?: string) =>
  useOrgStore.setState({
    orgs: [
      { slug: "acme", teams: [{ name: "web", source_repos: [], story_page: storyPage }] },
    ] as never,
  });
const open = (path = STORY) => render(renderViewer({ ...common, filePath: path }, md));
const files = (map: Record<string, string>) =>
  vi.mocked(readFile).mockImplementation(async (path: string) => {
    if (path in map) return map[path]!;
    throw new Error("missing");
  });

beforeEach(() => {
  page.missing = false;
  html.mockClear();
  vi.mocked(readFile).mockReset();
  fileContentCache.clear();
  declare("pages/story.html");
});

describe("a story file in an .md tab", () => {
  it("opens as markdown and says why when the team's story page isn't there", async () => {
    page.missing = true;
    files({ [STORY]: "---\ntype: story\n---\n# One\n" });
    const { container } = open();
    await waitFor(() => expect(container.querySelector('[data-stub="markdown"]')).not.toBeNull());
    expect(container.querySelector('[data-stub="deleted"]')).toBeNull();
    const note = screen.getByTestId("story-page-missing");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveTextContent(missingStoryPageNote("pages/story.html"));
    expect(note).toHaveTextContent("pages/story.html");
  });

  it("opens the team's story page in the same tab, naming the file in the fragment", async () => {
    files({ [STORY]: "---\ntype: story\ntitle: One\n---\n# One\n" });
    const { container } = open();
    await waitFor(() => expect(container.querySelector('[data-stub="html"]')).not.toBeNull());
    expect(container.querySelector('[data-stub="markdown"]')).toBeNull();
    const props = html.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(props.filePath).toBe(`${ROOT}/pages/story.html`);
    expect(props.pendingHash).toBe(`#story=${encodeURIComponent(STORY)}`);
    expect(props.hostTeamKey).toBe(TEAM_KEY);
  });

  it("is the same for a bug and a spike", async () => {
    for (const type of ["bug", "spike"]) {
      files({ [STORY]: `---\ntype: ${type}\n---\n` });
      const { container, unmount } = open();
      await waitFor(() => expect(container.querySelector('[data-stub="html"]')).not.toBeNull());
      unmount();
      fileContentCache.clear();
    }
  });

  it("shows neither viewer while the type is being read", async () => {
    let release: (text: string) => void = () => {};
    vi.mocked(readFile).mockImplementation(() => new Promise<string>((ok) => (release = ok)));
    const { container } = open();
    expect(screen.getByTestId("story-detect")).toBeInTheDocument();
    expect(container.querySelector('[data-stub="markdown"]')).toBeNull();
    release("---\ntype: story\n---\n");
    await waitFor(() => expect(container.querySelector('[data-stub="html"]')).not.toBeNull());
  });

  it("reads the viewer's cached text instead of the file when the cache is current", async () => {
    fileContentCache.set(STORY, "---\ntype: story\n---\n", 0);
    const { container } = open();
    await waitFor(() => expect(container.querySelector('[data-stub="html"]')).not.toBeNull());
    expect(readFile).not.toHaveBeenCalled();
  });

  it("chooses on the first render from a current cache, with no blank frame", () => {
    // One commit, and it holds the viewer: no blank detection frame is painted before it.
    const commits = (path: string) => {
      let count = 0;
      const view = render(
        createElement(
          Profiler,
          { id: "md", onRender: () => count++ },
          renderViewer({ ...common, filePath: path }, md),
        ),
      );
      view.unmount();
      return count;
    };
    fileContentCache.set(STORY, "---\ntype: story\n---\n", 0);
    fileContentCache.set(`${ROOT}/README.md`, "# Readme\n", 0);
    expect(commits(STORY)).toBe(1);
    expect(html).toHaveBeenCalledTimes(1);
    expect(commits(`${ROOT}/README.md`)).toBe(1);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("keeps a warm-opened page mounted, with no read, when another file in the team changes", () => {
    fileContentCache.set(STORY, "---\ntype: story\n---\n", 0);
    const view = render(renderViewer({ ...common, filePath: STORY }, md));
    const page = view.container.querySelector('[data-stub="html"]');
    expect(page).not.toBeNull();
    const elsewhere = { ...md, changedPaths: new Set([`${ROOT}/stories/SV-2.md`]) };
    view.rerender(renderViewer({ ...common, refreshKey: 1, filePath: STORY }, elsewhere));
    expect(view.container.querySelector('[data-stub="html"]')).toBe(page);
    expect(screen.queryByTestId("story-detect")).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("keeps a warm-opened page mounted while its own file is re-read, then follows the new type", async () => {
    fileContentCache.set(STORY, "---\ntype: story\n---\n", 0);
    let release: (text: string) => void = () => {};
    vi.mocked(readFile).mockImplementation(() => new Promise<string>((ok) => (release = ok)));
    const view = render(renderViewer({ ...common, filePath: STORY }, md));
    const page = view.container.querySelector('[data-stub="html"]');
    expect(page).not.toBeNull();
    const mine = { ...md, changedPaths: new Set([STORY]) };
    view.rerender(renderViewer({ ...common, refreshKey: 1, filePath: STORY }, mine));
    expect(readFile).toHaveBeenCalledWith(STORY);
    expect(screen.queryByTestId("story-detect")).toBeNull();
    expect(view.container.querySelector('[data-stub="html"]')).toBe(page);
    release("---\ntype: doc\n---\n# Now a doc\n");
    await waitFor(() =>
      expect(view.container.querySelector('[data-stub="markdown"]')).not.toBeNull(),
    );
  });

  it("carries a link's anchor to the page, consumes the host's pending hash, and keeps the anchor", async () => {
    fileContentCache.set(STORY, "---\ntype: story\n---\n", 0);
    const consumed = vi.fn();
    const at = { ...md, pendingHash: "#acceptance-criteria", onPendingHashConsumed: consumed };
    const view = render(renderViewer({ ...common, filePath: STORY }, at));
    const hash = `#story=${encodeURIComponent(STORY)}&at=acceptance-criteria`;
    expect((html.mock.calls.at(-1)![0] as Record<string, unknown>).pendingHash).toBe(hash);
    await waitFor(() => expect(consumed).toHaveBeenCalled());
    // Once the host clears its pending hash, the page keeps the anchor it was opened at.
    view.rerender(renderViewer({ ...common, filePath: STORY }, md));
    expect((html.mock.calls.at(-1)![0] as Record<string, unknown>).pendingHash).toBe(hash);
  });

  it("opens as markdown, and says why, when the team has no story page", async () => {
    declare(undefined);
    files({ [STORY]: "---\ntype: story\n---\n# One\n" });
    const { container } = open();
    expect(await screen.findByTestId("story-no-page")).toHaveTextContent(NO_STORY_PAGE_NOTE);
    expect(container.querySelector('[data-stub="markdown"]')).not.toBeNull();
    expect(container.querySelector('[data-stub="html"]')).toBeNull();
  });
});

describe("any other .md", () => {
  it("is the markdown viewer, with no note, whether or not the team has a story page", async () => {
    for (const page of ["pages/story.html", undefined]) {
      declare(page);
      fileContentCache.clear();
      files({ [`${ROOT}/README.md`]: "---\ntype: doc\n---\n# Readme\n" });
      const { container, unmount } = open(`${ROOT}/README.md`);
      await waitFor(() => expect(container.querySelector('[data-stub="markdown"]')).not.toBeNull());
      expect(container.querySelector('[data-stub="html"]')).toBeNull();
      expect(screen.queryByTestId("story-no-page")).toBeNull();
      unmount();
    }
  });

  it("is the markdown viewer when the file can't be read (it reports that itself)", async () => {
    files({});
    const { container } = open();
    await waitFor(() => expect(container.querySelector('[data-stub="markdown"]')).not.toBeNull());
  });
});

describe("a host that names no team (the worktree editor)", () => {
  it("is the markdown viewer for a story file, with no read and no note", () => {
    files({ [STORY]: "---\ntype: story\n---\n# One\n" });
    const { container } = render(
      renderViewer({ filePath: STORY, teamContentPath: ROOT, refreshKey: 0 }, md),
    );
    expect(container.querySelector('[data-stub="markdown"]')).not.toBeNull();
    expect(screen.queryByTestId("story-no-page")).toBeNull();
    expect(screen.queryByTestId("story-detect")).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe("html story shells keep opening as today", () => {
  it("a .html path is the html viewer on itself, not the story page", () => {
    const shell = `${ROOT}/stories/SV-2.html`;
    render(renderViewer({ ...common, filePath: shell }, md));
    const props = html.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(props.filePath).toBe(shell);
    expect(readFile).not.toHaveBeenCalled();
  });
});
