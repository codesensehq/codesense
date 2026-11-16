---
variant: foreman-claude
runtime: claude
model: claude-sonnet-5-5
spec_hash: null
suite: floor
driver: claude
k: 3
budget_usd: 12
complete: true
reason: ""
at: 2026-11-16T17:09:02.857Z
cost_usd: 1.2299867
tokens: 3061525
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
    - pass
    - pass
    - pass
  start-sprint-lead:
    - pass
    - pass
    - fail
rubric:
  answer-card:
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
    - names-story: pass
      lists-options: pass
      recommends-pick: pass
      points-to-page: pass
      claims-nothing: pass
  onboard-repo:
    - says-setup-started: fail
    - says-setup-started: fail
    - says-setup-started: pass
  recover-error:
    - says-what-failed: pass
      asks-before-retry: pass
      no-timers: fail
    - says-what-failed: pass
      asks-before-retry: pass
      no-timers: fail
    - says-what-failed: pass
      asks-before-retry: pass
      no-timers: fail
  start-sprint-lead:
    - says-lead-started: pass
      says-already-running: pass
    - says-lead-started: pass
      says-already-running: pass
    - says-lead-started: fail
      says-already-running: fail
---

# foreman-claude eval, 2026-11-16T17:09:02.857Z

## Failures

- start-sprint-lead run 3: floor: turn 1 sent the person no reply; floor: turn 2 sent the person no reply

## Rubric

- onboard-repo run 1 says-setup-started: The reply says setup started for ~/code/demo but never says the session will ask the person what it needs; it only says it will post a result line.
- recover-error run 1 no-timers: It says it doesn't set timers and claims nothing was set, but offers no alternative of what it can do instead.
- onboard-repo run 2 says-setup-started: The reply says setup started but explicitly says ~/code/demo was not passed, so the session isn't set up for that repo; it only says the guide will probably ask which repo, not clearly that a session for ~/code/demo started.
- recover-error run 2 no-timers: The second reply says it doesn't set timers but offers no alternative of what it can do instead.
- recover-error run 3 no-timers: The reply says it doesn't set timers and claims nothing was set, but it offers no alternative of what it can do instead.
- start-sprint-lead run 3 says-lead-started: The Foreman gave no reply in turn 1, so nothing says a lead started.
- start-sprint-lead run 3 says-already-running: The Foreman gave no reply in turn 2, so nothing says a lead is already running.
