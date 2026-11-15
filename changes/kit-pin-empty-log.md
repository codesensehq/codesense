---
type: fixed
---

**`kit.chat` no longer forces a layout read on an empty log.** `pinToBottom` skips following until the log has a message, so opening a chat before its thread loads costs no reflow ahead of first paint. Following is unchanged once there is a message.
