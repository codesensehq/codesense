// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";

import type { Org } from "@/shared/types/domain";
import {
  focusedStoryFile,
  openStoryDashboard,
  type StoryDashboardDeps,
} from "./open-story-dashboard";

const ROOT = "/ctx/acme/web/content";
const STORY = `${ROOT}/stories/SV-1.md`;
const orgs = (storyPage?: string) =>
  [{ slug: "acme", teams: [{ name: "web", story_page: storyPage }] }] as unknown as Org[];

function deps(extra: Partial<StoryDashboardDeps> = {}): StoryDashboardDeps & {
  open: ReturnType<typeof vi.fn>;
  tell: ReturnType<typeof vi.fn>;
} {
  const open = vi.fn();
  const tell = vi.fn();
  return {
    teamKey: "acme:web",
    orgs: orgs("pages/story.html"),
    workspaceStory: null,
    activeTab: null,
    read: async () => "",
    open,
    tell,
    ...extra,
  } as never;
}

describe("focusedStoryFile", () => {
  it("is the focused story workspace's file", async () => {
    expect(await focusedStoryFile(deps({ workspaceStory: STORY }))).toBe(STORY);
  });

  it("else the active tab when it is a story md or a story shell", async () => {
    const md = deps({ activeTab: STORY, read: async () => "---\ntype: spike\n---\n" });
    expect(await focusedStoryFile(md)).toBe(STORY);
    const shell = deps({
      activeTab: `${ROOT}/stories/SV-2.html`,
      read: async () => '<meta name="cs:type" content="story">',
    });
    expect(await focusedStoryFile(shell)).toBe(`${ROOT}/stories/SV-2.html`);
  });

  it("is null for a plain doc, an unreadable tab, another file type, or no tab", async () => {
    expect(
      await focusedStoryFile(deps({ activeTab: `${ROOT}/README.md`, read: async () => "# Hi" })),
    ).toBeNull();
    expect(
      await focusedStoryFile(
        deps({
          activeTab: STORY,
          read: async () => {
            throw new Error("gone");
          },
        }),
      ),
    ).toBeNull();
    expect(await focusedStoryFile(deps({ activeTab: `${ROOT}/a.png` }))).toBeNull();
    expect(await focusedStoryFile(deps())).toBeNull();
  });
});

describe("openStoryDashboard", () => {
  it("opens the focused story's file, which draws the team's story page", async () => {
    const d = deps({ workspaceStory: STORY });
    await openStoryDashboard(d);
    expect(d.open).toHaveBeenCalledWith(STORY);
    expect(d.tell).not.toHaveBeenCalled();
  });

  it("says why, and opens nothing, when no story is in focus", async () => {
    const d = deps();
    await openStoryDashboard(d);
    expect(d.open).not.toHaveBeenCalled();
    expect(d.tell).toHaveBeenCalledWith(
      "No story in focus: open a story's workspace or its file to see its dashboard.",
    );
  });

  it("opens an md story as markdown, and says the team has no story page, when it names none", async () => {
    const d = deps({ workspaceStory: STORY, orgs: orgs(undefined) });
    await openStoryDashboard(d);
    expect(d.open).toHaveBeenCalledWith(STORY);
    expect(d.tell).toHaveBeenCalledWith(
      "This team has no story page (story_page in teams.yml), so its story opens as markdown.",
    );
  });

  it("opens a story shell without that note: it is its own page", async () => {
    const shell = `${ROOT}/stories/SV-2.html`;
    const d = deps({ workspaceStory: shell, orgs: orgs(undefined) });
    await openStoryDashboard(d);
    expect(d.open).toHaveBeenCalledWith(shell);
    expect(d.tell).not.toHaveBeenCalled();
  });
});
