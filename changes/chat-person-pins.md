---
type: added
---

**Pin any chat message yourself, with Undo.** In an agent's chat overlay, in the Inbox (where a conversation is one agent's thread) and on pages that mount the kit's chat (`onPin`), each message has a Pin in its action row; an HTML message has it in its title bar. Your pin previews the message (a quote, or the page's name) next to the agent's pins. The 3-pin cap is shared with the agent: at the cap every Pin is dimmed and says whose pins fill the list, and nothing is replaced. Unpinning offers Undo, which puts the pin back as it was through the new `restorePin` verb (or the `pin` tool's `restore` flag).
