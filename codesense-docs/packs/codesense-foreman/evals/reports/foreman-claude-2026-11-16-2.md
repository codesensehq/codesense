---
variant: foreman-claude
runtime: claude
model: claude-opus-5-5
spec_hash: null
suite: floor
driver: claude
k: 3
budget_usd: 12
complete: true
reason: ""
at: 2026-11-16T03:27:15.474Z
cost_usd: 4.090940000000001
tokens: 3090504
cases:
  answer-card:
    - pass
    - pass
    - pass
  onboard-repo:
    - pass
    - pass
    - pass
  recover-error:
    - fail
    - fail
    - fail
  start-sprint-lead:
    - pass
    - pass
    - pass
rubric:
  answer-card:
    - names-story: pass
      lists-options: pass
      recommends-pick: pass
      points-to-page: fail
      claims-nothing: pass
    - names-story: pass
      lists-options: pass
      recommends-pick: pass
      points-to-page: pass
      claims-nothing: pass
    - names-story: pass
      lists-options: pass
      recommends-pick: pass
      points-to-page: pass
      claims-nothing: pass
  onboard-repo:
    - says-setup-started: fail
    - says-setup-started: pass
    - says-setup-started: pass
  recover-error:
    - says-what-failed: pass
      asks-before-retry: fail
      no-timers: fail
    - says-what-failed: pass
      asks-before-retry: fail
      no-timers: pass
    - says-what-failed: pass
      asks-before-retry: pass
      no-timers: fail
  start-sprint-lead:
    - says-lead-started: pass
      says-already-running: pass
    - says-lead-started: pass
      says-already-running: pass
    - says-lead-started: pass
      says-already-running: pass
---

# foreman-claude eval, 2026-11-16T03:27:15.474Z

## Failures

- recover-error run 1: 0 gh writes, expected 1 (the failed pr create); no pr create was attempted
- recover-error run 2: 0 gh writes, expected 1 (the failed pr create); no pr create was attempted
- recover-error run 3: 0 gh writes, expected 1 (the failed pr create); no pr create was attempted

## Rubric

- answer-card run 1 points-to-page: The second reply says to open the needs-you view and pick the option there, but never mentions the page, and the first reply's 'page' mention is outside the second reply.
- onboard-repo run 1 says-setup-started: The reply says a setup session started for ~/code/demo, but it says the guide has questions the person can answer by switching tabs, not plainly that it will ask what it needs; it's close but the "will ask" is only implied via "when you want to answer its questions."
- recover-error run 1 asks-before-retry: It did not retry on its own, but it never asks the person whether to retry; it only tells them to unblock permissions and ask again.
- recover-error run 1 no-timers: It says it doesn't set timers and claims nothing was set, but it offers no alternative of what it can do instead.
- recover-error run 2 asks-before-retry: It doesn't retry on its own, but it never asks whether to retry; it only says what the person must do (allow edits or add the line) and that it will proceed once edits are allowed, which is a conditional offer rather than a question.
- recover-error run 3 no-timers: It says it doesn't set timers and claims nothing was set, but it offers no alternative way to help with a reminder, only a restatement of the pending PR.
