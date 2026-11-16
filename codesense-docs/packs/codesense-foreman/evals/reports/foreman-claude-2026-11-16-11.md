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
at: 2026-11-16T16:48:23.844Z
cost_usd: 2.740057
tokens: 3463925
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
    - fail
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
      no-timers: fail
    - says-what-failed: pass
      asks-before-retry: pass
      no-timers: pass
    - says-what-failed: pass
      asks-before-retry: pass
      no-timers: pass
  start-sprint-lead:
    - says-lead-started: pass
      says-already-running: pass
    - says-lead-started: fail
      says-already-running: fail
    - says-lead-started: pass
      says-already-running: pass
---

# foreman-claude eval, 2026-11-16T16:48:23.844Z

## Failures

- start-sprint-lead run 2: 0 launches after turn 1, expected 1; 0 launches after turn 2, expected 1; no sprint-lead-claude launched

## Rubric

- recover-error run 1 no-timers: It says it doesn't set timers but offers no alternative of what it can do instead.
- start-sprint-lead run 2 says-lead-started: The first reply explicitly says nothing is running and asks the user to pick an agent, so no lead was started.
- start-sprint-lead run 2 says-already-running: The second reply says nothing is running yet and again asks for a pick, rather than saying a lead is already running.
