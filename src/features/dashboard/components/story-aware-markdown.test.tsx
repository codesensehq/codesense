// SPDX-License-Identifier: MIT
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { render, screen, waitFor } from "@/test-utils";
import { fileContentCache } from "@/shared/lib/file-content-cache";
import { renderViewer } from "@/shared/lib/render-viewer";
import { useOrgStore } from "@/shared/stores/org-store";
import { readFile } from "@/tauri/commands";

import { NO_STORY_PAGE_NOTE } from "./story-aware-markdown";

// The viewers are stubs that show what they were given: this tests the choice, not the pages.
const html = vi.hoisted(() => vi.fn());
vi.mock("@/features/dashboard/components/html-viewer", () => ({
  HtmlViewer: (props: Record<string, unknown>) => {
    html(props);
    return createElement("div", { "data-stub": "html" });
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
  html.mockClear();
  vi.mocked(readFile).mockReset();
  fileContentCache.clear();
  declare("pages/story.html");
});

describe("a story file in an .md tab", () => {
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

describe("html story shells keep opening as today", () => {
  it("a .html path is the html viewer on itself, not the story page", () => {
    const shell = `${ROOT}/stories/SV-2.html`;
    render(renderViewer({ ...common, filePath: shell }, md));
    const props = html.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(props.filePath).toBe(shell);
    expect(readFile).not.toHaveBeenCalled();
  });
});
