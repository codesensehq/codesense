---
type: added
---

**A page can keep the chat's send state across a hide and a show.** `kit.chat.createSendState` makes the state (the messages with their marks, the outbox, the launch's timers and the cards answered from the page), and `mount` takes it as `send`: the mount attaches to it and detaches on unmount, and while no chat is mounted the state still hands a held message to a lead that joins. Without `send`, a mount makes its own state and ends it on unmount, as before.
