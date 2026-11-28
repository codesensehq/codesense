# Live tiles

_With the tiles preview on, a tile you rearrange keeps running. A dashboard never reloads and its page keeps what you typed._

## What never reloads

Each tile's content is loaded once, the first time the tile is shown in the window. After that it stays where it is while the arrangement around it changes. None of these reload a tile or reset its page:

- resizing tiles or the window, and folding the sidebar
- closing, moving or splitting a tile beside it
- switching a tile's tab, and switching back
- expanding a tile to fill the window, and restoring it
- opening another team's doc or agent beside it
- the arrangement being reloaded from its saved file, or changed by another window or an agent

A tile that does load shows its last view greyed while it loads, or a placeholder in its own shape when it has never been shown. The word "Loading" appears only after 400 ms, and the tile keeps its size when its content arrives.

## What keep-alive keeps

A tile you close or hide stays loaded in the background, so opening it again is instant. Each window keeps up to 10 hidden tiles. When an 11th is hidden, the one shown least recently is unloaded first.

Some tiles are never unloaded:

- every tile on screen, and the tab each tile shows
- a tile whose content asks to be kept

A hidden tile still updates its badge, at most once every 2 seconds. It doesn't take clicks, and menus, dialogs and drags always sit above every tile.

With the tiles preview off, CodeSense shows your workspaces as before and keeps no tile loaded.
