---
type: added
---

**Each lead launch now starts a work item that its workers share, and sessions name who really launched them.** An agent launched by a person, the Foreman or a routine gets a new work item (`wi_…`). Any agent that session launches inherits it, a plain shell never gets one, and a restore keeps the one it had. The work item is written on the session record. A tab an agent opens with `open_terminal_tab` names that agent as its launcher, and a restored session keeps its original launcher and records `restoredBy`. Routine launches on another machine record `routine:<org>/<team>/<id>`; a `launchedBy` filter still matches sessions recorded under the older `routine <name>`.
