---
type: fixed
---

**Linux terminals no longer inherit the app's WebKit default.** Terminal shells, agents, routine commands and the custom external terminal and editor started from the app on Linux no longer see the `WEBKIT_DISABLE_DMABUF_RENDERER=1` the app sets for its own window, so GTK apps launched from them keep DMABUF rendering; a value you set yourself is still passed on. Files and links opened in other apps are unchanged.
