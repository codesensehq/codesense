---
type: fixed
---

**A running agent is no longer told its own session isn't running.** Sending, finishing, `who_am_i` and records now check the session registry and the terminal hosts when they're called, so a session that just started is accepted and a closed one stops being listed as running.
