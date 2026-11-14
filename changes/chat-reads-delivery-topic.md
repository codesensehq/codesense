---
type: changed
---

**Queued and Delivered follow each message's own delivery.** The chat overlay and pages that mount the kit's chat (through `reads.delivery`) now mark a message you sent from its own `messageDelivery` row, which turns delivered when the agent is told or reads it. A host without the topic keeps the marks as before.
