---
type: added
---

**A named story session can have its own worktree.** `open_workspace` takes `seatWorktree`: `{kind:"branch"}` gives the session a writable worktree on its own branch cut from the story branch, and `{kind:"commit", commit}` a detached checkout pinned to that commit with no setup; without it every session of a story still shares the story's worktree.
