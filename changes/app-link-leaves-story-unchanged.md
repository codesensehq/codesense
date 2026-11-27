---
type: fixed
---

**Opening or reconciling a story worktree from the app no longer edits the story.** Linking a worktree used to write its branch into the story's `branch` frontmatter in your context clone, which left the clone with an uncommitted change that blocked the next pull. The app now leaves the story file as it is and reports the worktree's branch instead, as `open_workspace` already does. After Reconcile on a story that records `branch_name` and `dev_branch` but no `branch`, the branch-mismatch notice hides until you reload.
