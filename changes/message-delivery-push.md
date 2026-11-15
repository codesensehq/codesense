---
type: added
---

**Pages see each sent message's delivery pushed.** A message a page sends an agent with `sendAsHuman` gets a row on the new `messageDelivery` live topic, keyed by its message id: `queued`, then `delivered` once the agent is told about it (its inbox notice was confirmed). Delivered means told, not read. Inbox rows carry `toldAtMs`.
