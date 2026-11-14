// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import type { Org } from "@/shared/types/domain";
import {
  STORY_TYPES,
  storyPageHash,
  storyPagePath,
  storyTypeOfMarkdown,
  teamStoryPage,
} from "./story-page";

const orgs = [
  {
    slug: "acme",
    teams: [{ name: "web", story_page: " dashboards/story/app.html " }, { name: "docs" }],
  },
] as unknown as Org[];

describe("storyTypeOfMarkdown", () => {
  it("reads type from the front matter", () => {
    for (const type of STORY_TYPES) {
      expect(storyTypeOfMarkdown(`---\ntype: ${type}\ntitle: x\n---\n# Body\n`)).toBe(type);
    }
  });

  it("accepts quotes, CRLF, a trailing comment and a type that is not the first key", () => {
    expect(storyTypeOfMarkdown('---\r\ntitle: x\r\ntype: "story"\r\n---\r\nbody')).toBe("story");
    expect(storyTypeOfMarkdown("---\ntype: 'bug'\n---\n")).toBe("bug");
    expect(storyTypeOfMarkdown("---\ntype: spike # a timebox\n---\n")).toBe("spike");
  });

  it("is null for a plain doc, another type, no front matter, or a type only in the body", () => {
    expect(storyTypeOfMarkdown("# Notes\n")).toBeNull();
    expect(storyTypeOfMarkdown("---\ntype: doc\n---\n")).toBeNull();
    expect(storyTypeOfMarkdown("---\ntitle: x\n---\ntype: story\n")).toBeNull();
    expect(storyTypeOfMarkdown("text\n---\ntype: story\n---\n")).toBeNull();
    expect(storyTypeOfMarkdown("---\ntype: Story\n---\n")).toBeNull();
    expect(storyTypeOfMarkdown("---\ntype: story\n")).toBeNull();
  });
});

describe("the team's story page", () => {
  it("is the trimmed teams.yml setting, or null", () => {
    expect(teamStoryPage(orgs, "acme", "web")).toBe("dashboards/story/app.html");
    expect(teamStoryPage(orgs, "acme", "docs")).toBeNull();
    expect(teamStoryPage(orgs, "acme", "none")).toBeNull();
    expect(teamStoryPage(orgs, "other", "web")).toBeNull();
  });

  it("is placed under the team's content root, and names the story in the fragment", () => {
    expect(storyPagePath("/ctx/acme/web/content/", "dashboards/story/app.html")).toBe(
      "/ctx/acme/web/content/dashboards/story/app.html",
    );
    expect(storyPageHash("/ctx/acme/web/content/stories/a b.md")).toBe(
      "#story=%2Fctx%2Facme%2Fweb%2Fcontent%2Fstories%2Fa%20b.md",
    );
  });
});
