---
type: added
---

**Replace a pin at the cap in one step.** A page can pin a message in place of a pin it names with the `replacePin` verb, even when a thread already shows 3 pins; the new pin takes the old one's place, and `restorePin` with `replacing` undoes it, bringing the old pin back as it was. A replace of a pin that left in the meantime is refused and changes nothing. An agent's own pin tool still refuses a fourth pin.
