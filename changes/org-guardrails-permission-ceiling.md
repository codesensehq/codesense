---
type: added
---

**Org guardrails deny permission rules for every agent in the org.** A root team's `config/guardrails.yml` can deny Claude, OpenCode and Hermes permission rules (`permissions.<cli>.deny`). The org's guardrails are the union of every root team's file, read from the org clone's committed upstream, so no team, private space, agent or worktree can allow them again. `agent_preview` lists the agent's rules they refuse under `manifest.guardrails`, a file that can't be read refuses the launch with its path, and a Codex launch gets a warning that Codex can't enforce them.
