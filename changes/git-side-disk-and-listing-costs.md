---
type: fixed
---

**Smaller disk use and a faster Worktrees list.** CodeSense now trims git-ai's local metrics database to the last three days instead of letting it grow by about a gigabyte a day, and the Worktrees list reads each worktree's git state with a timeout, at most four at a time, and reuses it until the worktree changes.
