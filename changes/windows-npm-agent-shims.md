---
type: fixed
---

**Claude and Codex installed with npm start on Windows.** A launched agent tab now runs what npm's `claude.cmd` or `codex.cmd` points to directly, without `cmd.exe`, so every argument arrives exactly as typed, `&`, `%` and quotes included; other batch files are still refused, and a saved Agent can no longer set `ComSpec` or `PATHEXT`.
