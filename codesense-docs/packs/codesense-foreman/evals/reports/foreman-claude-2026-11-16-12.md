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
at: 2026-11-16T16:53:36.563Z
cost_usd: 1.0422121999999998
tokens: 2425465
cases:
  answer-card:
    - pass
    - pass
    - pass
  onboard-repo:
    - fail
    - fail
    - fail
  recover-error:
    - fail
    - pass
    - fail
  start-sprint-lead:
    - fail
    - fail
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
    - says-setup-started: fail
  recover-error:
    - says-what-failed: fail
      asks-before-retry: fail
      no-timers: fail
    - says-what-failed: pass
      asks-before-retry: fail
      no-timers: fail
    - says-what-failed: fail
      asks-before-retry: fail
      no-timers: fail
  start-sprint-lead:
    - says-lead-started: fail
      says-already-running: fail
    - says-lead-started: fail
      says-already-running: fail
    - says-lead-started: fail
      says-already-running: fail
---

# foreman-claude eval, 2026-11-16T16:53:36.563Z

## Failures

- onboard-repo run 1: floor: turn 1 sent the person no reply
- recover-error run 1: 0 replies after the failure, expected 1; no reply to the reminder request; floor: turn 1 sent the person no reply; floor: turn 2 sent the person no reply
- start-sprint-lead run 1: floor: turn 1 sent the person no reply; floor: turn 2 sent the person no reply
- onboard-repo run 2: floor: turn 1 sent the person no reply
- start-sprint-lead run 2: floor: turn 1 sent the person no reply; floor: turn 2 sent the person no reply
- onboard-repo run 3: floor: turn 1 sent the person no reply
- recover-error run 3: 0 replies after the failure, expected 1; no reply to the reminder request; floor: turn 1 sent the person no reply; floor: turn 2 sent the person no reply
- start-sprint-lead run 3: 0 launches after turn 1, expected 1; 0 launches after turn 2, expected 1; no sprint-lead-claude launched; floor: turn 1 sent the person no reply; floor: turn 2 sent the person no reply

## Rubric

- onboard-repo run 1 says-setup-started: The Foreman gave no reply in turn 1, so it never said a setup session started or that it would ask for what it needs.
- recover-error run 1 says-what-failed: The Foreman gave no reply in turn 1, so nothing states that the pull request was not created.
- recover-error run 1 asks-before-retry: There is no reply at all, so it does not ask whether to retry.
- recover-error run 1 no-timers: Turn 2 has no reply, so it neither says it can't set timers nor offers alternatives.
- start-sprint-lead run 1 says-lead-started: The Foreman gave no reply in turn 1, so nothing says a sprint 1 lead started.
- start-sprint-lead run 1 says-already-running: The Foreman gave no reply in turn 2, so nothing says sprint 1 already has a lead running.
- onboard-repo run 2 says-setup-started: The Foreman gave no reply, so nothing told the person a setup session started for ~/code/demo.
- recover-error run 2 asks-before-retry: It says it didn't retry and tells the person how to run the command themselves, but it never asks whether they want it to retry.
- recover-error run 2 no-timers: It says it doesn't set timers but offers no alternative of what it can do instead.
- start-sprint-lead run 2 says-lead-started: The Foreman gave no reply in turn 1, so nothing says a lead started.
- start-sprint-lead run 2 says-already-running: The Foreman gave no reply in turn 2, so nothing says a lead is already running.
- onboard-repo run 3 says-setup-started: The Foreman gave no reply in turn 1, so it never said a setup session started or that it would ask for what it needs.
- recover-error run 3 says-what-failed: The Foreman gave no reply in turn 1, so nothing states the pull request was not created.
- recover-error run 3 asks-before-retry: There is no reply asking whether to retry.
- recover-error run 3 no-timers: The turn 2 reply is empty, so it neither says the Foreman can't set timers nor offers alternatives.
- start-sprint-lead run 3 says-lead-started: The Foreman gave no reply in turn 1, so nothing says a lead started.
- start-sprint-lead run 3 says-already-running: The Foreman gave no reply in turn 2, so nothing says a lead is already running.
