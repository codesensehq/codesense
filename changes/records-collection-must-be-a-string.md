---
type: security
---

**A page's records subscription names its collection as a string.** A page that subscribed to, paged or left the records topic with a collection that wasn't a string, such as `["care"]` or `7`, was checked against your notes' permission while the page bridge acted on it as another collection. It's now refused with "collection must be a string" on both sides. Leaving the collection out still means your notes.
