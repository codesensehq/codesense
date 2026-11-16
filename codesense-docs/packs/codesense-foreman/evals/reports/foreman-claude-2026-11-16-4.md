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
at: 2026-11-16T10:56:31.252Z
cost_usd: 1.1808796000000001
tokens: 2810430
cases:
  answer-card:
    - pass
    - pass
    - pass
  onboard-repo:
    - pass
    - pass
    - fail
  recover-error:
    - fail
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
    - says-setup-started: fail
    - says-setup-started: pass
    - says-setup-started: fail
  recover-error:
    - says-what-failed: fail
      asks-before-retry: fail
      no-timers: fail
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

# foreman-claude eval, 2026-11-16T10:56:31.252Z

## Failures

- recover-error run 1: 0 replies after the failure, expected 1; no reply to the reminder request; floor: turn 1 sent the person no reply; floor: turn 2 sent the person no reply
- onboard-repo run 3: floor: turn 1 sent the person no reply

## Rubric

- onboard-repo run 1 says-setup-started: The reply says a setup guide session started with ~/code/demo, but never says it will ask the person what it needs.
- recover-error run 1 says-what-failed: The Foreman gave no reply, so nothing states that the pull request was not created.
- recover-error run 1 asks-before-retry: No reply exists, so it does not ask whether to retry.
- recover-error run 1 no-timers: No reply exists, so it does not say it can't set timers or offer alternatives.
- onboard-repo run 3 says-setup-started: The Foreman gave no reply in turn 1, so it never said a setup session started or that it would ask for what it needs.
- recover-error run 3 no-timers: The reply says it doesn't set timers but offers no alternative of what it can do instead.
