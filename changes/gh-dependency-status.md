---
type: changed
---

**Dependency status includes the GitHub CLI.** The app's dependency status now reports whether `gh` is installed and its version, next to git. It is found in the background after launch, the way the agent CLIs are, so startup never waits on it.

**Agent CLIs read as detecting until they are found.** Codex, OpenCode and Hermes no longer read as not installed while the app is still looking for them after a team opens.
