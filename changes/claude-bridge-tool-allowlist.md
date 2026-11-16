---
type: added
---

**Claude agents take a bridge tool list.** `mcp.bridge_tools` now applies to Claude agents: each left-out CodeSense tool is denied by name, `signal_done`, `read_messages` and `reply` always stay, and the agent's server instructions leave out the tools it can't call.
