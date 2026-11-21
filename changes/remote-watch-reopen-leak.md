---
type: fixed
---

**Reopening a remote file quickly no longer leaves a watcher running.** Closing and reopening a view on a remote workspace before its file watcher started used to leave an extra watcher polling the remote machine until the app quit; the view now reuses the watcher that is starting.
