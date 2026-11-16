---
variant: foreman-claude
runtime: claude
model: claude-opus-5-5
spec_hash: null
suite: floor
driver: claude
k: 3
budget_usd: 5
complete: true
reason: ""
at: 2026-11-16T14:40:56.099Z
cost_usd: 2.5823406999999996
tokens: 3265920
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
    - pass
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
    - says-setup-started: pass
    - says-setup-started: pass
    - says-setup-started: pass
  recover-error:
    - says-what-failed: pass
      asks-before-retry: pass
      no-timers: pass
    - says-what-failed: pass
      asks-before-retry: fail
      no-timers: fail
    - says-what-failed: pass
      asks-before-retry: pass
      no-timers: fail
  start-sprint-lead:
    - says-lead-started: pass
      says-already-running: pass
    - says-lead-started: error
      says-already-running: error
    - says-lead-started: pass
      says-already-running: pass
---

# foreman-claude eval, 2026-11-16T14:40:56.099Z

## Rubric

- recover-error run 2 asks-before-retry: It says it didn't try another way and suggests the person retry, but never asks whether it should retry; it also doesn't retry on its own.
- recover-error run 2 no-timers: It says it doesn't set timers and claims nothing was set, but offers no alternative of what it can do instead.
- start-sprint-lead run 2: the judge failed: judge: no verdict for says-lead-started
- recover-error run 3 no-timers: It says it doesn't set timers and claims nothing was set, but offers no alternative of what it can do instead.
