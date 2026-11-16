---
type: fixed
---

**A page that vendors `kit.chat`'s modules into one script can load it again.** Two of the chat's modules each declared a constant with the same name, so a host that joins the modules into one script scope stopped at a duplicate declaration and showed no chat. The pin chooser's icon constant has its own name now, and a test keeps every top-level name in the chat's modules unique.
