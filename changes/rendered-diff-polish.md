---
type: fixed
---

**Rendered diffs say what they can't draw.** An image side that won't decode, or an Excalidraw side that won't parse, now says so instead of showing a broken image or a blank canvas. An image that is still loading says "Reading the image…", and one that can't be drawn here keeps Side by side in the switch, disabled with its reason (over the size limit, a failed read, or a remote worktree). Each image side is captioned with its size in pixels and its file size, every surface uses the same line for an image's Source mode, and the mode switches are easier to read and show their keyboard focus.
