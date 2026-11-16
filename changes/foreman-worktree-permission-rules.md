---
type: fixed
---

**The Foreman can edit and commit in its worktrees again.** Claude never matched the Foreman's `../foreman-*` file rules, so it refused every edit in a Foreman worktree and the Foreman stopped before committing. The Foreman now has plain read, edit and write access, and its instructions say where to work: only in its own worktree, never in home, agent config or git internals.
