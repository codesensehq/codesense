---
type: fixed
---

**New sessions show up while a large content folder refreshes.** Adding files to a context with many uncommitted files used to stall the session list for minutes: a new agent was missing from `list_sessions` and its CodeSense tools said it wasn't running. The file tree now refreshes beside the session list and reads git status once per refresh, not once per folder. A file you move without staging it now shows as added rather than renamed.
