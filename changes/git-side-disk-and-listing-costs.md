---
type: fixed
---

**Smaller disk use and a faster Worktrees list.** CodeSense now trims git-ai's local metrics database to the last three days while the app is idle, instead of letting it grow by about a gigabyte a day (an agent edit whose checkpoint was missed and that is committed more than three days later no longer gets its AI attribution recovered), and the Worktrees list reads git with a timeout, at most four worktrees at a time, and reuses the answers until a worktree changes.
