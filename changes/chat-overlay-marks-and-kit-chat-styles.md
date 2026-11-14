---
type: added
---

**The chat on a terminal tab shows Queued and Delivered.** What you send an agent from its overlay is marked Queued while the agent is busy and has not yet been told, and Delivered once it has, by the kit chat's shared rule. The kit chat also ships its own stylesheet (`/kit/v1/chat.css`, linked by `chat.js`, or off with `styles: false`), and two chats on one page no longer share element ids: the first keeps the plain ids, later ones carry `-2`, `-3`.
