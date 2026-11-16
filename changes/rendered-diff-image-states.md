---
type: fixed
---

**A changed image's diff states are honest.** An image whose bytes were read still draws side by side when its text diff can't be read, instead of leaving Side by side pressed over a message that blamed the image. If the image's bytes couldn't be read either, it says the image couldn't be read; where nothing of the image was read at all, it says the diff's own error. The "Reading the image…" label stays readable while its placeholder pulses, and one status line announces reading the image and then why it won't draw.
