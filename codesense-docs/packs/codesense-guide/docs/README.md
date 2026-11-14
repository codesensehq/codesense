# CodeSense setup

The setup agent that opens on first launch. It checks this Mac, asks what you work on and does the setup for you one consent card at a time.

- `agents/guide-{claude,codex,opencode}/agent.yaml`: one agent per runtime. None names a model; the setup page passes it when it launches.
- `content/guide/PROMPT.md`: the short root prompt. `commands/codesense-setup.md`: the command, built into each runtime's own skill or command path.
- The tool list is per phase and written out in `scripts/guide-pack.node-test.mjs`.
