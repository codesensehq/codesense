---
type: fixed
---

**Smaller disk use and a faster Worktrees list.** While git-ai's metrics database is idle, CodeSense now trims it to the last three days instead of letting it grow by about 0.25-0.3 GB a day (an agent edit whose checkpoint was missed and that is committed more than three days later no longer gets its AI attribution recovered), and the Worktrees list reads git with a timeout, at most four worktrees at a time, and reuses the answers until a worktree changes.
