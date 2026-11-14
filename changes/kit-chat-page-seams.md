---
type: added
---

**`kit.chat` takes a page's own words and rules.** `mount` accepts `copy` (a page's words over the chat's), and a `target` can set which row is live (`pick`), which handles count as the peer's side (`handles`), which mailboxes the thread reads (`sources`, each read on its own, with unread and stale rows and Retry), and how a launch binds (`bindLaunched`, `keepUnsent`). The handle also gains `post`, `threadFailed` and `threadSettled`. Without these options the chat behaves as before.
