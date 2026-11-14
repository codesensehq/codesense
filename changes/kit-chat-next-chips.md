---
type: added
---

**`kit.chat` can turn an agent's trailing `Next:` line into suggestion chips, with an edit pencil.** `core.parseNext` (also exported from the overlay's `chat-core`) reads the line, the new `next` option shows its chips after the agent's newest message and leaves the line out of the text, and a chip's pencil puts its text in the composer to edit before sending (`next: { edit: true }`, or `edit: true` on a `chips` entry). All off by default.
