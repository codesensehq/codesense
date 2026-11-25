---
type: added
---

**The Inbox pane can search GIFs.** A page in the Inbox pane can call `gifSearch` to find GIFs with your configured provider, and each result carries a small still the app fetched for it, so the pane can show results without loading remote images itself. It needs `inbox:write`, works only in the Inbox pane, and returns nothing when the team's remote media is off.
