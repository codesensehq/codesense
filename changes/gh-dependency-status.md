---
type: changed
---

**Dependency status includes the GitHub CLI.** The app's dependency status now reports whether `gh` is installed and its version, next to git, found in the background after launch like the agent CLIs so startup never waits on it; Codex, OpenCode and Hermes also read as detecting, not as not installed, until that search finishes.
