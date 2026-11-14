---
type: added
---

**probe_environment.** A new read-only MCP tool reports which agent CLIs, git and the GitHub CLI are installed, whether `gh` is signed in, whether a folder is a git repository and whether named environment variables are set in your login shell (zsh or bash; for another shell they read as unknown). It never returns a token or a variable's value, and it does not look inside Documents, Desktop, Downloads, cloud storage folders or an external volume unless you attached that folder, even through a link.
