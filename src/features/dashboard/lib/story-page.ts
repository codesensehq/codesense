// SPDX-License-Identifier: MIT
import type { Org } from "@/shared/types/domain";

/** The `type` values that make a file a story (the pipeline's own set). */
export const STORY_TYPES = ["story", "bug", "spike"] as const;
export type StoryType = (typeof STORY_TYPES)[number];

/**
 * The story type an `.md` declares in its front matter (`type: story|bug|spike`), or `null` for
 * any other file: no front matter, another type, or a `type:` line that is not in the leading
 * `---` block. Exact lowercase, as the pipeline reads it.
 */
export function storyTypeOfMarkdown(text: string): StoryType | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimEnd() === "---") return typeBefore(lines, i);
  }
  return null;
}

// The `type:` value among the front matter's top-level lines `1..end-1`.
function typeBefore(lines: string[], end: number): StoryType | null {
  for (let i = 1; i < end; i++) {
    const match = /^type:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(lines[i]!);
    if (!match) continue;
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    return (STORY_TYPES as readonly string[]).includes(value) ? (value as StoryType) : null;
  }
  return null;
}

/**
 * The story page a team declares in `teams.yml` (`story_page:`, relative to the team's content),
 * or `null` when it declares none. The app names no page of its own: without the setting a story
 * file opens as markdown.
 */
export function teamStoryPage(orgs: readonly Org[], org: string, team: string): string | null {
  const declared = orgs.find((o) => o.slug === org)?.teams.find((t) => t.name === team)?.story_page;
  return declared?.trim() || null;
}

/** The story page's path under the team's content root. */
export const storyPagePath = (teamContentPath: string, page: string) =>
  `${teamContentPath.replace(/\/+$/, "")}/${page}`;

/** The page's route: it names the story file in the fragment, which the viewer replays to the page. */
export const storyPageHash = (storyPath: string) => `#story=${encodeURIComponent(storyPath)}`;
