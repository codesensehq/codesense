---
type: added
---

**A page reads an agent's whole thread.** `inbox({agentId, storyId, sessionId})` reads the messages of every session of a saved agent on a story, an ended predecessor's included, with `sessionId` as the seat whose concurrent sessions stay out; a page tests for it with `codesense.has("inboxThread")`.
