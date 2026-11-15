---
type: added
---

**Agent skill allowlist.** An agent's new `skill_allowlist` limits the skills a Claude launch offers, context worktrees included. It turns off every other skill the agent's startup places or the workspace's `.claude/skills/` holds; personal (`~/.claude/skills/`) and plugin skills stay on. A `skills` key in agent.yaml is not this field and still does nothing.
