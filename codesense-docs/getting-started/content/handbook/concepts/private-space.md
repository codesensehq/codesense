# Private

_The one place for what only you see: notes, files, panes, routines and agents kept for each org._

**Private** is where things that are only yours live: notes, a skill you're
still trying out, a pane just for you, a routine or an agent nobody else
needs. It's yours to keep, not a throwaway: nothing in it is shared.

Open it from the menu in the title bar that names your context repo and team:
choose **Private** under **You** (or search "Private" in the command palette).
It lists, for the org you have open:

- **Notes**: your notes for this org. Opening one shows it in the Notes panel.
- **Files**: files that apply in this org's work. In a team's worktrees each
  one replaces the team's file at the same place, and shows a **From private**
  badge.
- **Panes**: right panes kept just for you. Opening one shows it in the side panel.
- **Routines** and **Agents** kept just for you.
- **All orgs**: skills, prompts, snippets and templates that apply in every
  org. Anything else in that folder is listed as not used.

## Only me

When you create a file, a routine or an agent, **Who can use it** asks where it
goes. It starts at the team; pick **Only me** to keep it in Private for the
open org instead.

## Each org keeps its own

Everything is filed under the org you made it in and only ever acts inside
that org's work, whichever org you have open. Only the **All orgs** items
carry across. To keep a team's worktrees free of your items, turn off **Use my
private items in ‹Team›** in that same title-bar menu.

## Saved tile arrangements

With the tiles preview on, the arrangements you save (a workspace's tiles,
a group of them, a starter layout) are kept in Private too, one file each, for
the org and the profile you saved them in. Another profile on this Mac never
sees them, and they never sync or push: your Private repo ignores them, so they
never show as changes either. Each file holds its tiles and the size of every
split, and a restart opens them exactly as you left them.

- A tile is saved by what it shows (an agent, a team doc, a workspace or a
  terminal tab), never by a file path into your team's content. A folder you
  opened as a plain workspace is saved by its folder, which stays on this Mac
  and is never shared. A tile whose doc or agent
  isn't here yet, before a sync or in a sparse worktree, is kept, and opens
  once it arrives.
- A saved arrangement that's damaged, or that a newer CodeSense wrote, is
  listed as **can't be read**. CodeSense leaves that file exactly as it is and
  never saves over it, so a newer version can still open it.
- Moving, resizing or closing a tile saves on its own; there is no Save. A
  window saves each change as the step you took (this tile moved there, that
  split resized), not as a copy of the whole arrangement, so two windows and an
  agent can change one arrangement at once without losing each other's steps.
  If another window saved first, yours is applied on top of what it saved. If an
  agent changed the same tile in the meantime, your window shows the agent's
  change and you repeat yours.
- A change another window or an agent saves shows in your open window at once,
  in that arrangement only: the tiles it didn't touch don't redraw, and an
  arrangement you don't have on screen changes nothing you see.
- A window keeps up to three pinned tiles. They're saved with the arrangements
  of the org you're in, under the window's own name, so a window that reopens
  under the same name gets its pins back, and the pins of a window that isn't
  open are kept. For now, pins belong to the org you pinned them in: switch to
  another org and the window shows that org's pins instead.
- With the preview on, a window opens each arrangement from its saved file. An
  arrangement that has no file yet opens as it did before, and gets its file
  the first time you change it.
- With the tiles preview off, CodeSense saves no arrangement and changes none,
  and the files you saved stay as they are. Turn the preview back on and they
  open unchanged.
- Only CodeSense itself reads your saved arrangements. A dashboard or any
  other page can't subscribe to them or get them in its first paint, even with
  every permission granted, because an arrangement names every tile you've set
  out.

## Share it when it's ready

Each item in Private has a **⋯** menu (a **From private** file in a worktree
has the same menu on right-click):

- **Share with ‹Team›…** moves it to the same place in the team's
  `content/`. It's then an ordinary change in the context repo: you, or an
  agent you ask, commit and push it, and teammates get it on their next pull.
- **Copy to another org…** copies it into your Private for another org.
- **Use in all orgs** moves a skill, prompt, snippet or template to
  **All orgs**. **Only this org** moves it back.
- **Remove…** deletes it.

To go the other way, a team file's **⋯** menu in the left nav has
**Move to…** and **Copy to…**, and Private is one of the places it can go.

> **You back it up**
>
>   Private is a local folder under `~/.codesense/` on this Mac. CodeSense never
>   copies or pushes it anywhere. Back it up yourself, or ask an agent to.

The full guide ships in the app's docs: **The model → Private & All-orgs**.

## Your items in every org

Your all-orgs folder holds the skills, prompts, snippets and templates you want everywhere. They follow you into every org you work in.

They live in your private all-orgs folder, `scratch/all-orgs/`, on your Mac. Keep personal tools here: your review checklist, your favourite prompts. Keep team rules out of it, because teammates never see this folder; put those in team content instead.

> **Caution**
>
> Private and all-orgs files are just as easy to leak as any other file. Keep API keys and tokens out of every layer.
