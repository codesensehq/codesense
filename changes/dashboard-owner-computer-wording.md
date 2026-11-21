---
type: fixed
---

**Dashboards name the owner's computer off macOS.** On Linux and Windows, live dashboards in the app and new workspaces, mission-control and bug-triage dashboards say "computer" instead of "Mac" in their status line, offline and busy notes, waiting values and terminal notes. On macOS they still say "Mac", and so do hosted dashboards created before this change. Hosted pages read the word from a `codesense:owner-machine` meta through the new `CS.ownerMachine()` in `cs-live.js` 6.
