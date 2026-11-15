# CodeSense setup

The setup agent that opens on first launch. It checks this Mac, asks what you work on and does the setup for you one consent card at a time.

- `agents/guide-{claude,codex,opencode}/agent.yaml`: one agent per runtime. None names a model; the setup page passes it when it launches.
- `commands/codesense-setup.md`: the command, with the guide's root rules at its top, built into each runtime's own skill or command path. A team-workspace launch reads it from the docs team's live copy. `content/guide/handoff.md`: the handoff note.
- The tool list is per phase and written out in `scripts/guide-pack.node-test.mjs`, and again, as a launch resolves it with CodeSense's always-on tools and each runtime's denies, in `src-tauri/src/agents/resolve/guide_agent_tests.rs`.
