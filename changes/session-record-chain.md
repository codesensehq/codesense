---
type: added
---

**A session record sums the handoff chain.** When a saved agent handed a story off from earlier sessions, `codesense.sessionRecord({handle})` adds their tokens, cost, duration and files into the record and lists the chain's session ids in `chain`, so a page can show "N sessions".
