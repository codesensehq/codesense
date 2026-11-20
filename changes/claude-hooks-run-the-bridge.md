---
type: changed
---

**Claude's hooks run the bridge.** The status hook and the secret-file guard are now `codesense-bridge hook` subcommands, written in the form each host runs (PowerShell on Windows, which needs Claude Code 2.1.295 or newer), so they need no bash, curl or Perl; settings an earlier CodeSense wrote are updated in place.
