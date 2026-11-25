---
type: added
---

**You can send GIFs from the Inbox pane.** A page in the Inbox pane can call `gifSearch` to find GIFs with your configured provider. Each result carries a small still the app fetched for it, so the pane shows results without loading remote images itself. `gifPicked` tells the provider which GIF you picked. `sendAsHuman` and `replyAsHuman` take a `media` picture, and the text may be blank when one is attached. These work only in the Inbox pane and need `inbox:write`. Search returns nothing when the team's remote media is off, and a picture can't go to a role queue. An agent that reads the message gets `[GIF: <alt>]` or `[Image: <alt>]` after the text.
