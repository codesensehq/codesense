---
type: added
---

**`list_sessions` shows a held inbox notice.** When a session's "you have mail" notice has been held back from its waiter for more than one notice cycle, its row reads `mailNotice: "held"` and carries `held: {gate, sinceMs}`: what holds it (a wake hold with its reason, an undecided hold, or the agent lacking its CodeSense tools) and since when. The row returns to `pending` or `told` once the notice moves.
