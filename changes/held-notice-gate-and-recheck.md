---
type: fixed
---

**A held inbox notice says why, and a failed spend check no longer holds mail.** When an agent's "you have mail" notice is held for longer than a minute, the host logs the gate that holds it once, at info: a wake hold with its reason (or `undecided`), the agent lacking its CodeSense tools, or a spend refusal. A spend evaluation that fails now lets mail through with a warning, and is retried within a minute instead of waiting for the next event or midnight. A real cap refusal, and an agent the evaluation can't see, still hold mail.
