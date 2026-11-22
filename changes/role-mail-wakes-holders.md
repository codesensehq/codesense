---
type: fixed
---

**Role mail wakes the agents holding the role.** A message sent to a role now offers each live session that holds the role an inbox notice, as a direct message does, so an idle holder starts a turn instead of leaving the delivery pending. The notice names the role and tells the agent to call `claim_role_messages` for it, and each role message is announced once.
