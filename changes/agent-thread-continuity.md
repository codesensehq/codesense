---
type: added
---

**An agent thread is keyed by the saved agent, whatever its revision.** A thread is keyed by the saved agent (the id before `@`) and the story, so every caller, a session or a page or a person naming `agent@4`, reaches the same thread. A session on a new revision of the same saved agent therefore opens that thread, appends to it and keeps its pins. Another story, or a session with no story, keeps its own thread.
