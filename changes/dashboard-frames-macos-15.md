---
type: fixed
---

**Dashboard frames load on macOS 14 and 15.** Their `f-<id>.localhost` addresses didn't resolve there, so a frame showed "A server with the specified hostname could not be found". The app's web views now send `localhost` loads to the app's own local server, so the name is never looked up. Frames still need macOS 14 or later.
