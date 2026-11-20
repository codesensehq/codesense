---
type: added
---

**Seat worktrees clean themselves up.** When a seat's tab or its workspace is closed, and in a background sweep after each launch into the story, a seat worktree is removed with its seat branch once no session runs in it, it is clean, its context edits are published and its commits are in the story branch; otherwise it is kept and its `list_worktrees` row says why (`seatKept`). An agent Relaunch whose folder is gone is now refused instead of starting in the story's base worktree.
