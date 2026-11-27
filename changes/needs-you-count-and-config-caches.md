---
type: changed
---

**Badges count without reading the inbox.** A live page asks `inbox({kind: "needs-you", countOnly: true})` for how many questions wait for you and gets `{count}` from the live inbox, with no messages read. Its `prefs()` reads come from the live preferences instead of the app-state file, and the app keeps the list of synced teams and each team's role settings and media policy between reads, reading them again only when they change.
