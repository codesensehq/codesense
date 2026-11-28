# Windows

_Move a tab, a workspace or a group into a window of its own, and bring it back. Agents and terminals keep running throughout._

CodeSense opens in one main window. With tiles on, you can move a tab into a new window, or open a workspace or group in one, and put that window on another monitor. Each thing lives in one window at a time. Moving it never restarts it: a terminal's session keeps running in the terminal server, and only the window that shows it changes.

> **With tiles off**
>
> Separate windows come with tiles, which ship turned off. With tiles off, CodeSense has one main window, and nothing moves into a window of its own.

## Move a tab to its own window

Choose **Move to New Window** from a tab's menu, or from the palette (<kbd>⌘K</kbd>). It works for a file, a dashboard, a story page or an Inbox message. The new window comes forward and takes focus, and that is the only sign the move worked: there is no message.

The new window shows the tab full-window under a small caption bar with its name and team. The bar's **⋯** menu has **Move into Main Window** and **Close**, and the palette there offers **Move into Main Window** too. The window's title is the tab's name and its team, such as "invoice-flow.md · billing".

Some tabs can't move, and their row stays in the menu, dimmed, with the reason:

- An agent or terminal tab moves with its workspace: open the workspace in a new window instead.
- A tab with an unsaved edit says "‹name› has an unsaved edit; finish or discard it first".
- A tab that can't be reopened elsewhere says "This tab can't be reopened in another window".

## Open a workspace or group in a new window

Choose **Open in New Window** from the Workspace or Group button's menu, or "Open ‹name› in New Window" from the main window's palette. Its tiles move to the new window as they are, live, and its agents keep running. The window it left goes back to what it showed before.

A second window is a full window, not tied to a team. It has its own strip, with Home and its one workspace or group, its own pins, a collapsed nav and the Inbox count in its title bar. Its title is the workspace or group, then the context repo. The CLI workspace at the bottom stays in the main window only.

## Something another window holds

When another window holds a workspace or tile, the main window's nav marks its row "in window 2". Clicking the row brings window 2 forward instead of opening a second copy.

A tile is live in one window at a time. Where it's live elsewhere, it shows "Showing in window ‹n›" with two buttons:

- **Bring here** moves the tile to this window.
- **Go to window** brings the window that has it forward.

When **Bring here** can't move it, the tile keeps **Go to window** and says why.

## When a move is refused

A move that can't happen leaves everything where it was and says why, in the menu row or in a message:

- "‹name› has an unsaved edit; finish or discard it first"
- "‹name› is already moving"
- "Couldn't move ‹name›: the other window didn't answer"
- "Couldn't move ‹name›: the new window didn't open"
- "Couldn't move ‹name›: the other window closed"
- "That window already has an item open"
- "‹name› can't be opened in a new window: ‹reason›", or "‹name› couldn't open in a new window" when it timed out

A tab you start editing while it moves stays where it was and says "Finish or discard your edit first (Done · Esc)".

Terminals move only when they run on this Mac:

- "Terminals on other Machines can't move to another window yet. ‹Machine› has terminals here." A workspace or group with a terminal on a [remote machine](remote-machines.md) stays in its window.
- "Update the terminal server to move terminals between windows" means this Mac's terminal server is from an older CodeSense. Update it, then move again.

While a move is on its way, the new window says "Moving ‹name›… It opens here when window ‹n› lets go." If the move doesn't finish within a few seconds, it gives up and the window it came from says so.

A window whose last item moved out or was closed stays open and says "Nothing in this window", with **Go to main window** and **Close window**.

## When a window closes or crashes

Close a second window and what it held goes back to the main window. The same happens if the window crashes. No terminal or agent session ends: they run in the terminal server, not in a window, and they show again in the main window. See [Terminals](terminals.md#closing-the-window-vs-quitting) for what keeps running when you quit.

Terminal output goes to the window that shows the terminal. A terminal that needs you still raises its dot and the badge in the main window, wherever it's showing.
