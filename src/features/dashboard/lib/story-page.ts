// SPDX-License-Identifier: MIT
import { teamContentPage } from "@/shared/lib/team-content-page";
import type { Org } from "@/shared/types/domain";

/** The `type` values that make a file a story (the pipeline's own set). */
export const STORY_TYPES = ["story", "bug", "spike"] as const;
export type StoryType = (typeof STORY_TYPES)[number];

/**
 * The story type an `.md` declares in its front matter (`type: story|bug|spike`), or `null` for
 * any other file: no front matter, another type, or a `type:` line that is not in the leading
 * `---` block. The pipeline's rule (its front matter reader and `is_pipeline_story`): a leading BOM
 * is skipped, a ` # comment` after the value is dropped (a `#` with no space before it is part of
 * the value, as in YAML), and the value is trimmed and compared in any case.
 */
export function storyTypeOfMarkdown(text: string): StoryType | null {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimEnd() === "---") return typeBefore(lines, i);
  }
  return null;
}

/** One of the pipeline's story types, trimmed and in any case, as its canonical lowercase name. */
function storyTypeOf(value: string): StoryType | null {
  const type = value.trim().toLowerCase();
  return (STORY_TYPES as readonly string[]).includes(type) ? (type as StoryType) : null;
}

// The `type:` value among the front matter's top-level lines `1..end-1`.
function typeBefore(lines: string[], end: number): StoryType | null {
  for (let i = 1; i < end; i++) {
    const match = /^type:[ \t]*(?:"([^"]*)"|'([^']*)'|(.*?))(?:[ \t]+#.*)?[ \t]*$/.exec(lines[i]!);
    if (!match) continue;
    return storyTypeOf(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return null;
}

/** The story type a shell's `<meta name="cs:type">` declares, or `null` for any other page. */
export function storyTypeOfHtml(text: string): StoryType | null {
  for (const tag of text.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\bname\s*=\s*["']cs:type["']/i.test(tag)) continue;
    return storyTypeOf(/\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "");
  }
  return null;
}

/**
 * The story page a team declares in `teams.yml` (`story_page:`, relative to the team's content),
 * or `null` when it declares none. The app names no page of its own: without the setting a story
 * file opens as markdown.
 */
export const teamStoryPage = (orgs: readonly Org[], org: string, team: string) =>
  teamContentPage(orgs, org, team, "story_page");

/** The story page's path under the team's content root. */
export const storyPagePath = (teamContentPath: string, page: string) =>
  `${teamContentPath.replace(/\/+$/, "")}/${page}`;

/**
 * The page's route: it names the story file in the fragment, which the viewer replays to the page,
 * and a link's anchor (`SV-1.md#tasks`) as `at`.
 */
export function storyPageHash(storyPath: string, anchor?: string | null): string {
  const at = anchor?.replace(/^#/, "");
  return `#story=${encodeURIComponent(storyPath)}${at ? `&at=${encodeURIComponent(at)}` : ""}`;
}
