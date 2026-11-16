---
type: fixed
---

**A visible Inbox stops re-reading while agents work.** The Inbox pane used to run a full read about once a second whenever any session changed, even with no new mail. It now refreshes on inbox changes only and redraws presence from session changes alone, and Notes stops its timer while hidden. Inbox change notices now name the teams they concern, and `onInboxChanged` no longer fires on session changes.

`onAgentsChanged` no longer follows inbox pings: a page that shows both agents and mail registers `onAgentsChanged` and `onInboxChanged`.
