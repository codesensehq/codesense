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
at: 2026-11-16T17:04:01.545Z
cost_usd: 2.6207420000000003
tokens: 3274667
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
      asks-before-retry: pass
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

# foreman-claude eval, 2026-11-16T17:04:01.545Z

## Rubric

- recover-error run 3 no-timers: It says it doesn't set timers and claims nothing was set, but it offers no alternative for reminding, only re-prompting the pending PR choice.
