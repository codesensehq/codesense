---
type: added
---

**Pausing a team stops agent launches.** While a team's newest `team-control` record pauses it, every `open_workspace` call into that team, from an agent, an MCP session or a published dashboard, is refused with `refused: team paused` before anything is made. A resume record that names the pause lets launches through again, and your own launch sheet still launches.
