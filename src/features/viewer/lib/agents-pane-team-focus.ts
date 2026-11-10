// SPDX-License-Identifier: MIT
/**
 * A team header's funnel: show only that team by hiding every other one in the pane's "By team"
 * hide list, the same list the filter menu's Teams checklist edits. Whether the funnel is on is
 * read from that list, never stored beside it, so the funnel and the menu cannot disagree; what
 * was hidden before the funnel is kept so a second click puts exactly that back.
 */

/** What the pane had hidden when a team's funnel went on, so turning it off restores it. */
export interface TeamFocusRestore {
  teamKey: string;
  hidden: readonly string[];
}
