---
type: added
---

**The live hub publishes one needs-you set on a new `needsYou` topic.** It holds every question to you, permission ask, merge card, and agent that is capped at its spend cap or has failed; FYI messages never count. Each row names its kind, session, org, team and work item, and a team's view holds only that team's items. The set is recomputed when sessions, the Inbox or spend change, with no polling, and an unchanged set sends nothing.
