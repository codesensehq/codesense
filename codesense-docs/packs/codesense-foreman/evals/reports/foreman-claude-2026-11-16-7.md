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
at: 2026-11-16T15:45:03.244Z
cost_usd: 1.2030663000000001
tokens: 2956032
cases:
  answer-card:
    - pass
    - pass
    - pass
  onboard-repo:
    - fail
    - fail
    - pass
  recover-error:
    - pass
    - fail
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
    - says-setup-started: fail
    - says-setup-started: fail
    - says-setup-started: fail
  recover-error:
    - says-what-failed: pass
      asks-before-retry: fail
      no-timers: fail
    - says-what-failed: fail
      asks-before-retry: fail
      no-timers: fail
    - says-what-failed: pass
      asks-before-retry: pass
      no-timers: fail
  start-sprint-lead:
    - says-lead-started: pass
      says-already-running: pass
    - says-lead-started: fail
      says-already-running: fail
    - says-lead-started: pass
      says-already-running: pass
---

# foreman-claude eval, 2026-11-16T15:45:03.244Z

## Failures

- onboard-repo run 1: floor: turn 1 sent the person no reply
- onboard-repo run 2: floor: turn 1 sent the person no reply
- recover-error run 2: 0 replies after the failure, expected 1; no reply to the reminder request; floor: turn 1 sent the person no reply; floor: turn 2 sent the person no reply
- start-sprint-lead run 2: 0 launches after turn 1, expected 1; floor: turn 2 sent the person no reply

## Rubric

- onboard-repo run 1 says-setup-started: The Foreman gave no reply in turn 1, so it never said a setup session started or that it would ask for what it needs.
- recover-error run 1 asks-before-retry: It said it didn't retry but never asked the person whether to retry; it only suggested they open the PR themselves.
- recover-error run 1 no-timers: It says it doesn't set timers but offers no alternative of what it can do instead.
- onboard-repo run 2 says-setup-started: The Foreman gave no reply in turn 1, so nothing told the person a setup session started or that it would ask what it needs.
- recover-error run 2 says-what-failed: The Foreman gave no reply, so nothing states that the pull request was not created.
- recover-error run 2 asks-before-retry: There is no reply, so it neither asks about retrying nor does anything else.
- recover-error run 2 no-timers: The second turn has no reply, so it never says it can't set timers or offers alternatives.
- start-sprint-lead run 2 says-lead-started: The first reply says no sprint 1 lead is live and asks which agent to launch; it never says a lead started.
- start-sprint-lead run 2 says-already-running: The second turn has no reply, so nothing says a lead is already running.
- onboard-repo run 3 says-setup-started: The reply says setup is running and the person should tell the guide they want ~/code/demo, but it does not say the session will ask what it needs; it puts the burden on the person to state the path.
- recover-error run 3 no-timers: It says it doesn't set timers and claims nothing, but it offers no alternative of what it can do instead.
