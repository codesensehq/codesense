---
type: fixed
---

**Opening a story workspace no longer edits the story.** `open_workspace` used to write the worktree's branch into the story's `branch` frontmatter in your context clone, which left the clone with an uncommitted change that blocked the next pull. It now leaves the story file as it is, and its `reconciled` field reports `{from,to}` on every open while the story's `branch` differs from the worktree's branch. Opening a worktree from the app still records the branch.
