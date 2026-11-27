---
type: security
---

**A page's records calls are checked against the collection they actually reach.** When a page frame lists, reads, searches or writes records, or opens a records view, the host now checks the scope of the collection it resolved against the frame's grant. A frame holding only private records access is refused a team collection rather than served it, even when the frame's scope changed after it was opened, as an embedded message's does once it is linked to its pane. Leaving a records subscription releases the view the frame already holds instead of preparing a new one.
