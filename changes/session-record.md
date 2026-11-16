---
type: added
---

**An agent's session record for pages.** A dashboard can read one agent's model, tokens, cost, duration, changed files and story with `codesense.sessionRecord({handle})`, and re-read it on `onSessionRecordChanged`, which a page can limit to its own agent's session with the record's `sessionIds`. A model with no rate no longer blanks the cost: `costUsd` is the priced part and `unpricedModels` names the rest. The record refreshes on the agent's progress, done and exit and about 2 s after usage is stored for its session; commits have no event of their own. The figures are the ones `session_usage` and `story_changes` report for that session.
