---
type: security
---

**A page's records subscription names its collection as a string.** A page that subscribed to, paged or left the records topic with a collection that wasn't a string, such as `["care"]` or `7`, was first checked as if it named your notes; it's now refused with "collection must be a string". Leaving the collection out means your notes.
