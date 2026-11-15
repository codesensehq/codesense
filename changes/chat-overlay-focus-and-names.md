---
type: fixed
---

**The agent chat overlay keeps keyboard focus after a pin replace.** After replacing a pin with the keyboard, its Undo, or Esc in the chooser, focus now lands back on the message's Unpin or Pin… instead of the page. In Chromium, an older message's scrolling code block or table no longer adds its own Tab stop to the thread, in the overlay or in a page's `kit.chat`. A message that follows another from the same sender is read with its sender and time, and the "Pinned by" tag is no smaller than the other small text.
