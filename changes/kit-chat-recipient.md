---
type: added
---

**`kit.chat` can send to another agent, with a control of the page's own in the composer.** A page's `target.recipient()` names who the next message goes to: Enter, Send, a page chip or `post` then sends straight to that agent instead of the chat's own peer, never starting it; a chip from the peer's Next line still answers the peer. The box clears only once the message is sent, shows it is busy until then, and a failed send keeps the text and says why. The person's message shows "To <name>" in its meta line, as real text a screen reader hears, and its text is left as typed. `layout.composerSlot` gives the page a place above the box for its own control (a "To" chip), mounted once and released on unmount, `layout.composer` can now name the input per recipient with `label`, and the mount's `repaint()` shows a change the page made. Pages that leave these unset are unchanged.
