// SPDX-License-Identifier: MIT
import {
  basename,
  isAbsolute,
  relative,
  root,
  separator as separatorOf,
  split,
} from "@/shared/lib/path";

/**
 * The terminal caption's path, the way a good shell prompt (starship, p10k)
 * reads it: `$HOME` said as `~`, then only the last two segments, with an
 * ellipsis standing in for everything above them.
 *
 *   /Users/me                              → ~
 *   /Users/me/code                         → ~/code
 *   /Users/me/code/app                     → ~/code/app
 *   /Users/me/.codesense/…/default/demo    → ~/…/default/demo
 *   /usr/local/bin                         → /…/local/bin
 *   /                                      → /
 *   C:\Users\me\code\app                → C:\…\code\app
 *
 * The caption renders `head` and `parent` muted and `leaf` emphasized, so the
 * directory you are in is what the eye lands on.
 */
export interface PromptPath {
  /** Everything before `parent`, ending in its separator: `~/`, `~/…/`,
   *  `/`, `/…/`, `C:\…\` — or empty when the whole path is `~` or a root. */
  head: string;
  /** The segment above the current directory, when shown. */
  parent: string | null;
  /** The current directory (`~` or `/` at those roots). */
  leaf: string;
  /** Whether segments were dropped behind the ellipsis. */
  elided: boolean;
  /** The path as given, for the tooltip and Copy path. */
  full: string;
  /** The path's own separator (`/` or `\`), joining `parent` and ending `head`. */
  separator: string;
}

/** How many trailing segments the caption keeps (parent + current). */
export const PROMPT_PATH_SEGMENTS = 2;

/**
 * Abbreviate `path` for the caption. `home` is the home of the account the
 * session runs as — This Mac's for a local tab, the Machine's for a remote
 * one — and is only applied on a segment boundary (`/Users/me` never
 * abbreviates `/Users/meg`). The caption keeps the path's own separator, so a
 * Windows cwd reads `C:\…\a\repo` and a home-relative one `~\repo`.
 */
export function abbreviatePromptPath(
  path: string,
  home?: string | null,
  segments: number = PROMPT_PATH_SEGMENTS,
): PromptPath {
  const full = path;
  const clean = path.trim();
  const separator = separatorOf(clean);
  // A home with no segments (`/`, `C:\`) abbreviates nothing.
  const homeRest = home && basename(home.trim()) !== "" ? relative(home.trim(), clean) : null;

  let rootName: string;
  let head: string;
  let parts: string[];
  if (homeRest !== null) {
    rootName = "~";
    head = `~${separator}`;
    parts = split(homeRest);
  } else if (isAbsolute(clean)) {
    rootName = root(clean);
    head = /[\\/]$/.test(rootName) ? rootName : `${rootName}${separator}`;
    parts = split(clean);
  } else {
    rootName = "";
    head = "";
    parts = split(clean);
  }

  if (parts.length === 0) {
    return {
      head: "",
      parent: null,
      leaf: rootName || clean || full,
      elided: false,
      full,
      separator,
    };
  }

  const keep = Math.max(1, segments);
  const elided = parts.length > keep;
  const shown = elided ? parts.slice(-keep) : parts;
  const leaf = shown[shown.length - 1];
  const parentParts = shown.slice(0, -1);
  const parent = parentParts.length > 0 ? parentParts.join(separator) : null;

  if (elided) head += `…${separator}`;
  return { head, parent, leaf, elided, full, separator };
}

/** The muted part of the caption: everything before the leaf. */
export function promptPathPrefix(path: PromptPath): string {
  return `${path.head}${path.parent ? `${path.parent}${path.separator}` : ""}`;
}

/** The abbreviated path as one string (`~/…/default/demo-child`). */
export function formatPromptPath(path: PromptPath): string {
  return `${promptPathPrefix(path)}${path.leaf}`;
}
