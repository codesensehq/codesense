---
type: added
---

**A successor session continues its predecessor's agent thread.** A thread is keyed by the saved agent (the id before `@`) and the story, so a session on a new revision of the same saved agent opens the same thread, appends to it and keeps its pins. Another story, or a session with no story, keeps its own thread.
