---
type: security
---

**The Foreman can edit only worktrees beside its home.** Its file rules use a new `{{launch_parent}}` token that a launch on this Mac turns into the launch folder's parent, so they no longer match a `foreman-*` folder anywhere on disk; a rule the folder can't take fails closed with a launch warning.
