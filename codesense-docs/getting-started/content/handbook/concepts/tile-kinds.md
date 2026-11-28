# Tile kinds and tabs

_With the tiles preview on, any tile holds any kind of content as tabs: dashboards, files, story pages, diffs, Notes, the Inbox, agents and shells._

## Every tile is a tab group

Each tile shows one tab bar, whether it holds one tab or five. Each tab has its kind's icon and its name, and a tab from another team also shows that team's chip. A name that is cut off keeps its full text in the tab's tooltip and in what a screen reader reads. The active tab's own controls sit at the right of the bar, then ⋯ and ✕.

Opening something in a tile adds it as a tab there. Tab bars never nest. Adding or closing a tab redraws only the bar, so the content in the other tabs keeps running.

Only three openings are refused:

- **A workspace.** A workspace is shown, never placed in a tile.
- **A terminal that is already open in another tile.** A terminal has one live copy.
- **Something already open.** Its tab is focused instead of a second copy being opened.

## What each kind shows

- **Dashboard.** The page, with no caption of its own.
- **File.** Its name on the tab, with its path in the tooltip. An HTML file also shows where it comes from, its team and its unread count.
- **Story page.** The story's title, with its stage as the only pill. It opens the owning team's story page.
- **Diff.** One of the story's worktrees against its base. The worktree picker and ‹ › (previous and next change) are always in the bar. ⋯ holds Open in Finder and Copy path for the picked worktree. For a worktree on another machine, Copy path says "On ‹machine›" and copies that machine's path.
- **Notes** and **Inbox.** The same Notes and Inbox as the right pane.
- **Agent** and **shell.** A terminal tab.

## One live copy of a terminal

A terminal runs in one place at a time. If you open a terminal that is already live in another tile, the tile refuses it and says "This terminal is already open in another tile."

## What a dashboard tile may do

A dashboard in a tile has the same access as one in the right pane: the same grants, content security policy, theme and bridge. It is still a dashboard tile, though, not the right pane:

- **Its team.** It reads as its file's team. In a story workspace it reads as the story's team. It keeps that team when you switch teams or when the tile holds agents from two teams. A private or built-in dashboard follows the team on screen.
- **Revealing it.** Revealing the dashboard focuses its tile and leaves the right pane closed.
- **Escape.** Pressing Escape in the dashboard moves focus to its tab.
- **Commands.** Its commands are offered while its tile shows it.
- **When it fails.** If it fails to load, the tile keeps its own page instead of switching to your team's built-in Inbox.
- **Built-in replacements.** A team or private pane with a built-in's id opens in place of that built-in.

With the tiles preview off, dashboards open in the right pane as before.
