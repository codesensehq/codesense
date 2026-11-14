---
type: added
---

**`kit.chat` can show each sender's avatar, with one meta line per run.** The new `faces` option (`true`, or `(row) => { src | face, name, label }`) puts the sender's avatar, through `kit.avatar` or an image, at the start of a lead's or another agent's run of messages, and a run from one sender shares one meta line. Off by default; unset, the thread is unchanged.
