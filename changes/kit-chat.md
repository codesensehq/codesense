---
type: added
---

**One chat for dashboard pages.** The dashboard kit now has `kit.chat` (load `/kit/v1/chat.js` after the kit): `kit.chat.mount(el, { transport, reads, layout, cards, headerSlot, chips })` draws a chat with Queued and Delivered marks, inline needs-you cards with option buttons, and a log that opens at the newest message and follows new ones only while you are at the bottom. The marks rule and the card parser are also served as a DOM-free module at `/kit/v1/chat-core.js`. The app re-exports the same module with types from `src/features/inbox/lib/chat-core.ts`.
