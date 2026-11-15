---
type: added
---

**Pages can hear a Claude agent's reply as it is written.** `codesense.onSessionText(sessionId, cb)` streams a local Claude session's assistant prose to a page as each block lands, then exactly one final message per turn, without waiting for the conversation capture. Tool calls, tool output and the model's thinking are never sent, and each line is redacted as the stored conversation is. A page needs the `sessions:read` grant and hears only sessions of its own team.
