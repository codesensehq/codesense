---
type: added
---

**`kit.chat` can read a consent card line.** `cards: { consent: true }` reads the `card: <step> · <class> · <act>=<label> | …` line that ends a card's text into the card's buttons, its consent class in the header and `data-step`/`data-act` attributes, and hides the line; `core.parseCardLine`, `core.formatCardLine` and `core.CONSENT_CLASSES` (also exported from the overlay's `chat-core`) hold the one format. Off by default.
